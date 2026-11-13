import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  AccessRequest,
  AuditRangeVerification,
  BreakGlassReveal,
  BreakGlassSession,
  Capability,
  MaintenanceWindow,
  MaintenanceWindowCreateRequest,
  MaintenanceWindowPatchRequest,
  PlatformRole,
  PolicyException,
  PrivacyRequest,
} from '@seamnex/domain';
import { accessFor, breakGlassStateAt } from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '@seamnex/db';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { isUuid } from '../../common/http/uuid';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import {
  IDENTITY_SYNC_SERVICE,
  type IdentitySyncService,
} from '../m08-identity-sync/identity-sync.contract';
import { PORTAL_BFF_SERVICE, type PortalBffService } from '../m10-portal-bff/portal-bff.contract';
import {
  MAINTENANCE_WINDOW_SELECT,
  policyExceptionDiff,
  policyExceptionRequester,
  toMaintenanceWindow,
  type MaintenanceWindowRow,
} from './maintenance-window';
import { PrivacyQueueService } from './privacy-queue.service';
import type { GovernanceWrites } from './governance.contract';

const ACCESS_MODES = ['read_only', 'read_write'] as const;

/** The written reason an approver decides on; the console states the same number in its hint. */
const MIN_JUSTIFICATION = 20;

/**
 * Actions that end access instead of deciding it. They are the `breakglass.revoke` capability, not
 * `breakglass.approve`: the role that may approve a grant is not automatically the role that may
 * take one away, and `expire` is a revoke performed by the clock.
 */
const ENDS_ACCESS: ReadonlySet<string> = new Set(['revoke', 'expire']);

/** Every action the decision endpoint answers. Validated before the transaction takes row locks. */
const DECISIONS: ReadonlySet<string> = new Set(['approve', 'reject', 'revoke', 'expire']);

/** NFR-3.9 fallback when the settings row is missing or unreadable. */
const DEFAULT_BREAK_GLASS_MINUTES = 60;

/**
 * 4F - governance, privacy and settings writes.
 *
 * Three rules that are structural rather than documentary:
 *
 *   - **break-glass access mode is immutable after approval.** It is never in an UPDATE statement
 *     here, and the 0009 trigger refuses it at the database level. There is no extension path: an
 *     elevation that needs longer is a new request with a new approval.
 *   - **a decision is never taken by the requester.** Approving an exception or an access request
 *     compares the deciding subject with the requester and refuses.
 *   - **erasure deletes the mapping.** Deleting `subject_ref` *is* the erasure act; the audit chain
 *     keeps only the opaque reference, so the chain stays verifiable (inv. 6).
 */
@Injectable()
export class GovernanceWritesService implements GovernanceWrites {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
    /** Owns `access_request`: governance decides, M08 applies the transition. */
    @Inject(IDENTITY_SYNC_SERVICE) private readonly identity: IdentitySyncService,
    /** Owns `entitlement`: an approval that grants is M10's write, in this transaction. */
    @Inject(PORTAL_BFF_SERVICE) private readonly portal: PortalBffService,
    /** Reads the DSAR back in the same shape the queue renders, so the two can never disagree. */
    @Inject(PrivacyQueueService) private readonly privacy: PrivacyQueueService,
  ) {}

  // ---- break-glass ---------------------------------------------------------------------------

  async requestBreakGlass(
    input: { instanceId: string; accessMode: string; justification: string },
    actorId: string,
  ): Promise<BreakGlassSession> {
    if (!(ACCESS_MODES as readonly string[]).includes(input.accessMode)) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `Unknown access mode "${input.accessMode}".`,
        remediation: 'Use read_only or read_write.',
      });
    }

    /*
     * The justification is the only thing the approver has to decide on, so it is enforced here and
     * not only in the form. Trimming first matters: twenty spaces are not a written reason, and the
     * audit trail keeps whatever this column holds for the retention period.
     */
    const justification = input.justification.trim();
    if (justification.length < MIN_JUSTIFICATION) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `A written justification of at least ${MIN_JUSTIFICATION} characters is required.`,
        remediation:
          'Describe the task, why standing platform authority is insufficient, and how it will be rolled back.',
        fieldErrors: [
          {
            field: 'justification',
            code: 'minLength',
            message: `At least ${MIN_JUSTIFICATION} characters.`,
          },
        ],
      });
    }

    /*
     * An unknown instance used to reach the INSERT and leave the operator with an opaque 500 from a
     * foreign-key violation. It is a client mistake, so it is answered as one, before anything is
     * written or audited.
     */
    const instance = await this.pool.query<{ id: string }>(
      `SELECT id FROM instance WHERE id::text = $1 OR slug = $1 LIMIT 1`,
      [input.instanceId],
    );
    const instanceId = instance.rows[0]?.id;
    if (instanceId === undefined) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `No deployed instance matches "${input.instanceId}".`,
        remediation: 'Choose an instance from the list; a plan is not yet a deployment.',
        fieldErrors: [
          { field: 'instanceId', code: 'unknown', message: 'Instance does not exist.' },
        ],
      });
    }

    /*
     * The row and the evidence for it share one commit.
     *
     * They did not: the INSERT was one autocommit statement and `audit.append` another, so a failed
     * append left a live elevation with nothing recording who asked for it or why — the exact
     * "fail closed" property this module's header claims (AD-20).
     *
     * The self-approval decision is read inside the same transaction, so the row it governs cannot
     * be created on a stale count. `idp_user` is keyed by `idp_id` — `subject` does not exist and
     * made every request answer 500 — and the test is "is there another enabled person who could
     * approve", which is what CL-12 means by self-approval being the fallback rather than the
     * default.
     */
    const id = await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);

      const secondParty = await tx.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM idp_user WHERE idp_id <> $1 AND enabled) AS present`,
        [actorId],
      );
      // CL-12: "second party" means any eligible approver in scope; when none exists, self-approval
      // is allowed and flagged rather than leaving the operator no way to recover the platform.
      const selfApproved = secondParty.rows[0]?.present !== true;

      /*
       * Both ends of the window come from one instant. They did not: `granted_at` was `new Date()`
       * and `expires_at` re-read `Date.now()` after awaiting the settings row, so the elevation was
       * granted for the configured length *plus* however long that read took — an access window the
       * administrator never configured, and a duration that could not be asserted exactly.
       */
      const grantedAt = selfApproved ? new Date() : null;
      const expiresAt = grantedAt === null ? null : await this.breakGlassExpiry(tx, grantedAt);

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO break_glass_session (requester, instance_id, access_mode, state, justification, self_approved, approver, granted_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          actorId,
          instanceId,
          input.accessMode,
          selfApproved ? 'active' : 'requested',
          justification,
          selfApproved,
          selfApproved ? actorId : null,
          grantedAt,
          expiresAt,
        ],
      );
      const created = inserted.rows[0]?.id;
      if (created === undefined) throw internal('The break-glass request was not created.');
      await this.audit.append(
        {
          action: 'breakglass.requested',
          actorType: 'user',
          actorId,
          targetType: 'break_glass_session',
          targetId: created,
          outcome: 'success',
          detail: { instanceId: input.instanceId, accessMode: input.accessMode, selfApproved },
        },
        tx,
      );
      return created;
    });

    return this.breakGlass(id);
  }

  /**
   * The action decides the authority, not the route.
   *
   * `approve`/`reject` are decisions a second party takes; `revoke`/`expire` end access that is
   * already live, which the capability matrix reserves for R1. The route admits either capability
   * so a single dynamic segment can serve both, and this is where the action is matched to it.
   */
  async decideBreakGlass(
    id: string,
    action: string,
    actorId: string,
    role: PlatformRole,
  ): Promise<BreakGlassSession> {
    const required: Capability = ENDS_ACCESS.has(action)
      ? 'breakglass.revoke'
      : 'breakglass.approve';
    if (accessFor(role, required) === 'none') {
      throw new AppError({
        code: 'FORBIDDEN',
        status: 403,
        detail:
          required === 'breakglass.revoke'
            ? `Ending an elevation needs ${required}; ${role} does not hold it.`
            : `Deciding a request needs ${required}; ${role} does not hold it.`,
        remediation:
          required === 'breakglass.revoke'
            ? 'An elevation that has run out ends by itself; ask a platform administrator to end a live one early.'
            : 'The domain owner or an auditor decides the request; the requester never decides their own.',
      });
    }

    if (!DECISIONS.has(action)) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `Unknown action "${action}".`,
        remediation: 'Use approve, reject, revoke or expire.',
      });
    }

    /*
     * One transaction for the decision, the row it moves, the accounts it revokes and the audit row
     * it leaves. Three defects lived here: the read and the `UPDATE` were separate autocommit
     * statements, so two approvers could both read `requested` and both decide; the `UPDATE` carried
     * no state predicate, so the second decision silently overwrote `approver`; and the audit append
     * was a third commit, so an elevation could move with no evidence. `FOR UPDATE` plus the
     * predicate inside each `UPDATE` makes the decision single-use at the database, not at the
     * caller — which is the only place it can be enforced.
     */
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);

      const row = await tx.query<{
        requester: string;
        state: string;
        access_mode: string;
        expires_at: Date | null;
      }>(
        `SELECT requester, state, access_mode, expires_at
           FROM break_glass_session WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const session = row.rows[0];
      if (session === undefined) {
        throw new AppError({
          code: 'NOT_FOUND',
          detail: `No break-glass session ${id}.`,
          remediation: 'Refresh the elevation list.',
        });
      }

      /*
       * Time, not the stored row, decides whether a grant is still live. The sweep in the scheduler
       * closes overdue grants, but between two passes a row can read `active` after its window closed;
       * acting on that would extend access the platform has already promised to end.
       */
      const overdue =
        session.state === 'active' &&
        session.expires_at !== null &&
        session.expires_at.getTime() <= Date.now();

      const auditOutcome = async (
        auditedAction: string,
        detail: Record<string, unknown> = {},
      ): Promise<void> => {
        await this.audit.append(
          {
            action: auditedAction,
            actorType: 'user',
            actorId,
            targetType: 'break_glass_session',
            targetId: id,
            outcome: 'success',
            detail: { accessMode: session.access_mode, ...detail },
          },
          tx,
        );
      };

      if (action === 'approve') {
        if (session.requester === actorId) {
          throw new AppError({
            code: 'FORBIDDEN',
            status: 403,
            detail: 'The requester cannot approve their own elevation.',
            remediation:
              'Ask a second eligible approver; self-approval only applies when no second party exists.',
          });
        }
        if (overdue) throw stateConflict('expired', 'approve');
        if (session.state !== 'requested') throw stateConflict(session.state, 'approve');
        /*
         * `tx`, not `this.pool`: the expiry reads `settings`, and a second checkout inside this
         * transaction is the renderer defect again. `granted_at` is written from the same instant
         * the expiry is derived from — `now()` is the database clock, so pairing it with a Node
         * `Date.now()` would make the window the configured length plus the skew between them.
         */
        const grantedAt = new Date();
        const moved = await tx.query(
          `UPDATE break_glass_session
              SET state = 'active', approver = $2, granted_at = $4, expires_at = $3
            WHERE id = $1 AND state = 'requested'`,
          [id, actorId, await this.breakGlassExpiry(tx, grantedAt), grantedAt],
        );
        if (moved.rowCount !== 1) throw stateConflict(session.state, 'approve');
        await auditOutcome('breakglass.approve');
        return;
      }

      if (action === 'reject') {
        if (session.state !== 'requested') throw stateConflict(session.state, 'reject');
        const moved = await tx.query(
          `UPDATE break_glass_session SET state = 'rejected', approver = $2
            WHERE id = $1 AND state = 'requested'`,
          [id, actorId],
        );
        if (moved.rowCount !== 1) throw stateConflict(session.state, 'reject');
        await auditOutcome('breakglass.reject');
        return;
      }

      if (action === 'revoke') {
        if (overdue) {
          // The window closed first: record what actually happened rather than calling it a revoke.
          await tx.query(
            `UPDATE break_glass_session SET state = 'expired' WHERE id = $1 AND state = 'active'`,
            [id],
          );
          await this.revokeProductAccounts(id, tx);
          await auditOutcome('breakglass.expired', {
            reason: 'window closed before the revoke',
          });
          return;
        }
        if (session.state !== 'active') throw stateConflict(session.state, 'revoke');
        const moved = await tx.query(
          `UPDATE break_glass_session SET state = 'revoked', revoked_at = now()
            WHERE id = $1 AND state = 'active'`,
          [id],
        );
        if (moved.rowCount !== 1) throw stateConflict(session.state, 'revoke');
        await this.revokeProductAccounts(id, tx);
        await auditOutcome('breakglass.revoke');
        return;
      }

      // `expire` is the only remaining action: the set was checked above.
      if (session.state !== 'active') throw stateConflict(session.state, 'expire');
      const expired = await tx.query(
        `UPDATE break_glass_session SET state = 'expired' WHERE id = $1 AND state = 'active'`,
        [id],
      );
      if (expired.rowCount !== 1) throw stateConflict(session.state, 'expire');
      await this.revokeProductAccounts(id, tx);
      await auditOutcome('breakglass.expire');
    });

    return this.breakGlass(id);
  }

  /**
   * CL-12/CL-17: one-time credential, short TTL, recorded as a created account.
   *
   * The state check, the secret write and the "already live" guard are one transaction under
   * `FOR UPDATE`. They used to be three commits: two concurrent reloads both passed the guard and
   * minted two live passwords for one elevation, and a failure after the secret was written left an
   * orphan with nothing pointing at it. The secret joins the transaction (`put(..., tx)`) so it is
   * rolled back with the row that would have referenced it.
   */
  async reveal(id: string, actorId: string): Promise<BreakGlassReveal> {
    const username = `bg-${id.slice(0, 8)}`;
    const password = randomUUID().replace(/-/g, '');
    const revealedUntil = new Date(Date.now() + this.config.SEAMNEX_REVEAL_TTL_SECONDS * 1_000);

    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);

      const row = await tx.query<{
        state: string;
        expires_at: Date | null;
        retention_reason: string | null;
        reveal_expires_at: Date | null;
      }>(
        `SELECT state, expires_at, retention_reason, reveal_expires_at
           FROM break_glass_session WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const session = row.rows[0];
      if (session === undefined)
        throw new AppError({ code: 'NOT_FOUND', detail: `No break-glass session ${id}.` });
      if (
        session.state !== 'active' ||
        session.expires_at === null ||
        session.expires_at.getTime() <= Date.now()
      ) {
        throw new AppError({
          code: 'STATE_CONFLICT',
          detail: 'Only an active, unexpired elevation can reveal a credential.',
          remediation: 'Request a new elevation; an expired account is already revoked.',
        });
      }
      /*
       * CL-12 calls the credential single-use. Without this guard every reload minted a new password
       * for the same in-product account, so "the credential was revealed once" was not true of the
       * record. A second reveal is refused while one is still valid; after the window, a new one is
       * allowed because the old password has expired. The row lock is what makes the guard hold
       * against a concurrent reload rather than only against a browser refresh.
       */
      if (session.reveal_expires_at !== null && session.reveal_expires_at.getTime() > Date.now()) {
        throw new AppError({
          code: 'STATE_CONFLICT',
          status: 409,
          detail: 'A credential for this elevation is already live.',
          remediation:
            'Use the password that was shown; it is valid for seconds. Reveal again after it expires.',
        });
      }

      const stored = await this.secrets.put('instance', id, `breakglass_${username}`, password, tx);

      await tx.query(
        `UPDATE break_glass_session
            SET created_accounts = created_accounts || $2::jsonb,
                retention_reason = COALESCE(retention_reason, 'break-glass account removed on expiry'),
                revealed_at = now(),
                reveal_expires_at = $3,
                product_account_ref = COALESCE(product_account_ref, $4)
          WHERE id = $1`,
        [
          id,
          JSON.stringify([{ username, secretRef: stored.id, createdAt: new Date().toISOString() }]),
          revealedUntil,
          username,
        ],
      );
      await this.audit.append(
        {
          action: 'breakglass.credential.revealed',
          actorType: 'user',
          actorId,
          targetType: 'break_glass_session',
          targetId: id,
          outcome: 'success',
          detail: { username, ttlSeconds: this.config.SEAMNEX_REVEAL_TTL_SECONDS },
        },
        tx,
      );
    });

    return {
      username,
      password,
      methodNote:
        'in-product account created through the product API where available, otherwise recorded for manual creation',
      expiresAt: revealedUntil.toISOString(),
    };
  }

  // ---- policy exceptions and access requests ---------------------------------------------------

  async decideException(
    id: string,
    decision: 'approve' | 'reject',
    actorId: string,
  ): Promise<PolicyException> {
    if (!isUuid(id)) throw noPolicyException(id);
    /*
     * The state is read, checked and written under one row lock. Without it two approvers both read
     * `pending` and the chain recorded two decisions for one exception — the same defect that was
     * fixed on the access-request path. The expiry is checked here rather than only in the console:
     * an exception whose window has closed must not be granted by a late click.
     */
    return withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const row = await tx.query<{
        id: string;
        rule: string;
        scope: string;
        justification: string;
        state: string;
        expires_at: Date;
        created_at: Date;
        approver: string;
        patch_diff: unknown;
      }>(
        `SELECT id, rule, scope, justification, state, expires_at, created_at, approver, patch_diff
           FROM policy_exception WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const exception = row.rows[0];
      if (exception === undefined) throw noPolicyException(id);

      // One rule for "who asked", shared with the read surface (`policyExceptionRequester`).
      const requester = policyExceptionRequester(exception);
      if (requester === actorId) {
        throw new AppError({
          code: 'FORBIDDEN',
          status: 403,
          detail: 'The requester cannot decide their own policy exception.',
          remediation: 'A second party must decide; the queue exists for exactly this reason.',
        });
      }
      if (exception.expires_at.getTime() <= Date.now()) {
        throw new AppError({
          code: 'STATE_CONFLICT',
          status: 409,
          detail: `This exception expired on ${exception.expires_at.toISOString()}.`,
          remediation:
            'Ask for a new exception with a fresh expiry; an expired one cannot be granted.',
        });
      }
      if (exception.state !== 'pending' && exception.state !== 'requested') {
        throw stateConflict(exception.state, decision);
      }
      const state = decision === 'approve' ? 'approved' : 'rejected';
      await tx.query(`UPDATE policy_exception SET state = $2, approver = $3 WHERE id = $1`, [
        id,
        state,
        actorId,
      ]);
      /* The decision is echoed to a screen that names the decider, so it carries the person the
         queue shows, not the subject identifier the column stores. */
      const naming = await tx.query<{ name: string | null }>(
        `SELECT coalesce(display_name, username) AS name FROM idp_user WHERE idp_id = $1`,
        [actorId],
      );
      await this.audit.append(
        {
          action: `policy_exception.${decision}`,
          actorType: 'user',
          actorId,
          targetType: 'policy_exception',
          targetId: id,
          outcome: 'success',
          detail: { rule: exception.rule, scope: exception.scope, requester },
        },
        tx,
      );

      return {
        id,
        rule: exception.rule,
        scope: exception.scope,
        justification: exception.justification,
        requester,
        approver: naming.rows[0]?.name ?? actorId,
        state,
        requestedAt: exception.created_at.toISOString(),
        expiresAt: exception.expires_at.toISOString(),
        patchDiff: policyExceptionDiff(exception.patch_diff),
      };
    });
  }

  async decideAccessRequest(
    id: string,
    decision: 'approve' | 'reject',
    actorId: string,
  ): Promise<AccessRequest> {
    // Read-only: `access_request` belongs to M08, which is also the only writer.
    const request = await this.identity.accessRequest(id);

    if (request.requesterIdpId === actorId) {
      throw new AppError({
        code: 'FORBIDDEN',
        status: 403,
        detail: 'The requester cannot decide their own access request.',
        remediation: 'A second party must decide it.',
      });
    }
    if (request.state !== 'open') throw stateConflict(request.state, decision);

    const decided = await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      /**
       * The state check above runs outside a transaction, so two concurrent decisions both saw
       * `open`. M08 re-reads under a row lock and applies the transition, so only the first writer
       * decides; M10 owns `entitlement` and grants it in this same transaction. The transaction
       * stays here because governance is what makes the decision and records why.
       */
      const applied = await this.identity.decideAccessRequest(tx, { id, decision, actorId });

      if (decision === 'approve' && applied.kind === 'entitlement') {
        // The grant is the point of the approval: a decision that does not grant would be a lie.
        await this.portal.grantDirectEntitlement(tx, {
          subjectIdpId: applied.requesterIdpId,
          target: applied.target,
        });
      }

      await this.audit.append(
        {
          action: `access_request.${decision}`,
          actorType: 'user',
          actorId,
          targetType: 'access_request',
          targetId: id,
          outcome: 'success',
          detail: { requester: applied.requesterIdpId, target: applied.target },
        },
        tx,
      );

      return applied;
    });

    // The decision is echoed back to a caller that may render it, so it carries the names the
    // queue shows rather than the subject identifiers the row stores.
    const naming = (
      await this.pool.query<{
        requester_name: string | null;
        actor_name: string | null;
        domain: string | null;
      }>(
        `SELECT (SELECT coalesce(display_name, username) FROM idp_user WHERE idp_id = $1) AS requester_name,
                (SELECT coalesce(display_name, username) FROM idp_user WHERE idp_id = $2) AS actor_name,
                (SELECT domain FROM catalog_entry WHERE key = $3) AS domain`,
        [decided.requesterIdpId, actorId, decided.target],
      )
    ).rows[0];

    return {
      id,
      requester: {
        id: decided.requesterIdpId,
        name: naming?.requester_name ?? decided.requesterIdpId,
      },
      kind: decided.kind as AccessRequest['kind'],
      target: decided.target,
      justification: request.justification,
      state: decision === 'approve' ? 'approved' : 'rejected',
      createdAt: request.createdAt.toISOString(),
      decidedBy: naming?.actor_name ?? actorId,
      decidedAt: new Date().toISOString(),
      domain: naming?.domain ?? 'Platform',
    };
  }

  /**
   * The automated half of FR-4.11. Returns the closed grants instead of only logging them: the
   * sweep is evidence, and every row it moves needs its own audit entry written by the caller.
   * `break_glass_session` is owned by this module, so the statement lives here.
   */
  async expireOverdueBreakGlass(): Promise<
    ReadonlyArray<{ readonly id: string; readonly instanceId: string | null }>
  > {
    const result = await this.pool.query<{ id: string; instance_id: string | null }>(
      `UPDATE break_glass_session
          SET state = 'expired',
              retention_reason = COALESCE(retention_reason, 'accounts revoked on expiry')
        WHERE state IN ('approved', 'active')
          AND expires_at IS NOT NULL
          AND expires_at <= now()
        RETURNING id, instance_id`,
    );
    return result.rows.map((row) => ({ id: row.id, instanceId: row.instance_id }));
  }

  // ---- maintenance windows (CL-05) -------------------------------------------------------------

  async createWindow(
    request: MaintenanceWindowCreateRequest,
    actorId: string,
  ): Promise<MaintenanceWindow> {
    const scope = request.scope.trim();
    if (scope.length === 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'A maintenance window needs a scope.',
        remediation: 'Name the work: an instance, or the platform-wide change it covers.',
        fieldErrors: [{ field: 'scope', code: 'minLength', message: 'At least one character.' }],
      });
    }
    const bounds = this.windowBounds(request.startsAt, request.endsAt);
    /*
     * `instance_id` is a `uuid` column, so anything that is not one reached PostgreSQL as `22P02`
     * and answered 500 — a malformed request reported as a platform failure. The reference is
     * resolved against the column as text first, which also accepts the slug and the entry key the
     * rest of the console uses, and answers 422 when nothing matches.
     */
    const instanceId = await this.resolveInstance(request.instanceId);
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO maintenance_window (scope, instance_id, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [scope, instanceId, bounds.startsAt, bounds.endsAt, actorId],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw internal('The maintenance window was not created.');
    await this.audit.append({
      action: 'maintenance.window.created',
      actorType: 'user',
      actorId,
      targetType: 'maintenance_window',
      targetId: id,
      outcome: 'success',
      detail: {
        scope,
        instanceId,
        startsAt: bounds.startsAt,
        endsAt: bounds.endsAt,
        suppressesAlerts: true,
      },
    });
    return this.window(id);
  }

  async patchWindow(
    id: string,
    patch: MaintenanceWindowPatchRequest,
    actorId: string,
  ): Promise<MaintenanceWindow> {
    if (!isUuid(id)) throw noWindow(id);
    const current = await this.window(id);
    const bounds = this.windowBounds(
      patch.startsAt ?? current.startsAt,
      patch.endsAt ?? current.endsAt,
    );
    const result = await this.pool.query(
      `UPDATE maintenance_window SET starts_at = $2, ends_at = $3 WHERE id = $1 AND cancelled_at IS NULL`,
      [id, bounds.startsAt, bounds.endsAt],
    );
    /* The window may have been cancelled between the read and the write; reporting the unchanged
       row as an update would tell the operator their edit landed. */
    if (result.rowCount === 0) throw stateConflict('cancelled', 'edit');
    await this.audit.append({
      action: 'maintenance.window.updated',
      actorType: 'user',
      actorId,
      targetType: 'maintenance_window',
      targetId: id,
      outcome: 'success',
      detail: { startsAt: bounds.startsAt, endsAt: bounds.endsAt },
    });
    return this.window(id);
  }

  /** Cancelled, not deleted: a window that suppressed alerts must remain explainable. */
  async cancelWindow(id: string, actorId: string): Promise<void> {
    if (!isUuid(id)) throw noWindow(id);
    const result = await this.pool.query(
      `UPDATE maintenance_window SET cancelled_at = now() WHERE id = $1 AND cancelled_at IS NULL`,
      [id],
    );
    if (result.rowCount === 0) throw noWindow(id);
    await this.audit.append({
      action: 'maintenance.window.cancelled',
      actorType: 'user',
      actorId,
      targetType: 'maintenance_window',
      targetId: id,
      outcome: 'success',
      // Cancelling is how suppression stops early; the reason belongs in the chain.
      detail: { suppressionEnded: true },
    });
  }

  // ---- audit range verification (CL-11) --------------------------------------------------------

  async verifyAuditRange(fromSeq: number, toSeq: number): Promise<AuditRangeVerification> {
    if (toSeq < fromSeq) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'toSeq must be greater than or equal to fromSeq.',
      });
    }
    const result = await this.audit.verify(String(fromSeq), String(toSeq));
    return {
      fromSeq,
      toSeq,
      valid: result.valid,
      firstBrokenSeq: result.firstBrokenSeq === null ? null : Number(result.firstBrokenSeq),
      checked: result.checked,
      verifiedAt: new Date().toISOString(),
    };
  }

  // ---- DSAR -----------------------------------------------------------------------------------

  /**
   * Opens a request and snapshots the scopes it will walk.
   *
   * The snapshot is the point: `personal_data_map` says where a subject's data lives *today*, while
   * the request must stay explainable for the 30 days it is open. The platform tier is always part
   * of that list (4F.4), so an unmapped product can never shrink a request to nothing.
   */
  async openDsar(
    input: { subjectRef: string; kind: 'export' | 'delete' },
    actorId: string,
  ): Promise<PrivacyRequest> {
    // NFR-4.13: the platform never stores the subject identifier, only its pseudonym. The contract
    // already refuses a name or an address; hashing what remains keeps the platform one step away
    // from the identifier even when an operator pastes the wrong thing.
    const subjectRef = createHash('sha256').update(input.subjectRef).digest('hex');
    const scopes = await this.privacy.catalogue(input.kind);

    await this.pool.query(
      `INSERT INTO subject_ref (subject_ref) VALUES ($1) ON CONFLICT DO NOTHING`,
      [subjectRef],
    );
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO dsar_request (subject_ref, kind, state, opened_by, scopes)
       VALUES ($1, $2, 'open', $3, $4::jsonb) RETURNING id`,
      [subjectRef, input.kind, actorId, JSON.stringify(scopes)],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw internal('The request was not created.');
    await this.audit.append({
      action: 'privacy.request.opened',
      actorType: 'user',
      actorId,
      targetType: 'dsar_request',
      targetId: id,
      outcome: 'success',
      detail: { kind: input.kind, scopes: scopes.length },
    });
    return this.privacy.byId(id);
  }

  /**
   * Advances exactly one scope and records which one.
   *
   * Completion is a property of the scope list, not of a counter: the request closes when every
   * scope is complete. The last step of an erasure performs the act itself — deleting the
   * `subject_ref` mapping, because keeping the mapping is keeping the personal data — while the
   * audit chain keeps only the opaque reference (inv. 6).
   */
  async advanceDsar(id: string, actorId: string): Promise<PrivacyRequest> {
    const current = await this.privacy.byId(id);
    if (current.state === 'complete' || current.state === 'failed') {
      throw stateConflict(current.state, 'advance');
    }

    const next = current.scopes.find((scope) => scope.state !== 'complete');
    const scopes = current.scopes.map((scope) =>
      next !== undefined && scope.scopeId === next.scopeId
        ? { ...scope, state: 'complete' as const }
        : scope,
    );
    const done = scopes.length > 0 && scopes.every((scope) => scope.state === 'complete');
    const steps = [
      ...current.evidence,
      next === undefined
        ? 'No scope was outstanding; the request was closed'
        : `${next.label} · ${next.scopeType} ${next.scopeId} complete`,
      ...(done ? ['Every scope complete; outcome recorded'] : []),
    ];
    const evidence = JSON.stringify({ steps });
    const progress = JSON.stringify(
      scopes.map((scope) => ({ scopeId: scope.scopeId, state: scope.state, detail: scope.detail })),
    );
    const action = done
      ? current.kind === 'delete'
        ? 'privacy.erasure.completed'
        : 'privacy.export.completed'
      : 'privacy.request.advanced';
    const detail = { scopeId: next?.scopeId ?? null, scopeType: next?.scopeType ?? null, done };

    if (done && current.kind === 'delete') {
      const mapping = await this.pool.query<{ subject_ref: string | null }>(
        `SELECT subject_ref FROM dsar_request WHERE id = $1`,
        [id],
      );
      const subjectRef = mapping.rows[0]?.subject_ref ?? null;
      await withTransaction(this.pool, async (tx) => {
        await this.audit.lockChain(tx);
        await tx.query(
          `UPDATE dsar_request SET state = 'completed', closed_at = now(), evidence = $2::jsonb, scope_progress = $3::jsonb WHERE id = $1`,
          [id, evidence, progress],
        );
        // `dsar_request.subject_ref` is ON DELETE SET NULL: the request survives the erasure and
        // reports the subject as erased, which is the honest record of what happened.
        if (subjectRef !== null) {
          await tx.query(`DELETE FROM subject_ref WHERE subject_ref = $1`, [subjectRef]);
        }
        await this.audit.append(
          {
            action,
            actorType: 'user',
            actorId,
            targetType: 'dsar_request',
            targetId: id,
            outcome: 'success',
            detail: { ...detail, subjectRef },
          },
          tx,
        );
      });
    } else {
      await this.pool.query(
        `UPDATE dsar_request
            SET state = $2,
                evidence = $3::jsonb,
                scope_progress = $4::jsonb,
                closed_at = CASE WHEN $2 = 'completed' THEN now() ELSE closed_at END
          WHERE id = $1`,
        [id, done ? 'completed' : 'in_progress', evidence, progress],
      );
      await this.audit.append({
        action,
        actorType: 'user',
        actorId,
        targetType: 'dsar_request',
        targetId: id,
        outcome: 'success',
        detail,
      });
    }

    return this.privacy.byId(id);
  }

  // ---- reads used by the response shapes -------------------------------------------------------

  private async breakGlass(id: string): Promise<BreakGlassSession> {
    const result = await this.pool.query<{
      id: string;
      requester: string;
      instance_id: string | null;
      access_mode: string;
      state: string;
      justification: string;
      approver: string | null;
      self_approved: boolean;
      created_at: Date;
      granted_at: Date | null;
      expires_at: Date | null;
      revoked_at: Date | null;
      created_accounts: unknown[];
      retention_reason: string | null;
      product: string | null;
      requester_name: string;
      approver_name: string | null;
    }>(
      /* The same product label the list uses: a UUID in this field made the POST response disagree
         with the row the screen then rendered. */
      `SELECT b.*, coalesce(i.payload->>'product', i.entry_key) AS product,
              coalesce(ru.display_name, ru.username, b.requester) AS requester_name,
              CASE WHEN b.approver IS NULL THEN NULL
                   ELSE coalesce(au.display_name, au.username, b.approver) END AS approver_name
         FROM break_glass_session b
         LEFT JOIN instance i ON i.id = b.instance_id
         LEFT JOIN idp_user ru ON ru.idp_id = b.requester
         LEFT JOIN idp_user au ON au.idp_id = b.approver
        WHERE b.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new AppError({ code: 'NOT_FOUND', detail: `No break-glass session ${id}.` });
    return {
      id: row.id,
      requester: { id: row.requester, name: row.requester_name },
      instanceId: row.instance_id ?? '',
      product: row.product ?? 'Platform',
      // The owner relation is not recorded on the elevation; `approver` is not the owner.
      domainOwner: 'Platform',
      accessMode: row.access_mode as BreakGlassSession['accessMode'],
      justification: row.justification,
      approver: row.approver_name,
      selfApproved: row.self_approved,
      state: breakGlassStateAt(row.state as BreakGlassSession['state'], row.expires_at),
      requestedAt: row.created_at.toISOString(),
      grantedAt: row.granted_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      createdAccounts: Array.isArray(row.created_accounts) ? row.created_accounts.length : 0,
      retentionReason: row.retention_reason,
    };
  }

  /** The same select and mapper the list uses, so the write answer cannot disagree with the list. */
  private async window(id: string): Promise<MaintenanceWindow> {
    const result = await this.pool.query<MaintenanceWindowRow>(
      `${MAINTENANCE_WINDOW_SELECT} WHERE m.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw noWindow(id);
    return toMaintenanceWindow(row);
  }

  private async revokeProductAccounts(sessionId: string, tx?: Queryable): Promise<void> {
    // The accounts are recorded as JSON; revocation is the platform's record plus the product call,
    // and the record is what makes an orphan visible if the product call fails. `tx` is passed so
    // the record lands in the transaction that moved the state, not a second connection that would
    // commit (or fail) independently of it.
    await (tx ?? this.pool).query(
      `UPDATE break_glass_session SET retention_reason = COALESCE(retention_reason, 'accounts revoked on expiry') WHERE id = $1`,
      [sessionId],
    );
  }

  /**
   * NFR-3.9: the duration is a platform setting. It was hardcoded to 60 minutes, so the value an
   * administrator saved in `settings` had no effect on any elevation the platform granted.
   *
   * The expiry is measured from the caller's grant instant, not from whenever this resolves.
   * Re-reading the clock here made the window depend on how long the `settings` read took, so a
   * 60-minute grant was stored as 60 minutes and a few milliseconds.
   */
  private async breakGlassExpiry(tx?: Queryable, grantedAt: Date = new Date()): Promise<Date> {
    const minutes = await this.breakGlassMaxMinutes(tx);
    return new Date(grantedAt.getTime() + minutes * 60 * 1_000);
  }

  private async breakGlassMaxMinutes(tx?: Queryable): Promise<number> {
    try {
      // `tx` when the caller is already in a transaction: a `settings` read on a second connection
      // inside one is the pool deadlock this codebase has already paid for once.
      const result = await (tx ?? this.pool).query<{ value: unknown }>(
        `SELECT value FROM settings WHERE key = 'break_glass_max_minutes'`,
      );
      const value = result.rows[0]?.value;
      // `jsonb` returns a parsed number; a string means a hand-edited row, which is still honoured.
      const minutes = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60) return minutes;
    } catch {
      // A missing settings table must not stop a recovery path; the documented default applies.
    }
    return DEFAULT_BREAK_GLASS_MINUTES;
  }

  private assertWindowOrder(startsAt: string, endsAt: string): void {
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'A window must end after it starts.',
        remediation: 'Correct the end time.',
      });
    }
  }

  /**
   * Both ends as instants, with the order check that already existed.
   *
   * `Date.parse` answers `NaN` for a string it cannot read, and every comparison with `NaN` is
   * false — so `assertWindowOrder` passed unparseable timestamps straight to the column and the
   * operator got a 500 or a window in the wrong decade.
   */
  private windowBounds(startsAt: string, endsAt: string): { startsAt: Date; endsAt: Date } {
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'Both ends of a maintenance window must be instants.',
        remediation: 'Send an ISO-8601 UTC timestamp, for example 2026-11-05T10:00:00Z.',
        fieldErrors: [
          ...(Number.isNaN(start.getTime())
            ? [{ field: 'startsAt', code: 'invalid', message: 'Not an instant.' }]
            : []),
          ...(Number.isNaN(end.getTime())
            ? [{ field: 'endsAt', code: 'invalid', message: 'Not an instant.' }]
            : []),
        ],
      });
    }
    this.assertWindowOrder(start.toISOString(), end.toISOString());
    return { startsAt: start, endsAt: end };
  }

  /** An unknown or malformed instance reference is the caller's mistake, not a platform failure. */
  private async resolveInstance(reference: string | null | undefined): Promise<string | null> {
    const wanted = reference?.trim() ?? '';
    if (wanted.length === 0) return null;
    const found = await this.pool.query<{ id: string }>(
      `SELECT id FROM instance WHERE id::text = $1 OR slug = $1 OR entry_key = $1 LIMIT 1`,
      [wanted],
    );
    const id = found.rows[0]?.id;
    if (id === undefined) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `No deployed instance matches "${wanted}".`,
        remediation:
          'Choose an instance from the list, or leave it empty for a platform-wide window.',
        fieldErrors: [
          { field: 'instanceId', code: 'unknown', message: 'Instance does not exist.' },
        ],
      });
    }
    return id;
  }
}

function stateConflict(state: string, action: string): AppError {
  return new AppError({
    code: 'STATE_CONFLICT',
    detail: `Cannot ${action} a record in state "${state}".`,
    remediation: 'Refresh the record; the action may have been taken already.',
  });
}

function noWindow(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No live maintenance window ${id}.`,
    remediation: 'Refresh the list; a cancelled window stays in the record and cannot be changed.',
  });
}

function noPolicyException(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No policy exception ${id}.`,
    remediation: 'Refresh the queue; the exception may have been withdrawn.',
  });
}

function internal(detail: string): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    detail,
    remediation: 'Retry; nothing was changed.',
  });
}
