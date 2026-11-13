import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { resolveKey } from '@seamnex/domain';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { METRICS } from '../../common/metrics/metrics';
import type { Metrics } from '../../common/metrics/metrics';
import { DockerEngineClient } from '../../common/docker/docker.client';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import {
  INTEGRATION_SERVICE,
  type IntegrationService,
} from '../m07-integration/integration.contract';
import {
  acquireLoginLock,
  dropSubjectSessions,
  readCachedSession,
  relayTtlSeconds,
  writeCachedSession,
} from './relay-cache';
import { bareHost, ensureInstanceJoined, internalOriginFor, publicOriginFor } from './relay-origin';
import { loginAdapterFor } from './login-adapter';
import { PRODUCT_ACCOUNT_SERVICE } from './relay.contract';
import type {
  ProductAccountService,
  ProductAccountView,
  RelayAccountState,
  RelayAttemptInput,
  RelayFailure,
  RelayOutcome,
  SignInRelay,
} from './relay.contract';

/** The route shape the relay needs, and nothing else. */
type RelayTarget = {
  readonly authMode: 'native' | 'fa_header' | 'fa_delegated' | 'fa_gate';
  readonly slug: string;
  readonly entryKey: string;
  readonly payload: Record<string, unknown>;
  readonly productTtlSeconds: number | null;
};

/**
 * How many consecutive `credential_rejected` outcomes a mapping may produce before the relay stops
 * trying and the rotation pass re-passwords it.
 *
 * The product locks an account after 20 failed logins for 30 minutes. A user who launches three
 * times while the credential is broken has not earned a lockout, and the fourth launch is the one
 * that would have started the spiral.
 */
const CREDENTIAL_FAILURE_LIMIT = 3;

/**
 * The ceiling on what a launch spends making a mapping exist.
 *
 * Ten seconds is where a person concludes the tab is broken rather than slow, and a cold provision
 * is a few hundred milliseconds when the product is up — so this only decides how long a
 * pathological pass keeps the browser blank before the fallback. The work is not cancelled with it:
 * the mapping it writes is what the next launch wants.
 */
const PROVISION_ON_LAUNCH_DEADLINE_MS = 10_000;

/**
 * How long one (instance, subject) waits before a launch asks again.
 *
 * A product that refuses provisioning refuses it just as firmly on the second tab, and each attempt
 * costs the product's administrator credential a failed call. The sweep owns the retry policy; this
 * window only stops a person's double-click from becoming a second pass.
 */
const PROVISION_REQUEST_WINDOW_MS = 60_000;

/**
 * ADR-BE-22 — the sign-in relay.
 *
 * The launch hop asks this service to sign one subject in, and accepts three answers: it happened,
 * it was reused, or it did not happen and the browser should see the product's login form. There is
 * no fourth answer, because a launch that fails loudly is worse than today's behaviour.
 *
 * Deliberate omissions:
 *
 *   * **No retry.** Every failure returns immediately and is recorded. The product locks an account
 *     after 20 failed logins for 30 minutes; an over-eager retry would turn a transient defect into
 *     a person who cannot sign in.
 *   * **No shared credential.** The mapping is looked up per (instance, subject). There is no
 *     fallback to a service account, because that would make the product's audit log fiction.
 *   * **No claim of SSO.** The audit action, the check type and the outcome word are all `relay`,
 *     never `sso`. The D9 class stays `fa_gate` and the tile keeps saying "Sign-in required".
 */
@Injectable()
export class RelaySignInService implements SignInRelay {
  private readonly logger = new Logger('m24-sign-in-relay');
  /** Networks this process has already attached to, and when; a Docker round trip per launch is waste. */
  private readonly joined = new Map<string, number>();
  /** When a launch last asked for this pair's mapping, so a double-click is not a second pass. */
  private readonly provisionRequestedAt = new Map<string, number>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(INTEGRATION_SERVICE) private readonly integration: IntegrationService,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
    /**
     * ADR-BE-22: the per-user accounts this service signs in as, so a launch that finds no mapping
     * can ask for one instead of waiting for the sweep. Optional because the launch hop must stay
     * mountable without the provisioning role: a graph without it behaves exactly as before.
     */
    @Optional()
    @Inject(PRODUCT_ACCOUNT_SERVICE)
    private readonly accounts?: ProductAccountService,
  ) {}

  async attempt(input: RelayAttemptInput): Promise<RelayOutcome> {
    if (!this.config.SEAMNEX_RELAY_ENABLED) return { kind: 'skipped', reason: 'disabled' };

    /*
     * The host arrives from the edge, which forwards the browser's `Host` verbatim — and a browser
     * includes a non-default port (`openproject.localhost:8020`). `instance_route.host` never carries
     * one, so comparing the raw value made every launch skip as `not_gated`: the relay would have
     * done nothing at all on the dev stack, silently, which is indistinguishable from "no mapping".
     */
    const routeHost = bareHost(input.routeHost);
    const target = await this.targetOf(input.instanceId, routeHost);
    if (target === null || !this.eligible(target)) {
      // Expected for every product the allow-list does not name, so this is not a warning — but it
      // must be readable, because "the relay did nothing" and "the relay is not configured" look
      // identical from the browser and the difference cost a whole verification pass (ADR-BE-22).
      this.logger.debug(
        {
          instanceId: input.instanceId,
          routeHost,
          entryKey: target?.entryKey ?? null,
          authMode: target?.authMode ?? null,
        },
        'relay declined the launch: not a gated, allow-listed entry',
      );
      return { kind: 'skipped', reason: 'not_gated' };
    }

    /*
     * Consent is not ability. The allow-list says an operator wants this entry relayed; the adapter
     * registry says the platform can drive its form. An allow-listed entry with no adapter is the
     * configuration mistake worth naming, and it is a skip rather than a failure: the launch still
     * works, the product's own page answers, and nothing was planted.
     */
    const adapter = loginAdapterFor(target.entryKey);
    if (adapter === null) {
      this.logger.warn(
        { instanceId: input.instanceId, routeHost, entryKey: target.entryKey },
        'relay declined the launch: the entry is allow-listed but no login adapter is registered',
      );
      return { kind: 'skipped', reason: 'no_adapter' };
    }

    let account = await this.accountOf(input);
    if (account === null) {
      /*
       * The first click after a deployment. Provisioning is a cadence, not an event, so a person
       * who opened the product before the next sweep had nothing to be signed in as — and the
       * interval, not the product, was what they were waiting for. Ask for this one subject now,
       * bounded, and fall back to the product's form if it does not land in time.
       */
      account = await this.provisionOnMiss(input, target);
    }
    if (account === null) {
      // Allow-listed and gated, but nothing provisioned for this subject: the sweep has not run, the
      // admin token is missing, or access was granted while the mapping is pending. The launch still
      // works; the operator is the one who needs to see it.
      this.logger.log(
        { instanceId: input.instanceId, entryKey: target.entryKey, subject: input.subjectIdpId },
        'relay has no mapping for this subject; the launch falls back to the product login form',
      );
      return { kind: 'skipped', reason: 'no_mapping' };
    }
    if (account.state !== 'active') {
      // Three reasons, not one: a pending provisioning, a credential the product rejects and a
      // deliberate disable need three different operator responses, and the ADR asks for the
      // breakdown.
      return this.fail(
        input,
        target,
        account,
        stateReason(account.state),
        `the account is ${account.state}`,
      );
    }

    const origin = internalOriginFor(target.slug, target.payload);
    if (origin === null) {
      return this.fail(
        input,
        target,
        account,
        'product_unavailable',
        'the instance declares no port',
      );
    }
    const publicOrigin = publicOriginFor(this.config, routeHost);
    await ensureInstanceJoined(this.docker, this.config, this.logger, this.joined, target.slug);

    // ---- Reuse, after verifying it still works ------------------------------------------------
    const cached = await readCachedSession(this.redis, input.instanceId, input.subjectIdpId);
    if (cached !== null) {
      const verified = await adapter.verify(
        { origin, publicOrigin, cookies: cached.cookies, username: account.login },
        { timeoutMs: this.config.SEAMNEX_RELAY_HTTP_TIMEOUT_MS },
      );
      if (verified.ok) {
        await this.recordReuse(input, target);
        return { kind: 'reused', cookies: verified.cookies };
      }
      // A stale cache is not a failure of the launch: drop it and sign in again below.
      await dropSubjectSessions(this.redis, input.subjectIdpId, input.instanceId);
    }

    // ---- Single flight ------------------------------------------------------------------------
    const release = await acquireLoginLock(
      this.redis,
      input.instanceId,
      input.subjectIdpId,
      this.config.SEAMNEX_RELAY_LOCK_SECONDS * 1_000,
    );
    if (release === null) {
      this.logger.debug(
        { instanceId: input.instanceId, subject: input.subjectIdpId },
        'relay declined the launch: another tab holds the sign-in lock',
      );
      return { kind: 'skipped', reason: 'in_flight' };
    }

    try {
      /*
       * The mapping's own secret, named as such. `open` writes the `secret.read` row that is the
       * record of every relayed sign-in, and refuses an id that belongs to another scope or another
       * mapping — a `secret_ref` that drifted onto an instance secret would otherwise be submitted
       * as this person's password.
       */
      const credential = await this.secrets
        .open(account.secretRef, `relay sign-in for ${input.subjectIdpId} on ${input.instanceId}`, {
          scope: 'product_account',
          ownerId: account.id,
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `the relay could not open the product credential for ${input.subjectIdpId}: ${messageOf(error)}`,
          );
          return null;
        });
      if (credential === null) {
        return await this.fail(
          input,
          target,
          account,
          'credential_unavailable',
          'the credential is unreadable',
        );
      }

      const result = await adapter.signIn(
        { origin, publicOrigin, username: account.login, credential },
        { timeoutMs: this.config.SEAMNEX_RELAY_HTTP_TIMEOUT_MS },
      );

      if (!result.ok) {
        return await this.fail(input, target, account, result.reason, result.detail);
      }

      await writeCachedSession(
        this.redis,
        input.instanceId,
        input.subjectIdpId,
        result.cookies,
        relayTtlSeconds(target.productTtlSeconds, this.config.SEAMNEX_RELAY_SESSION_TTL_SECONDS),
      );
      // The credential works, so the breaker is closed again.
      await this.clearCredentialFailures(account.id);
      await this.recordOutcome(input, target, 'relay.signin.relayed', {
        outcome: 'relayed',
        login: account.login,
      });
      await this.recordCheck(
        input.instanceId,
        true,
        `the product accepted a relayed sign-in as ${account.login}`,
      );
      return { kind: 'relayed', cookies: result.cookies };
    } finally {
      await release();
    }
  }

  async invalidate(input: { subjectIdpId: string; instanceId?: string }): Promise<void> {
    await dropSubjectSessions(this.redis, input.subjectIdpId, input.instanceId);
    this.logger.log({ subjectIdpId: input.subjectIdpId }, 'relay sessions dropped');
  }

  /**
   * What the launch card may say about this person on this instance.
   *
   * Three answers, and the distinction is the point: a fresh install used to render "credential
   * outside platform" beside a product it was about to sign into, because nothing on the portal side
   * could ask whether a mapping existed. `preparing` is the honest word for "the platform intends
   * to sign you in and has not finished"; the reason behind an `unavailable` stays in the audit
   * chain, where an operator reads it, rather than in a card an end user cannot act on.
   *
   * Three reads — route, target, mapping — and never the credential: `state` is all a card needs.
   * The readiness column comes along with the route, because "no mapping yet" is only `preparing`
   * for a product that can accept one.
   */
  async accountState(input: {
    instanceId: string;
    subjectIdpId: string;
  }): Promise<RelayAccountState> {
    if (!this.config.SEAMNEX_RELAY_ENABLED) return 'unavailable';

    // A route is what makes an entry launchable at all; without one there is nothing to state.
    const route = await this.pool.query<{ host: string; state: string }>(
      `SELECT r.host, i.state
         FROM instance_route r
         JOIN instance i ON i.id = r.instance_id
        WHERE r.instance_id = $1
        ORDER BY r.host
        LIMIT 1`,
      [input.instanceId],
    );
    const found = route.rows[0];
    if (found === undefined) return 'unavailable';

    const target = await this.targetOf(input.instanceId, found.host);
    if (target === null || !this.eligible(target)) return 'unavailable';

    const result = await this.pool.query<{ state: ProductAccountView['state'] }>(
      `SELECT state FROM product_account WHERE instance_id = $1 AND subject_idp_id = $2`,
      [input.instanceId, input.subjectIdpId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      /*
       * No mapping yet. `preparing` promises that a pass will make one, so it must not be said when
       * no pass can: an allow-listed entry with no login adapter is the hand-provisioned case, and a
       * product that is not up is the case the provisioning query itself refuses (it selects only
       * `ready` and `degraded`). Saying "being prepared" there would never become true.
       */
      if (loginAdapterFor(target.entryKey) === null) return 'unavailable';
      return found.state === 'ready' || found.state === 'degraded' ? 'preparing' : 'unavailable';
    }
    if (row.state === 'active') return 'ready';
    return row.state === 'pending' ? 'preparing' : 'unavailable';
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Resolves the route the ticket was redeemed on. The host check is not redundant with
   * `redeem()`: this service is also reachable from the scheduler, and a target resolved for the
   * wrong host would sign the user into a product they did not open.
   */
  private async targetOf(instanceId: string, routeHost: string): Promise<RelayTarget | null> {
    const result = await this.pool.query<{
      auth_mode: RelayTarget['authMode'];
      slug: string;
      entry_key: string;
      payload: Record<string, unknown>;
      session_max_minutes: number | null;
    }>(
      `SELECT r.auth_mode, i.slug, i.entry_key, i.payload, im.session_max_minutes
         FROM instance_route r
         JOIN instance i ON i.id = r.instance_id
         LEFT JOIN integration_metadata im ON im.entry_key = i.entry_key
        WHERE r.instance_id = $1 AND lower(r.host) = lower($2) AND i.deleted_at IS NULL`,
      [instanceId, routeHost],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      authMode: row.auth_mode,
      slug: row.slug,
      entryKey: row.entry_key,
      payload: row.payload ?? {},
      productTtlSeconds:
        row.session_max_minutes === null ? null : Number(row.session_max_minutes) * 60,
    };
  }

  /**
   * Only a proxy gate on an allow-listed catalog entry. `fa_header` needs no login, and a `native`
   * entry signs in at the product's own IdP — relaying either would be a second, weaker path beside
   * a working one.
   */
  private eligible(target: RelayTarget): boolean {
    if (target.authMode !== 'fa_gate') return false;
    /*
     * Compared by *identity*, not by string. An environment file may still carry the catalogue's
     * legacy grammar (`D9`) while a deployed instance carries the composed key (`D09-01`); comparing
     * the raw strings matched nothing, so every launch skipped as `not_gated` and the relay never ran
     * — silently, which is the exact failure mode this service was supposed to make impossible.
     *
     * The comparison stays exact after resolving: `D09-01` does not admit `D09-02`, so one allow-list
     * entry cannot enable a product nobody listed.
     */
    const entry = resolveKey(target.entryKey.toUpperCase());
    return this.entryAllowList().includes(entry);
  }

  /** The allow-list as canonical keys, so a legacy spelling and its composed form compare equal. */
  private entryAllowList(): readonly string[] {
    return this.config.SEAMNEX_RELAY_ENTRY_KEYS.split(',')
      .map((key) => resolveKey(key.trim().toUpperCase()))
      .filter((key) => key.length > 0);
  }

  /**
   * The mapping, plus the entitlement it rests on. An `entitlement` row that is gone means access
   * was revoked; the cached session must not be used to outrun that, so the absence is treated as
   * "nothing to do" rather than as a credential problem.
   */
  private async accountOf(input: RelayAttemptInput): Promise<ProductAccountView | null> {
    const entitled = await this.pool.query(
      `SELECT 1 FROM entitlement WHERE subject_idp_id = $1 AND instance_id = $2`,
      [input.subjectIdpId, input.instanceId],
    );
    if (entitled.rowCount === 0) return null;

    const result = await this.pool.query<{
      id: string;
      login: string;
      secret_ref: string;
      state: ProductAccountView['state'];
    }>(
      `SELECT id, login, secret_ref, state
         FROM product_account WHERE instance_id = $1 AND subject_idp_id = $2`,
      [input.instanceId, input.subjectIdpId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { id: row.id, login: row.login, secretRef: row.secret_ref, state: row.state };
  }

  /**
   * Ask for this subject's mapping, once, and do not let the launch wait for a slow product.
   *
   * Two failure modes are deliberately not distinguished for the caller: "the pass failed" and
   * "the pass is still running" both mean the browser sees the product's own form, which is today's
   * behaviour. The difference matters only to the operator, and it is in the log and the audit
   * chain — never in the response, because the response cannot say why (ADR-BE-22 §fail-closed).
   */
  private async provisionOnMiss(
    input: RelayAttemptInput,
    target: RelayTarget,
  ): Promise<ProductAccountView | null> {
    if (this.accounts === undefined) return null;
    if (!this.claimProvisionAttempt(input.instanceId, input.subjectIdpId)) return null;

    /*
     * The same single-flight lock the sign-in below takes, and for a second reason beyond dedupe:
     * provisioning can mint or reset the very password that sign-in presents, so the two must not
     * overlap for one pair. Two tabs that both missed the mapping therefore produce one pass; the
     * loser falls through to the product's form, which is what it would have been told anyway. The
     * sweep does not take this lock — it is the safety net and its own quiet period bounds it — so
     * this narrows the race rather than closing it, and `product_account_subject_unique` is what
     * still prevents a duplicate row.
     */
    const release = await acquireLoginLock(
      this.redis,
      input.instanceId,
      input.subjectIdpId,
      this.config.SEAMNEX_RELAY_LOCK_SECONDS * 1_000,
    );
    if (release === null) return null;

    const deadlineMs = PROVISION_ON_LAUNCH_DEADLINE_MS;
    let outcome: 'done' | 'failed' | 'timeout';
    try {
      outcome = await Promise.race([
        this.accounts
          .provisionInstance(input.instanceId, input.subjectIdpId)
          .then(() => 'done' as const)
          .catch((error: unknown) => {
            this.logger.warn(
              `the launch could not provision ${input.subjectIdpId} on ${input.instanceId}: ${messageOf(error)}`,
            );
            return 'failed' as const;
          }),
        delay(deadlineMs).then(() => 'timeout' as const),
      ]);
    } finally {
      /*
       * Released even on the deadline. Nothing is signing in on this request when the pass overran
       * (the caller returns `no_mapping`), and holding the lock for work nobody is waiting for would
       * make the next launch queue behind it. A second pass is then possible, and the sweep's quiet
       * period plus `product_account_subject_unique` are the backstop for that — a cost accepted
       * here rather than turning one slow product into a launch that blocks for a lock's lifetime.
       */
      await release();
    }

    if (outcome === 'timeout') {
      /*
       * The pass keeps running: cancelling it would waste the product calls it has already made,
       * and the mapping it writes is what the next launch wants. So the deadline is the browser's,
       * not the work's.
       */
      this.logger.log(
        { instanceId: input.instanceId, entryKey: target.entryKey, deadlineMs },
        'the launch did not wait for provisioning; the mapping will be used by the next launch',
      );
      return null;
    }
    if (outcome === 'failed') return null;
    return this.accountOf(input);
  }

  /** True when this pair has not asked inside the window; bounded, like the sweep's own windows. */
  private claimProvisionAttempt(instanceId: string, subjectIdpId: string): boolean {
    const key = `${instanceId}:${subjectIdpId}`;
    const now = Date.now();
    const last = this.provisionRequestedAt.get(key);
    if (last !== undefined && now - last < PROVISION_REQUEST_WINDOW_MS) return false;
    for (const [entry, at] of this.provisionRequestedAt) {
      if (now - at >= PROVISION_REQUEST_WINDOW_MS) this.provisionRequestedAt.delete(entry);
    }
    this.provisionRequestedAt.set(key, now);
    return true;
  }

  private async fail(
    input: RelayAttemptInput,
    target: RelayTarget,
    account: ProductAccountView,
    reason: RelayFailure,
    detail: string,
  ): Promise<RelayOutcome> {
    /*
     * The detail is the driver's own vocabulary (a status code, a short product message). It can
     * never contain the credential: the driver has no way to put one in it, and this line is the
     * only place a failure text reaches a log or the audit chain.
     */
    this.logger.warn(
      { entryKey: target.entryKey, slug: target.slug, subject: input.subjectIdpId, reason },
      `relay sign-in failed: ${detail}`,
    );
    /*
     * A refused password is the one failure that gets worse when repeated: the product counts it,
     * and the twentieth locks a real person out for half an hour. Counting here is what lets the
     * fourth launch stop instead of becoming the twentieth.
     */
    if (reason === 'credential_rejected') await this.recordCredentialFailure(account.id);
    await this.recordOutcome(
      input,
      target,
      'relay.signin.failed',
      { outcome: 'failed', reason, login: account.login },
      'failure',
    );
    await this.recordCheck(input.instanceId, false, `${reason}: ${detail}`);
    return { kind: 'failed', reason };
  }

  private async recordReuse(input: RelayAttemptInput, target: RelayTarget): Promise<void> {
    await this.recordOutcome(input, target, 'relay.signin.reused', { outcome: 'relayed' });
    await this.recordCheck(input.instanceId, true, 'the cached product session was accepted');
  }

  private async recordOutcome(
    input: RelayAttemptInput,
    target: RelayTarget,
    action: string,
    detail: Record<string, unknown>,
    outcome: 'success' | 'failure' = 'success',
  ): Promise<void> {
    await this.audit
      .append({
        action,
        actorType: 'user',
        actorId: input.subjectIdpId,
        targetType: 'instance',
        targetId: input.instanceId,
        outcome,
        detail: { ...detail, entryKey: target.entryKey, slug: target.slug },
      })
      // The launch must not fail because the audit chain is briefly unavailable; the failure is
      // logged, counted and the platform's audit writer has its own fail-closed path for mutations.
      // The counter matters because this is the record of a relayed sign-in: an outage that loses
      // rows silently is a repudiation gap an operator has to be able to see.
      .catch((error: unknown) => {
        this.metrics.relayAuditFailures.labels(action).inc();
        this.logger.error(
          { err: messageOf(error), action, instanceId: input.instanceId },
          'the relay outcome could not be audited',
        );
      });
  }

  /**
   * Counts a refused credential and stops the mapping at the limit.
   *
   * `failed` is the state the sweep already knows how to recover (`rotateDue` picks it up); the
   * alternative — leaving it `active` — produced one failed product login per launch until the
   * product's own counter locked the account.
   */
  private async recordCredentialFailure(accountId: string): Promise<void> {
    await this.pool
      .query(
        `UPDATE product_account
            SET consecutive_failures = consecutive_failures + 1,
                state = CASE
                          WHEN consecutive_failures + 1 >= $2 THEN 'failed'
                          ELSE state
                        END,
                last_error = CASE
                               WHEN consecutive_failures + 1 >= $2 THEN 'credential_rejected'
                               ELSE last_error
                             END,
                updated_at = now()
          WHERE id = $1`,
        [accountId, CREDENTIAL_FAILURE_LIMIT],
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `the credential failure could not be counted for ${accountId}: ${messageOf(error)}`,
        );
      });
  }

  /**
   * Closes the breaker again after a credential the product accepted.
   *
   * The reset is not allowed to fail the launch — the sign-in has already happened — but it is not
   * allowed to fail *silently* either. Swallowing it left the counter elevated after a transient
   * database error, so two later rejections the mapping did not earn marked it `failed` and stopped
   * relayed sign-in until the rotation pass ran: the inverse of the fail-closed read path.
   */
  private async clearCredentialFailures(accountId: string): Promise<void> {
    await this.pool
      .query(
        `UPDATE product_account SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0`,
        [accountId],
      )
      .catch((error: unknown) => {
        this.metrics.relayCredentialResetFailures.inc();
        this.logger.error(
          `the credential failure counter could not be reset for ${accountId}: ${messageOf(error)}`,
        );
      });
  }

  private async recordCheck(instanceId: string, ok: boolean, detail: string): Promise<void> {
    await this.integration
      .recordCheck(instanceId, 'relay_login', ok, detail)
      .catch((error: unknown) => {
        this.logger.warn(
          `the relay check could not be recorded for ${instanceId}: ${messageOf(error)}`,
        );
      });
  }
}

/** The failure code for a mapping that is not `active`, so the operator gets an actionable one. */
function stateReason(state: ProductAccountView['state']): RelayFailure {
  switch (state) {
    case 'pending':
      return 'account_pending';
    case 'failed':
      return 'account_failed';
    default:
      return 'account_disabled';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A timer that cannot keep a drained process alive, matching the scheduler's own interval. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
