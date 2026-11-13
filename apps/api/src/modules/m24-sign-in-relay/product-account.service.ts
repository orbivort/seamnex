import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { resolveKey } from '@seamnex/domain';
import { withTransaction } from '@seamnex/db';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { DockerEngineClient } from '../../common/docker/docker.client';
import { isUuid } from '../../common/http/uuid';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import { RENDERER_SERVICE, type RendererService } from '../m03-renderer/renderer.contract';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { ProductApiAdapters } from './provisioning-adapters';
import type {
  ProductAdminCredential,
  ProductProvisioningAdapter,
  ProductProvisioningTarget as ProductApiTarget,
} from './provisioning-adapter';
import { dropSubjectSessions } from './relay-cache';
import { bareHost, ensureInstanceJoined, internalOriginFor, publicOriginFor } from './relay-origin';
import { mintAdminToken } from './openproject-admin-token';
import {
  ADMIN_CREDENTIAL_SERVICE,
  type AdminCredentialService,
  type RelayFailure,
} from './relay.contract';
import type { ProductAccountService, ProvisionActor, ProvisionReport } from './relay.contract';

/** A retry of a provisioning failure that a human can plausibly have fixed in between. */
const RECOVERABLE_ERRORS = ['admin_credential_missing', 'product_unavailable'];

/**
 * How long a failed administrator-token bootstrap waits before another attempt.
 *
 * Six hours, not the fifteen minutes a missing token waits: this path submits the seed
 * administrator's password to the product, and the product locks an account after a run of failed
 * sign-ins. A wrong password is a human's edit, not something the next sweep fixes.
 */
const ADMIN_BOOTSTRAP_QUIET_MS = 6 * 60 * 60 * 1_000;

/** How long a recoverable provisioning failure waits before the sweep tries again. */
const RETRY_AFTER_MS = 15 * 60 * 1_000;

/**
 * How long a bootstrap that never reached the product defers the next attempt.
 *
 * Not the ordinary retry period, because the caller that most needs this is a person's click: a
 * deployment finishes, the application starts answering, and the launch asks to be signed in *now*.
 * Measured on D09-01 (2026-11-11, twice): `relay.provision` fires ~55 s after the container starts,
 * Puma is not listening yet, `/login` answers `503`, and the application is serving by the next
 * pass. A fifteen-minute period left the first launch after a redeploy with the product's own form,
 * which is the same regression the six-hour period caused — only smaller. Sixty seconds is long
 * enough to keep a double-click or a launch storm from becoming a second pass and short enough that
 * the next pass — a sweep or a person's click — is the attempt that works.
 */
const BOOTSTRAP_UNREACHABLE_QUIET_MS = 60 * 1_000;

/**
 * The quiet period a bootstrap attempt earns, by outcome.
 *
 * A refusal — a rejected password, a changed form, a human challenge — is a verdict: it waits six
 * hours, because the product locks an account after a run of failed sign-ins and a wrong password
 * is a human's edit. `product_unavailable` submitted nothing to refuse, so it protects nothing and
 * defers only long enough to serialise attempts (`BOOTSTRAP_UNREACHABLE_QUIET_MS`).
 * `session_unconfirmed` keeps the long period: it is the product answering about its own session,
 * which a retry does not change.
 */
function bootstrapHoldMs(reason: RelayFailure): number {
  return reason === 'product_unavailable'
    ? BOOTSTRAP_UNREACHABLE_QUIET_MS
    : ADMIN_BOOTSTRAP_QUIET_MS;
}

/**
 * The window's `reason` for the administrator bootstrap.
 *
 * Instance-wide, so `subject_idp_id` is `''`: the token belongs to the deployment, not to a person.
 * A failure reason is written here too, because "which failures reopen when" is the whole point of
 * the table — one row per `(instance, subject, reason)`.
 */
const ADMIN_BOOTSTRAP_REASON = 'admin_bootstrap';

const PROVISION_BATCH = 25;
const ROTATE_BATCH = 10;

type ProvisionCandidate = {
  instance_id: string;
  subject_idp_id: string;
  /** The catalogue entry: it selects the provisioning adapter, not the slug or the route. */
  entry_key: string;
  slug: string;
  payload: Record<string, unknown>;
  host: string | null;
  username: string;
  account_id: string | null;
  account_login: string | null;
  secret_ref: string | null;
  state: string | null;
  attempt: number;
};

type RotationCandidate = {
  id: string;
  instance_id: string;
  subject_idp_id: string;
  login: string;
  secret_ref: string;
  entry_key: string;
  slug: string;
  payload: Record<string, unknown>;
  host: string | null;
};

/**
 * ADR-BE-22 — the per-user product accounts the relay signs in as.
 *
 * The rules encoded here are the ADR's, not preferences:
 *
 *   * **One account per subject, per instance.** A login collision is resolved with a deterministic
 *     discriminator, never by reusing someone else's account — a shared account makes the product's
 *     audit log fiction, which is the one thing the per-user rule exists to prevent.
 *   * **The credential lives in M15 under its own scope**, owned by the mapping row, so it is not
 *     addressable from the instance scope or from another user's mapping.
 *   * **Failure is recorded, not retried in a loop.** The product locks an account after a handful of
 *     bad attempts; a sweep that keeps trying turns a missing admin token into a locked-out person.
 *     Only a cause a human can fix is retried, and only after a quiet period.
 */
@Injectable()
export class PostgresProductAccountService implements ProductAccountService {
  private readonly logger = new Logger('m24-product-accounts');
  private readonly joined = new Map<string, number>();
  /*
   * Both retry windows live in `relay_retry_window` (migration 0028), not in this process.
   *
   * They used to be `Map`s, and that made a restart a load-bearing part of the design: it cleared a
   * six-hour bootstrap quiet period (so a restart "fixed" a deferred attempt, and also spent one
   * more against a product that locks an account after a run of failures) and it re-audited a
   * failure the platform had already recorded. A window is a fact about the platform's own back-off,
   * so it belongs where the rest of the platform's facts live.
   */

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
    @Inject(RENDERER_SERVICE) private readonly renderer: RendererService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(ProductApiAdapters) private readonly adapters: ProductApiAdapters,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
    @Inject(ADMIN_CREDENTIAL_SERVICE) private readonly adminCredentials: AdminCredentialService,
  ) {}

  /** One pass: provision what is missing (or recoverable), then rotate what is due. */
  async sweep(): Promise<void> {
    if (!this.config.SEAMNEX_RELAY_ENABLED) return;
    await this.provisionMissing();
    await this.rotateDue();
  }

  /**
   * The same pass, aimed at one instance and optionally one person.
   *
   * This exists because the cadence is not a lifecycle event. A deployment finishing, and a person
   * opening a product for the first time, are both *now*: waiting for the next sweep made a fresh
   * install show the product's own login form for up to a full interval, and restarting the
   * scheduler was the only way to shorten it. The caller supplies the instance it already knows, so
   * the batch limit and the sweep's arbitrary ordering cannot starve it.
   *
   * Idempotent by construction: it runs the same selection and the same provisioning path, so the
   * sweep remains the safety net rather than a competing writer.
   */
  async provisionInstance(
    instanceId: string,
    subjectIdpId?: string,
    actor?: ProvisionActor,
  ): Promise<ProvisionReport> {
    /*
     * The idle report still says whether the deployment is *configured*, because "the relay is on
     * but nothing is allow-listed" and "the relay is off" are different mistakes to fix. Reporting
     * both as a bare `0` is the ambiguity this route was added to remove.
     */
    const idle: ProvisionReport = {
      instanceId,
      enabled: this.config.SEAMNEX_RELAY_ENABLED,
      configured: this.entryKeys().length > 0,
      considered: 0,
      provisioned: 0,
      failed: 0,
    };
    if (!this.config.SEAMNEX_RELAY_ENABLED) return idle;
    // The column is a uuid; a malformed id would raise 22P02 instead of selecting nothing.
    if (!isUuid(instanceId)) return idle;
    const scope: { instanceId: string; subjectIdpId?: string; actor?: ProvisionActor } = {
      instanceId,
    };
    if (subjectIdpId !== undefined) scope.subjectIdpId = subjectIdpId;
    if (actor !== undefined) scope.actor = actor;
    return { instanceId, enabled: true, ...(await this.provisionMissing(scope)) };
  }

  /**
   * Offboarding. Best-effort against the product, unconditional in the platform: the mapping and the
   * secret go even when the product cannot be reached, because "we could not disable the account" is
   * not a reason to keep holding its password.
   */
  async deprovision(subjectIdpId: string): Promise<void> {
    const rows = await this.pool
      .query<{ id: string; instance_id: string; login: string; secret_ref: string }>(
        `SELECT id, instance_id, login, secret_ref FROM product_account WHERE subject_idp_id = $1`,
        [subjectIdpId],
      )
      .catch(() => null);
    if (rows === null) return;

    for (const row of rows.rows) {
      const disabled = await this.disableInProduct(row.instance_id, row.login).catch(() => false);
      await this.secrets
        // Named scope and owner: a `secret_ref` that drifted onto another mapping's secret (or onto
        // the instance admin token) is refused instead of being deleted by an offboarding.
        .remove(row.secret_ref, `offboarding ${subjectIdpId}`, {
          scope: 'product_account',
          ownerId: row.id,
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `the credential for ${subjectIdpId} on ${row.instance_id} could not be deleted: ${messageOf(error)}`,
          );
        });
      await this.pool
        .query(`DELETE FROM product_account WHERE id = $1`, [row.id])
        .catch((error: unknown) => {
          this.logger.error(
            `the product account ${row.id} could not be removed: ${messageOf(error)}`,
          );
        });
      await this.audit
        .append({
          action: 'relay.account.deprovisioned',
          actorType: 'service',
          actorId: this.config.SEAMNEX_ROLE,
          targetType: 'instance',
          targetId: row.instance_id,
          outcome: 'success',
          detail: { subject: subjectIdpId, login: row.login, disabledInProduct: disabled },
        })
        .catch(() => undefined);
    }

    // A cached product session outliving the platform account is the revocation window the ADR
    // asks us to close, so the cache is dropped whatever the product said.
    await dropSubjectSessions(this.redis, subjectIdpId);
  }

  // ---------------------------------------------------------------------------------------------

  private async provisionMissing(scope?: {
    instanceId: string;
    subjectIdpId?: string;
    actor?: ProvisionActor;
  }): Promise<{
    configured: boolean;
    considered: number;
    provisioned: number;
    failed: number;
  }> {
    const entries = this.entryKeys();
    if (entries.length === 0) {
      return { configured: false, considered: 0, provisioned: 0, failed: 0 };
    }

    const candidates = await this.pool.query<ProvisionCandidate>(
      /*
       * One row per subject, not per entitlement. A person can hold several entitlement rows on the
       * same instance — the deploying owner has `Owner` from the deployment and `member` from the
       * group sync — and a candidate per row meant two passes for one mapping: the first created the
       * account, the second hit `product_account_subject_unique` and aborted with a duplicate-key
       * error that read like a platform fault. `DISTINCT ON` makes the batch a set of people; the
       * columns that differ between those rows (role, source, sync state) are not read here.
       */
      `SELECT DISTINCT ON (e.instance_id, e.subject_idp_id)
              e.instance_id, e.subject_idp_id, i.entry_key, i.slug, i.payload, r.host,
              u.username,
              pa.id AS account_id, pa.login AS account_login, pa.secret_ref, pa.state,
              pa.attempt
         FROM entitlement e
         JOIN instance i ON i.id = e.instance_id
         JOIN idp_user u ON u.idp_id = e.subject_idp_id
         LEFT JOIN instance_route r ON r.instance_id = i.id
         LEFT JOIN product_account pa
                ON pa.instance_id = e.instance_id AND pa.subject_idp_id = e.subject_idp_id
        WHERE i.entry_key = ANY($1) AND i.deleted_at IS NULL AND u.enabled
          -- Only a product that is up can accept an account. Without this the first pass after an
          -- install raced the product's own startup often enough to matter: the create answered
          -- product_unavailable, the row was marked failed, and the retry quiet period then cost
          -- fifteen minutes for an install that was fine. Readiness is the platform's own verdict;
          -- degraded counts, because that state means "up, not yet proven healthy".
          AND i.state IN ('ready', 'degraded')
          AND ($4::uuid IS NULL OR e.instance_id = $4::uuid)
          AND ($5::text IS NULL OR e.subject_idp_id = $5)
          AND (
            pa.id IS NULL
            -- A cause a human can fix, retried after a quiet period.
            OR (pa.state = 'failed' AND pa.last_error = ANY($2) AND pa.updated_at < $3)
            -- A pass that died mid-provision, recognised by a pending row nobody finished.
            OR (pa.state = 'pending' AND pa.updated_at < $3)
          )
        ORDER BY e.instance_id, e.subject_idp_id
        LIMIT ${PROVISION_BATCH}`,
      [
        entries,
        RECOVERABLE_ERRORS,
        new Date(Date.now() - RETRY_AFTER_MS),
        scope?.instanceId ?? null,
        scope?.subjectIdpId ?? null,
      ],
    );

    let provisioned = 0;
    let failed = 0;
    for (const candidate of candidates.rows) {
      const outcome = await this.provision(candidate, scope?.actor).catch((error: unknown) => {
        this.logger.error(
          `provisioning ${candidate.subject_idp_id} on ${candidate.instance_id} failed unexpectedly: ${messageOf(error)}`,
        );
        return 'failed' as const;
      });
      if (outcome === 'provisioned') provisioned += 1;
      else failed += 1;
    }
    return { configured: true, considered: candidates.rows.length, provisioned, failed };
  }

  /**
   * Both spellings of every allow-listed key.
   *
   * An environment file may still carry `D9` while the catalogue stores `D09-01` (ADR-BE-20
   * migrations), and passing only the spelling the operator typed selected zero candidates on the
   * dev stack — no account was ever provisioned and nothing said so, so the sweep looked idle rather
   * than misconfigured.
   *
   * The SQL is `entry_key = ANY(...)`: exact equality, never a prefix. `D09-01` therefore does not
   * select `D09-02`, and a second deployment definition of the same product needs its own key.
   */
  private entryKeys(): string[] {
    return [
      ...new Set(
        this.config.SEAMNEX_RELAY_ENTRY_KEYS.split(',')
          .map((key) => key.trim().toUpperCase())
          .filter((key) => key.length > 0)
          .flatMap((key) => [key, resolveKey(key)]),
      ),
    ];
  }

  /*
   * The outcome is returned, not inferred by the caller from a log line: `POST
   * /instances/:id/relay/provision` answers in counts, and a pass that created nothing because the
   * administrator token is absent must read as `failed` rather than as a silent success.
   */
  private async provision(
    candidate: ProvisionCandidate,
    actor?: ProvisionActor,
  ): Promise<'provisioned' | 'failed'> {
    /*
     * Every failure below is the same statement about the same candidate, and each one has to be
     * attributed. Binding the candidate once keeps the attribution out of seven call sites that
     * differ only in their reason, so no future branch can record a failure without an actor.
     */
    const failed = (reason: string, detail: string, accountId?: string): Promise<void> =>
      this.recordFailure(candidate, reason, detail, accountId, actor);

    const adapter = this.adapters.for(candidate.entry_key);
    if (adapter === null) {
      /*
       * Not recoverable by retrying, and not an error either: the platform simply has no admin API
       * client for this product, so its mappings stay hand-made — the state ADR-BE-22 documents for
       * any product whose provisioning the platform does not implement.
       */
      await failed(
        'adapter_missing',
        `no provisioning adapter is registered for ${candidate.entry_key}`,
      );
      return 'failed';
    }
    let target = await this.productTarget(adapter, candidate);
    if (target === null) {
      /*
       * ADR-BE-22 §Credentials (amendment). A fresh deployment of a `bearer` product has no token,
       * and a token exists only inside an authenticated session — so a redeploy used to regress every
       * launch to the product's own form with nothing but an audit row to explain it. When the entry
       * names the administrator the deploy seeded, derive the token once through that account's own
       * form, then read it back through the same path the sweep always uses. Only an actual attempt
       * re-reads the target: a password product must not pay for a second lookup.
       */
      if (await this.ensureAdminCredential(adapter, candidate)) {
        target = await this.productTarget(adapter, candidate);
      }
    }
    if (target === null) {
      await failed('admin_credential_missing', missingCredentialDetail(adapter));
      return 'failed';
    }
    await ensureInstanceJoined(this.docker, this.config, this.logger, this.joined, candidate.slug);

    const login = await this.loginFor(candidate);
    const accountId = candidate.account_id ?? randomUUID();
    const password = generatePassword();

    // The secret is written inside the same transaction as the mapping: a mapping without a
    // credential is a row the relay would look up and then fail to open on every launch.
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const secret = await this.secrets.put('product_account', accountId, 'password', password, tx);
      if (candidate.account_id === null) {
        await tx.query(
          `INSERT INTO product_account
             (id, instance_id, subject_idp_id, login, secret_ref, state, attempt)
           VALUES ($1, $2, $3, $4, $5, 'pending', 1)`,
          [accountId, candidate.instance_id, candidate.subject_idp_id, login, secret.id],
        );
      } else {
        await tx.query(
          `UPDATE product_account
              SET login = $2, secret_ref = $3, state = 'pending',
                  attempt = attempt + 1, updated_at = now()
            WHERE id = $1`,
          [accountId, login, secret.id],
        );
      }
    });

    const created = await adapter.createUser(target, {
      login,
      password,
      firstName: displayName(candidate.username).first,
      lastName: displayName(candidate.username).last,
      /*
       * A product-local address, never the directory one. OpenProject refuses an account without an
       * address — `422 Email can't be blank` on 17.9.6, measured through the provisioning client, so
       * "optional" is a property of the adapter interface and not of every product. Forwarding the
       * directory address is still refused (NFR-4.13): what the product receives is derived from the
       * login the platform just minted, so it is unique per person, reveals nothing the login does
       * not already reveal, and names a mailbox nobody reads — which is the honest outcome for an
       * account the platform owns and the person never asked the product to mail.
       */
      email: `${login}@${bareHost(candidate.host ?? candidate.slug)}`,
    });

    if (!created.ok) {
      /*
       * A 422 on create usually means a previous attempt did create the user and the answer was
       * lost. Reconciling is idempotent; retrying blindly is how an account is created twice.
       *
       * Reconciling is not enough on its own: the secret this pass just wrote holds a password the
       * existing account does not know. The reset is what makes the reconciliation complete, and
       * without it the relay would present a credential the product rejects.
       */
      const existing = await adapter.findUserByLogin(target, login);
      if (!existing.ok || existing.value === null) {
        await failed('product_unavailable', created.detail, accountId);
        return 'failed';
      }

      /*
       * Two questions before the platform may touch this account, and both are load-bearing.
       *
       *   1. **Did this mapping create it?** A first provision that collides means the login already
       *      belongs to someone else in the product: a human account an administrator created, or
       *      the product's own seeded administrator. Resetting that password would give a platform
       *      subject an identity the platform does not own — privilege escalation when the login is
       *      `admin` — and would destroy the break-glass credential ADR-BE-22 keeps outside the
       *      relay. `candidate.account_id` is the platform's record that a previous pass created
       *      the account; without it there is no such record and adoption is refused.
       *   2. **Is it still a non-administrator?** A mapping adopted before this guard existed could
       *      point at an admin account. It is not re-passworded now either.
       *
       * `login_collision` is deliberately not in `RECOVERABLE_ERRORS`: retrying cannot fix it, and
       * a person has to look at the product.
       */
      if (candidate.account_id === null) {
        await failed(
          'login_collision',
          `the product already has an account named ${login} that this platform did not create`,
          accountId,
        );
        return 'failed';
      }
      if (existing.value.admin) {
        await failed(
          'login_collision',
          `the product account ${login} has administrator rights and is not adopted`,
          accountId,
        );
        return 'failed';
      }

      const reset = await adapter.resetPassword(target, existing.value.id, password);
      if (!reset.ok) {
        await failed('product_unavailable', reset.detail, accountId);
        return 'failed';
      }
      await this.markActive(accountId, candidate, login, actor);
      return 'provisioned';
    }

    await this.markActive(accountId, candidate, login, actor);
    return 'provisioned';
  }

  private async markActive(
    accountId: string,
    candidate: ProvisionCandidate,
    login: string,
    actor?: ProvisionActor,
  ): Promise<void> {
    const who = this.actorOrService(actor);
    await this.pool.query(
      `UPDATE product_account
          SET state = 'active', last_error = NULL, provisioned_at = now(), rotated_at = now(),
              consecutive_failures = 0, login = $2, updated_at = now()
        WHERE id = $1`,
      [accountId, login],
    );
    await this.audit
      .append({
        action: 'relay.account.provisioned',
        actorType: who.type,
        actorId: who.id,
        targetType: 'instance',
        targetId: candidate.instance_id,
        outcome: 'success',
        detail: { subject: candidate.subject_idp_id, login },
      })
      .catch(() => undefined);
    this.logger.log(
      { instanceId: candidate.instance_id, subject: candidate.subject_idp_id, login },
      'product account provisioned',
    );
  }

  private async recordFailure(
    candidate: ProvisionCandidate,
    reason: string,
    detail: string,
    accountId?: string,
    actor?: ProvisionActor,
  ): Promise<void> {
    const who = this.actorOrService(actor);
    const id = accountId ?? candidate.account_id;
    if (id !== null) {
      await this.pool
        .query(
          `UPDATE product_account
              SET state = 'failed', last_error = $2, updated_at = now()
            WHERE id = $1`,
          [id, reason],
        )
        .catch(() => undefined);
    }
    if (!(await this.claimFailureWindow(candidate, reason))) return;
    await this.audit
      .append({
        action: 'relay.account.provision_failed',
        actorType: who.type,
        actorId: who.id,
        targetType: 'instance',
        targetId: candidate.instance_id,
        outcome: 'failure',
        detail: { subject: candidate.subject_idp_id, reason, detail },
      })
      .catch(() => undefined);
    this.logger.warn(
      { instanceId: candidate.instance_id, subject: candidate.subject_idp_id, reason },
      `product account provisioning did not complete: ${detail}`,
    );
  }

  /**
   * True when this failure has not been recorded inside the retry quiet period.
   *
   * A candidate with no `product_account` row yet has nothing to timestamp, so the sweep re-selects
   * it on every pass. Without this the `admin_credential_missing` case the ADR documents would
   * append an audit row every sweep, per user, for as long as the token is absent — the quiet
   * period applies to the retry, so it must apply to its evidence too.
   *
   * The claim is one statement: the conditional `DO UPDATE` makes two schedulers racing the same
   * candidate produce exactly one row and exactly one `true`.
   */
  private async claimFailureWindow(
    candidate: ProvisionCandidate,
    reason: string,
  ): Promise<boolean> {
    const claimed = await this.claimWindow(
      candidate.instance_id,
      candidate.subject_idp_id,
      reason,
      RETRY_AFTER_MS,
    ).catch((error: unknown) => {
      /*
       * A window that cannot be written must not silence the evidence: "record it twice" is a
       * recoverable annoyance, "record it never" is the repudiation gap the audit chain exists to
       * prevent. This is the only place that failure is reported — `claimWindow` deliberately has no
       * catch of its own, so the caller decides whether the claim or the evidence wins.
       */
      this.logger.warn(
        `the failure window for ${candidate.subject_idp_id} on ${candidate.instance_id} could not be claimed: ${messageOf(error)}`,
      );
      return true;
    });
    return claimed;
  }

  /**
   * The platform is the actor unless a person asked.
   *
   * `service` rather than `system`: the row then names the role that did it, which is what an
   * operator greps for when a mapping appears that nobody remembers creating.
   */
  private actorOrService(actor?: ProvisionActor): ProvisionActor {
    return actor ?? { type: 'service', id: this.config.SEAMNEX_ROLE };
  }

  /**
   * Claim one retry window, atomically, and record when it reopens.
   *
   * `false` means the window is still open — the caller must not act (and must not record the same
   * evidence again). The upsert's `WHERE` is what makes it a claim rather than a write: a second
   * caller inside the window updates nothing and therefore returns no row.
   */
  private async claimWindow(
    instanceId: string,
    subjectIdpId: string,
    reason: string,
    holdMs: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO relay_retry_window (instance_id, subject_idp_id, reason, retry_after)
       VALUES ($1, $2, $3, now() + ($4::text || ' milliseconds')::interval)
       ON CONFLICT (instance_id, subject_idp_id, reason) DO UPDATE
          SET retry_after = EXCLUDED.retry_after, updated_at = now()
        WHERE relay_retry_window.retry_after <= now()
       RETURNING 1`,
      [instanceId, subjectIdpId, reason, holdMs],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Is this instance still inside its administrator-bootstrap quiet period? */
  private async bootstrapDeferred(instanceId: string): Promise<boolean> {
    const row = await this.pool
      .query(
        `SELECT 1 FROM relay_retry_window
          WHERE instance_id = $1 AND subject_idp_id = '' AND reason = $2 AND retry_after > now()`,
        [instanceId, ADMIN_BOOTSTRAP_REASON],
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `the bootstrap window for ${instanceId} could not be read: ${messageOf(error)}`,
        );
        return null;
      });
    /*
     * Unreadable is treated as "still deferred". The cost is one skipped pass; the alternative is
     * another submission of the seeded administrator's password to a product that locks the account
     * after a run of failures, which is the outcome the window exists to prevent.
     */
    return row === null ? true : (row.rowCount ?? 0) > 0;
  }

  private async rotateDue(): Promise<void> {
    const dueBefore = new Date(
      Date.now() - this.config.SEAMNEX_RELAY_ROTATION_DAYS * 24 * 60 * 60 * 1_000,
    );
    const candidates = await this.pool.query<RotationCandidate>(
      `SELECT pa.id, pa.instance_id, pa.subject_idp_id, pa.login, pa.secret_ref,
              i.entry_key, i.slug, i.payload, r.host
         FROM product_account pa
         JOIN instance i ON i.id = pa.instance_id
         LEFT JOIN instance_route r ON r.instance_id = i.id
        WHERE (
                pa.state = 'active'
                -- The relay's circuit breaker: a credential the product refused is recovered by
                -- re-passwording it, not by retrying the sign-in again and again.
                OR (pa.state = 'failed' AND pa.last_error = 'credential_rejected')
              )
          AND (pa.rotated_at IS NULL OR pa.rotated_at < $1)
          AND i.deleted_at IS NULL
        ORDER BY pa.rotated_at NULLS FIRST
        LIMIT ${ROTATE_BATCH}`,
      [dueBefore],
    );

    for (const candidate of candidates.rows) {
      await this.rotate(candidate).catch((error: unknown) => {
        this.logger.error(
          `rotation for ${candidate.subject_idp_id} on ${candidate.instance_id} failed unexpectedly: ${messageOf(error)}`,
        );
      });
    }
  }

  private async rotate(candidate: RotationCandidate): Promise<void> {
    const adapter = this.adapters.for(candidate.entry_key);
    if (adapter === null) {
      await this.markRotationFailed(candidate, 'adapter_missing');
      return;
    }
    const target = await this.productTarget(adapter, candidate);
    if (target === null) {
      await this.markRotationFailed(candidate, 'admin_credential_missing');
      return;
    }
    await ensureInstanceJoined(this.docker, this.config, this.logger, this.joined, candidate.slug);

    const found = await adapter.findUserByLogin(target, candidate.login);
    if (!found.ok || found.value === null) {
      await this.markRotationFailed(candidate, 'product_unavailable');
      return;
    }

    const password = generatePassword();
    /*
     * The new value is stored before the product is told, so a crash between the two leaves the
     * platform holding a password the product will accept once the reset lands — never a secret the
     * product has already retired.
     *
     * A *failure* to store is not a crash and must not be treated like one. Continuing would
     * replace the product's password with a value nobody holds: the account becomes unusable while
     * the row (and the audit trail) says the rotation succeeded. So the store failing is the
     * rotation failing, and the product is not touched.
     */
    try {
      // Named scope and owner, as `open` does: rotation *replaces* the value, so a `secret_ref` that
      // drifted would overwrite another scope's secret and report the rotation as a success.
      await this.secrets.rotate(candidate.secret_ref, password, {
        scope: 'product_account',
        ownerId: candidate.id,
      });
    } catch (error) {
      this.logger.error(
        `rotation for ${candidate.id} could not store the new credential: ${messageOf(error)}`,
      );
      await this.markRotationFailed(candidate, 'secret_store_unavailable');
      return;
    }

    const reset = await adapter.resetPassword(target, found.value.id, password);
    if (!reset.ok) {
      await this.markRotationFailed(candidate, `rotation_failed: ${reset.detail}`);
      return;
    }

    await this.pool.query(
      `UPDATE product_account
          SET rotated_at = now(), last_error = NULL, state = 'active',
              consecutive_failures = 0, updated_at = now()
        WHERE id = $1`,
      [candidate.id],
    );
    /*
     * The cached session was minted with the old credential. ADR-BE-22 §Credentials requires a
     * cache flush with the rotation; without it the rotated credential's sessions keep working for
     * the rest of the cache TTL, which is the window the rotation exists to close.
     */
    await dropSubjectSessions(this.redis, candidate.subject_idp_id, candidate.instance_id);
    await this.audit
      .append({
        action: 'relay.account.rotated',
        actorType: 'service',
        actorId: this.config.SEAMNEX_ROLE,
        targetType: 'instance',
        targetId: candidate.instance_id,
        outcome: 'success',
        detail: { subject: candidate.subject_idp_id, login: candidate.login },
      })
      .catch(() => undefined);
  }

  /**
   * A rotation that failed leaves the account unusable. Recording `failed` is what makes the relay
   * stop trying and the operator see it, instead of a cache old session hiding the problem.
   */
  private async markRotationFailed(candidate: RotationCandidate, reason: string): Promise<void> {
    await this.pool
      .query(
        `UPDATE product_account SET state = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
        [candidate.id, reason],
      )
      .catch(() => undefined);
    // A cached session would hide the broken credential from the user and from the check, which is
    // exactly the failure mode `failed` exists to make visible.
    await dropSubjectSessions(this.redis, candidate.subject_idp_id, candidate.instance_id);
    await this.audit
      .append({
        action: 'relay.account.rotation_failed',
        actorType: 'service',
        actorId: this.config.SEAMNEX_ROLE,
        targetType: 'instance',
        targetId: candidate.instance_id,
        outcome: 'failure',
        detail: { subject: candidate.subject_idp_id, reason },
      })
      .catch(() => undefined);
    this.logger.warn(
      { instanceId: candidate.instance_id, subject: candidate.subject_idp_id, reason },
      'product credential rotation did not complete',
    );
  }

  /** Best-effort lock in the product; `false` means "the platform stopped holding the credential anyway". */
  private async disableInProduct(instanceId: string, login: string): Promise<boolean> {
    const row = await this.pool.query<{
      entry_key: string;
      slug: string;
      payload: Record<string, unknown>;
      host: string | null;
    }>(
      `SELECT i.entry_key, i.slug, i.payload, r.host
         FROM instance i LEFT JOIN instance_route r ON r.instance_id = i.id
        WHERE i.id = $1`,
      [instanceId],
    );
    const instance = row.rows[0];
    if (instance === undefined) return false;
    const adapter = this.adapters.for(instance.entry_key);
    if (adapter === null) return false;
    const target = await this.productTarget(adapter, { instance_id: instanceId, ...instance });
    if (target === null) return false;
    const found = await adapter.findUserByLogin(target, login);
    if (!found.ok || found.value === null) return false;
    const disabled = await adapter.disableUser(target, found.value.id);
    return disabled.ok;
  }

  /**
   * ADR-BE-22 §Credentials (amendment) — derive the bearer token from the account the deploy seeded.
   *
   * Runs only when the entry names a bootstrap recipe (which is how the adapter states that the
   * deploy, not a human, generated that administrator's password) and only once per quiet period.
   *
   * A refusal is not retried soon: a rejected password, a changed form or a human challenge is a
   * verdict, and the failure is what the next pass reads to stay away. A product that did not answer
   * is a different fact and earns the ordinary retry period (`bootstrapHoldMs`) — the deployment that
   * asked for this pass is often seconds old, and its application is still booting behind a
   * listener that is already up. The password is never rotated, so an administrator that still owes a
   * forced password change is reported rather than adopted — rotating a break-glass password to a
   * value nobody can read would take the product's admin account away from its operator.
   */
  private async ensureAdminCredential(
    adapter: ProductProvisioningAdapter,
    instance: {
      instance_id: string;
      entry_key: string;
      slug: string;
      payload: Record<string, unknown>;
      host: string | null;
    },
  ): Promise<boolean> {
    const recipe = adapter.adminBootstrap;
    if (adapter.credentialKind !== 'bearer' || recipe === undefined) return false;
    if (await this.bootstrapDeferred(instance.instance_id)) return false;

    const origin = internalOriginFor(instance.slug, instance.payload);
    if (origin === null) return false;

    const secret = await this.secrets
      .find('instance', instance.instance_id, recipe.passwordVariable)
      .catch(() => null);
    // No seed credential: the deploy did not declare one, so a person supplies the token instead.
    if (secret === null) return false;

    const password = await this.secrets
      .open(secret.id, `relay bootstrap on ${instance.instance_id}`, {
        scope: 'instance',
        ownerId: instance.instance_id,
      })
      .catch(() => null);
    if (password === null) return false;

    await ensureInstanceJoined(this.docker, this.config, this.logger, this.joined, instance.slug);
    const routeHost = instance.host ?? `${instance.slug}.${this.config.SEAMNEX_INGRESS_DOMAIN}`;
    const result = await mintAdminToken(
      {
        origin,
        publicOrigin: publicOriginFor(this.config, routeHost),
        username: recipe.login,
        password,
      },
      { timeoutMs: this.config.SEAMNEX_RELAY_HTTP_TIMEOUT_MS },
    );

    if (result.ok) {
      await this.clearBootstrapWindow(instance.instance_id);
      if (result.completedPasswordChange === true) {
        // A privileged mutation in the product, recorded where the operator will look for it. The
        // value is unchanged, so the row names the account, never the password.
        await this.audit
          .append({
            action: 'relay.admin_credential.password_change_completed',
            actorType: 'service',
            actorId: this.config.SEAMNEX_ROLE,
            targetType: 'instance',
            targetId: instance.instance_id,
            outcome: 'success',
            detail: { entryKey: instance.entry_key, login: recipe.login },
          })
          .catch(() => undefined);
        this.logger.log(
          { instanceId: instance.instance_id, entryKey: instance.entry_key },
          'the seed administrator still owed a password change; it was completed with the stored value',
        );
      }
      // The same writer an operator's paste goes through: one secret name, one audit shape, and the
      // actor type says which of the two produced this version.
      await this.adminCredentials
        .store(instance.instance_id, result.token, {
          type: 'service',
          id: this.config.SEAMNEX_ROLE,
        })
        .catch((error: unknown) => {
          this.logger.error(
            `the derived administrator token could not be stored: ${messageOf(error)}`,
          );
        });
      this.logger.log(
        { instanceId: instance.instance_id, entryKey: instance.entry_key },
        'product administrator token derived from the seeded account',
      );
      return true;
    }

    await this.deferBootstrap(instance.instance_id, bootstrapHoldMs(result.reason));

    await this.audit
      .append({
        action: 'relay.admin_credential.bootstrap_failed',
        actorType: 'service',
        actorId: this.config.SEAMNEX_ROLE,
        targetType: 'instance',
        targetId: instance.instance_id,
        outcome: 'failure',
        // No password, no token: the reason and the product's own short message only.
        detail: { entryKey: instance.entry_key, reason: result.reason, detail: result.detail },
      })
      .catch(() => undefined);
    this.logger.warn(
      { instanceId: instance.instance_id, entryKey: instance.entry_key, reason: result.reason },
      'the administrator token could not be derived from the seeded account',
    );
    // The attempt happened: the caller re-reads the target once so a successful store is used in
    // this pass rather than the next one.
    return true;
  }

  /**
   * Set the quiet period after a failed bootstrap. Unconditional by design: the attempt just
   * happened, so the window starts now whatever it held before.
   *
   * The period is the caller's (`bootstrapHoldMs`), because "the product refused this password" and
   * "the product had not finished booting" are different facts about different recoveries.
   *
   * Not being able to write it fails the deferral, not the pass: the failure is already audited, and
   * the next sweep will try again one pass earlier than the policy says rather than not at all.
   */
  private async deferBootstrap(instanceId: string, holdMs: number): Promise<void> {
    await this.pool
      .query(
        `INSERT INTO relay_retry_window (instance_id, subject_idp_id, reason, retry_after)
         VALUES ($1, '', $2, now() + ($3::text || ' milliseconds')::interval)
         ON CONFLICT (instance_id, subject_idp_id, reason) DO UPDATE
            SET retry_after = EXCLUDED.retry_after, updated_at = now()`,
        [instanceId, ADMIN_BOOTSTRAP_REASON, holdMs],
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `the bootstrap quiet period for ${instanceId} could not be stored: ${messageOf(error)}`,
        );
      });
  }

  /**
   * The token exists, so the window has nothing left to defer.
   *
   * A failed delete is harmless — `productTarget` will find the token next pass and never reach the
   * bootstrap — so it is logged rather than propagated into a provisioning pass that already worked.
   */
  private async clearBootstrapWindow(instanceId: string): Promise<void> {
    await this.pool
      .query(
        `DELETE FROM relay_retry_window
          WHERE instance_id = $1 AND subject_idp_id = '' AND reason = $2`,
        [instanceId, ADMIN_BOOTSTRAP_REASON],
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `the bootstrap window for ${instanceId} could not be cleared: ${messageOf(error)}`,
        );
      });
  }

  private async productTarget(
    adapter: ProductProvisioningAdapter,
    instance: {
      instance_id: string;
      slug: string;
      payload: Record<string, unknown>;
      host: string | null;
    },
  ): Promise<ProductApiTarget | null> {
    const origin = internalOriginFor(instance.slug, instance.payload);
    if (origin === null) return null;
    const credential = await this.adminCredential(adapter, instance.instance_id);
    if (credential === null) return null;
    const routeHost = instance.host ?? `${instance.slug}.${this.config.SEAMNEX_INGRESS_DOMAIN}`;
    return { origin, publicOrigin: publicOriginFor(this.config, routeHost), credential };
  }

  /**
   * The instance-scoped administrator credential, in the shape this product's API accepts.
   *
   * `bearer` is OpenProject: one PAT, named by config because the operator supplies it. `password`
   * is OrangeHRM: the administrator's username is written into the instance's environment by the
   * installer, and the password is already an instance secret. Reading the pair the adapter names
   * keeps enabling a product a code change only, with nothing new for an operator to configure — and
   * keeps this credential out of the per-user scope, where it must never live.
   */
  private async adminCredential(
    adapter: ProductProvisioningAdapter,
    instanceId: string,
  ): Promise<ProductAdminCredential | null> {
    if (adapter.credentialKind === 'bearer') {
      const secret = await this.secrets
        .find('instance', instanceId, this.config.SEAMNEX_RELAY_ADMIN_SECRET_NAME)
        .catch(() => null);
      if (secret === null) return null;
      const token = await this.secrets
        // Named scope and owner: the provisioning token is an instance secret, and `open` refuses an
        // id that belongs to a per-user credential (or anything else).
        .open(secret.id, `relay provisioning on ${instanceId}`, {
          scope: 'instance',
          ownerId: instanceId,
        })
        .catch(() => null);
      return token === null ? null : { kind: 'bearer', token };
    }

    const variables = adapter.passwordVariables;
    if (variables === undefined) return null;
    const username = await this.instanceVariable(instanceId, variables.username);
    const secret = await this.secrets
      .find('instance', instanceId, variables.password)
      .catch(() => null);
    if (username === null || secret === null) return null;
    const password = await this.secrets
      .open(secret.id, `relay provisioning on ${instanceId}`, {
        scope: 'instance',
        ownerId: instanceId,
      })
      .catch(() => null);
    return password === null ? null : { kind: 'password', username, password };
  }

  /**
   * An instance environment value as the deployer rendered it.
   *
   * Read through M03's contract, not its table: `instance_env_value` belongs to the renderer, and the
   * module-boundary gate exists to keep it that way. Only a non-secret variable is returned — the
   * secret half of a credential pair lives in M15 and is opened, never listed.
   */
  private async instanceVariable(instanceId: string, name: string): Promise<string | null> {
    const values = await this.renderer.instanceEnv(instanceId).catch(() => null);
    const value = values?.find((entry) => entry.name === name && !entry.secret)?.value;
    return value === undefined || value === null || value.length === 0 ? null : value;
  }

  /**
   * `preferred_username` is the platform's name for the person; the product's login has a narrower
   * alphabet. A collision gets a deterministic suffix derived from the subject, so the same subject
   * always resolves to the same login and a different subject never resolves to this one.
   */
  private async loginFor(candidate: ProvisionCandidate): Promise<string> {
    if (candidate.account_login !== null && candidate.account_login.length > 0) {
      return candidate.account_login;
    }
    const base =
      normaliseLogin(candidate.username) || `user-${shortHash(candidate.subject_idp_id)}`;
    const taken = await this.pool.query<{ login: string }>(
      `SELECT login FROM product_account WHERE instance_id = $1`,
      [candidate.instance_id],
    );
    const used = new Set(taken.rows.map((row) => row.login.toLowerCase()));
    /*
     * A reserved login is a colliding login even when no mapping claims it: the product seeds its
     * own administrator under one of these names, and generating it would either fail every pass
     * with `login_collision` or — worse, before that guard existed — take the account over. The
     * discriminator is deterministic, so the same subject always resolves to the same login.
     */
    if (!used.has(base.toLowerCase()) && !RESERVED_LOGINS.has(base.toLowerCase())) return base;
    return `${base.slice(0, 32)}-${shortHash(candidate.subject_idp_id)}`;
  }
}

/**
 * Product-side logins the platform will never generate or adopt. None of these is a name the
 * platform created; each is a name a product or an operator may already own, and the seeded
 * administrator is the case ADR-BE-22 keeps outside the relay.
 */
const RESERVED_LOGINS = new Set([
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'openproject',
]);

/** What the operator has to supply before this adapter can provision anything. */
function missingCredentialDetail(adapter: ProductProvisioningAdapter): string {
  if (adapter.credentialKind === 'bearer') {
    return 'the instance admin token is not configured';
  }
  const variables = adapter.passwordVariables;
  return variables === undefined
    ? 'the product declares no administrator login pair'
    : `the instance administrator login (${variables.username} / ${variables.password}) is not configured`;
}

/** Product logins take letters, digits, `-`, `_`, `.` and `@`; anything else is dropped. */
function normaliseLogin(username: string): string {
  const normalised = username
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // The product's own minimum is three characters; a two-letter login would be refused at the API.
  return normalised.length >= 3 ? normalised : '';
}

/** Deterministic, not cryptographic: the suffix only has to distinguish two subjects. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6);
}

/**
 * 32 characters from an unambiguous alphabet: a credential nobody has to transcribe.
 *
 * The four classes are forced, not hoped for. OpenProject refuses a new account with
 * `422 Password Must include characters of the following types: lowercase, uppercase, numeric,
 * special` — every provisioning pass on the dev stack died there, because the unambiguous alphabet
 * carried no symbol at all. One character per class costs nothing and removes a policy the platform
 * does not own from the failure list.
 */
function generatePassword(): string {
  const classes = [
    'abcdefghijkmnopqrstuvwxyz',
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    '23456789',
    '!@#%^*-_=+?',
  ] as const;
  const alphabet = classes.join('');
  /*
   * `randomInt` rejects out-of-range bytes and redraws, so every symbol is drawn uniformly. Reducing
   * a byte modulo a 68-symbol alphabet made 52 symbols 4/256 likely and 16 of them 3/256 — no break,
   * but a deviation from a uniform draw with nothing to gain (NFR-4.5, ADR-BE-22 §Credentials).
   */
  const characters = Array.from(
    { length: 32 },
    () => alphabet[randomInt(alphabet.length)] as string,
  );
  classes.forEach((set, index) => {
    characters[index] = set[randomInt(set.length)] as string;
  });
  return characters.join('');
}

function displayName(username: string): { first: string; last: string } {
  const parts = username
    .split(/[._\-\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
  if (parts.length === 0) return { first: 'Seamnex', last: 'User' };
  if (parts.length === 1) return { first: capitalise(parts[0] as string), last: 'User' };
  return {
    first: capitalise(parts[0] as string),
    last: capitalise(parts.slice(1).join(' ')),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
