import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AccessRequest, IdpGroup, IdpUser, SyncRun } from '@seamnex/domain';
import type {
  AccessRequestDecision,
  AccessRequestView,
  DisableUserResponse,
  UserEntitlements,
} from './identity-sync.contract';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SESSION_SERVICE, type SessionService } from '../m10-portal-bff/session.contract';
import {
  PRODUCT_ACCOUNT_SERVICE,
  type ProductAccountService,
} from '../m24-sign-in-relay/relay.contract';
import {
  IDENTITY_PROVIDER,
  type IdentityProvider,
} from '../../common/identity/identity-provider.contract';
import { initialsOf } from '../../common/identity/initials';
import { AppError } from '../../common/problem/app-error';
import type { IdentitySyncService } from './identity-sync.contract';
import { SyncWorkerService } from './sync-worker.service';

const ROLE_SCOPE_LABEL: Record<string, string> = {
  platform: 'Platform',
  domain: 'Domain',
  instance: 'Instance',
};

/**
 * How many accounts one `/admin/users` response carries. The screen has search, not paging, so the
 * bound is a safety limit rather than a page size: an unbounded list is what turned one request into
 * three connections per person in the directory.
 */
const USERS_PAGE_LIMIT = 500;

/** The derived facts one `/admin` row needs, resolved for every row in at most three statements. */
type UserDetail = {
  roles: { role: string; scope_type: string; scope_id: string | null }[];
  entitlementCount: number;
  groups: string[];
};

/**
 * M08 — directory projections and the one durable write Phase 2 owns here.
 *
 * `idp_user`/`idp_group` carry the identity facts; the richer `/admin` shape (display name,
 * initials, role list, entitlement count) is derived per request rather than stored, because the
 * sync worker is the writer and it only mirrors what the IdP exposes (Phase 3 deliverable 3.6).
 */

@Injectable()
export class PostgresIdentitySyncService implements IdentitySyncService {
  private readonly logger = new Logger('m08-identity-sync');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    // Explicit token: no `emitDecoratorMetadata` at runtime (see `contract/route-table.ts`).
    @Inject(SyncWorkerService) private readonly worker: SyncWorkerService,
    /**
     * ADR-BE-22 — offboarding has to reach the product account, not only the platform's authority.
     * Optional: a graph without the relay still disables the user, and a deployment that never
     * provisioned a product account has nothing to remove.
     */
    @Optional()
    @Inject(PRODUCT_ACCOUNT_SERVICE)
    private readonly productAccounts?: ProductAccountService,
  ) {}

  async users(query?: string, after?: string): Promise<IdpUser[]> {
    const q = (query ?? '').toLowerCase();
    const cursor = (after ?? '').trim();
    /*
     * The filter matches what the screen offers to search — "name or e-mail" — and the display name
     * is the name a person reads: the mirror stores it as free text (`Sofia Almeida` from the
     * provider's first/last name), so a search for "Sofia" has to hit it, not only the login name.
     *
     * `LIMIT` and the batched detail query below are one fix: the list used to read every row and
     * then fire three queries per row in a single `Promise.all`, so a thousand-person directory
     * asked for three thousand connections from a ten-connection pool and every other request in
     * the process queued behind it.
     *
     * `$2` is a keyset cursor rather than an offset. `username` is the sort key and is unique — the
     * mirror holds a unique index on `lower(username)` — so a page boundary cannot skip or repeat a
     * row while a sync cycle is rewriting the table underneath the reader.
     */
    const result = await this.pool.query<UserRow>(
      `SELECT idp_id, username, email, display_name, enabled, mfa_enrolled, last_login_at, job_title, created_at, updated_at
         FROM idp_user
        WHERE ($1 = ''
               OR lower(username) LIKE '%' || $1 || '%'
               OR lower(coalesce(display_name,'')) LIKE '%' || $1 || '%'
               OR lower(coalesce(email,'')) LIKE '%' || $1 || '%')
          AND ($2 = '' OR username > $2)
        ORDER BY username
        LIMIT $3`,
      [q, cursor, USERS_PAGE_LIMIT],
    );
    /*
     * A full page may mean "the directory has more", and a caller that does not page would render it
     * as the whole directory. The warning is the only signal available without changing the response
     * shape, so it is written rather than leaving the truncation silent on the server too.
     */
    if (result.rows.length === USERS_PAGE_LIMIT) {
      this.logger.warn(
        `directory page reached the ${USERS_PAGE_LIMIT}-row cap; call again with ` +
          `after=${result.rows[result.rows.length - 1]?.username ?? ''} to continue`,
      );
    }
    const details = await this.userDetails(result.rows.map((row) => row.idp_id));
    return result.rows.map((row) => this.toUser(row, details.get(row.idp_id)));
  }

  async user(id: string): Promise<IdpUser> {
    const result = await this.pool.query<UserRow>(
      `SELECT idp_id, username, email, display_name, enabled, mfa_enrolled, last_login_at, job_title, created_at, updated_at
         FROM idp_user WHERE idp_id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound(id);
    const details = await this.userDetails([row.idp_id]);
    return this.toUser(row, details.get(row.idp_id));
  }

  async userEntitlements(id: string): Promise<UserEntitlements> {
    const result = await this.pool.query<{
      instance_id: string;
      entry_key: string;
      product: string;
      product_role: string;
      sync_state: string;
    }>(
      `SELECT e.instance_id, i.entry_key, coalesce(i.payload->>'product', i.entry_key) AS product,
              e.product_role, e.sync_state
         FROM entitlement e JOIN instance i ON i.id = e.instance_id
        WHERE e.subject_idp_id = $1 ORDER BY product`,
      [id],
    );
    return {
      userId: id,
      entitlements: result.rows.map((row) => ({
        instanceId: row.instance_id,
        product: row.product,
        entryKey: row.entry_key,
        productRole: row.product_role,
        syncState: row.sync_state,
      })),
    };
  }

  async groups(): Promise<IdpGroup[]> {
    const result = await this.pool.query<{
      idp_id: string;
      path: string;
      member_count: number;
      updated_at: Date;
    }>(`SELECT idp_id, path, member_count, updated_at FROM idp_group ORDER BY path`);
    const mappings = await this.pool.query<{
      group_idp_id: string;
      role: string;
      scope_type: string;
      scope_id: string | null;
      propagate_to_product: boolean;
      created_at: Date;
    }>(
      `SELECT group_idp_id, role, scope_type, scope_id, propagate_to_product, created_at
         FROM group_mapping`,
    );

    return result.rows.map((row) => {
      const mapping = mappings.rows.find((candidate) => candidate.group_idp_id === row.idp_id);
      /*
       * The row's "Updated" is the last time anything about this group changed, so a mapping
       * decision counts: the mirror timestamp alone left the console reporting the last sync
       * cycle after an administrator had just re-mapped the group, which reads as "nothing
       * happened" on the only screen that shows the decision.
       */
      const updatedAt =
        mapping !== undefined && mapping.created_at.getTime() > row.updated_at.getTime()
          ? mapping.created_at
          : row.updated_at;
      return {
        id: row.idp_id,
        path: row.path,
        displayName: row.path.split('/').filter(Boolean).pop() ?? row.path,
        description: `Directory group ${row.path}.`,
        memberCount: row.member_count,
        mapping:
          mapping === undefined
            ? null
            : {
                role: mapping.role as IdpGroup['mapping'] extends null
                  ? never
                  : NonNullable<IdpGroup['mapping']>['role'],
                scopeType: mapping.scope_type as NonNullable<IdpGroup['mapping']>['scopeType'],
                scopeId: mapping.scope_id,
                scopeLabel: mapping.scope_id ?? ROLE_SCOPE_LABEL[mapping.scope_type] ?? 'Platform',
                propagateToProduct: mapping.propagate_to_product,
              },
        updatedAt: updatedAt.toISOString(),
      };
    });
  }

  async mapGroup(
    groupId: string,
    request: { role: string; scopeType: string; scopeLabel: string; propagate: boolean },
    actorId: string,
  ): Promise<IdpGroup> {
    const scopeId = request.scopeType === 'platform' ? null : request.scopeLabel;
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      // Locking the group serialises two administrators saving the same group at once, so the
      // delete below cannot race a concurrent insert into a unique violation.
      const group = await tx.query(`SELECT 1 FROM idp_group WHERE idp_id = $1 FOR UPDATE`, [
        groupId,
      ]);
      if (group.rowCount === 0) throw notFound(groupId);
      /*
       * A group carries one mapping (FR-2.4, and the console says so on the row), so a change
       * replaces the stored decision instead of appending a second authority.
       *
       * The previous statement upserted on `(group, role, scope_type, scope_id)`, which is a
       * different tuple for every new role or scope: moving a group from R5 to R2 inserted a
       * second row, and `groups()` — which reads one mapping per group — kept returning the
       * older one. The save then looked ignored while the directory silently held two roles.
       * Deleting first is what makes this a change of the mapping rather than a new mapping;
       * migration 0021 makes the uniqueness a constraint so no other writer can recreate it.
       */
      const replaced = await tx.query<{
        role: string;
        scope_type: string;
        scope_id: string | null;
      }>(
        `DELETE FROM group_mapping WHERE group_idp_id = $1
         RETURNING role, scope_type, scope_id`,
        [groupId],
      );
      await tx.query(
        `INSERT INTO group_mapping (group_idp_id, role, scope_type, scope_id, propagate_to_product, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [groupId, request.role, request.scopeType, scopeId, request.propagate, actorId],
      );
      await this.audit.append(
        {
          action: 'group.mapping.updated',
          actorType: 'user',
          actorId,
          targetType: 'group',
          targetId: groupId,
          outcome: 'success',
          detail: {
            role: request.role,
            scopeType: request.scopeType,
            scopeLabel: request.scopeLabel,
            propagate: request.propagate,
            // What the change removed: an audit row that cannot say which authority was
            // withdrawn leaves the reviewer to guess.
            replaced: replaced.rows[0] ?? null,
          },
        },
        tx,
      );
    });

    const groups = await this.groups();
    const updated = groups.find((candidate) => candidate.id === groupId);
    if (updated === undefined) throw notFound(groupId);
    return updated;
  }

  async syncRuns(): Promise<SyncRun[]> {
    const result = await this.pool.query<{
      id: string;
      started_at: Date;
      finished_at: Date | null;
      changes: number;
      p95_latency_ms: number | null;
      errors: number;
      detail: Record<string, unknown>;
    }>(
      `SELECT id, started_at, finished_at, changes, p95_latency_ms, errors, detail FROM sync_run ORDER BY started_at DESC LIMIT 50`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at.toISOString(),
      finishedAt: (row.finished_at ?? row.started_at).toISOString(),
      users: typeof row.detail.users === 'number' ? row.detail.users : 0,
      groups: typeof row.detail.groups === 'number' ? row.detail.groups : 0,
      changes: row.changes,
      p95LatencyMs: row.p95_latency_ms ?? 0,
      errors: Array.isArray(row.detail.errors) ? (row.detail.errors as string[]) : [],
      state: runState(row.detail, row.errors),
    }));
  }

  async runSync(actorId: string): Promise<SyncRun> {
    this.assertActor(actorId);
    try {
      return await this.worker.runOnce('manual');
    } catch (error) {
      if (error instanceof Error && error.message.includes('already running')) {
        throw new AppError({
          code: 'STATE_CONFLICT',
          detail: 'An identity sync cycle is already running.',
          remediation: 'Wait for the current run to finish, then read GET /admin/identity-sync.',
        });
      }
      throw error;
    }
  }

  async disableUser(id: string, actorId: string): Promise<DisableUserResponse> {
    const existing = await this.pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM idp_user WHERE idp_id = $1`,
      [id],
    );
    const current = existing.rows[0];
    if (current === undefined) throw notFound(id);
    // A second disable is a state conflict, not a missing user: the row is right there.
    if (!current.enabled) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `Directory user ${id} is already disabled.`,
        remediation: 'Refresh the user list; only an enabled account can be disabled.',
      });
    }

    /*
     * The provider is the authority and the mirror is rebuilt from it on every sync cycle, so
     * writing `enabled = false` locally alone lasted until the next cycle — the console reported a
     * completed offboarding that the directory silently reversed. Fail closed: if the provider
     * refuses, nothing below runs and the caller is told the change was not applied.
     */
    await this.provider.setUserEnabled(id, false);

    const entitlements = await this.pool.query<{
      instance_id: string;
      product: string;
      sync_state: string;
    }>(
      `SELECT e.instance_id, c.product, e.sync_state
         FROM entitlement e
         JOIN instance i ON i.id = e.instance_id
         JOIN catalog_entry c ON c.key = i.entry_key
        WHERE e.subject_idp_id = $1
        ORDER BY c.product`,
      [id],
    );

    const disabledAt = await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const updated = await tx.query<{ updated_at: Date }>(
        `UPDATE idp_user SET enabled = false, updated_at = now()
          WHERE idp_id = $1 AND enabled
          RETURNING updated_at`,
        [id],
      );
      if (updated.rowCount === 0) throw notFound(id);

      // Revoke the platform-side authority first; the session kill below removes the credentials
      // that could still present it.
      await tx.query(`DELETE FROM role_binding WHERE subject_idp_id = $1`, [id]);
      await tx.query(`DELETE FROM entitlement WHERE subject_idp_id = $1`, [id]);
      await this.audit.append(
        {
          action: 'user.disabled',
          actorType: 'user',
          actorId,
          targetType: 'user',
          targetId: id,
          outcome: 'success',
          detail: {
            entitlements: entitlements.rowCount ?? 0,
            note: 'group_mapping untouched (invariant 10)',
          },
        },
        tx,
      );
      return updated.rows[0]?.updated_at ?? new Date();
    });

    /*
     * ADR-BE-22 — the product-side account is disabled and its platform-held credential removed
     * before the platform sessions go, so the attempt still has an actor to attribute it to. The
     * service never throws: the user is already disabled on the provider, and a product that cannot
     * be reached must not turn a completed offboarding into a failed request.
     */
    await this.productAccounts?.deprovision(id);

    const sessionsTerminated = await this.sessions.killSubject(id, 'user disabled');

    return {
      userId: id,
      disabledAt: disabledAt.toISOString(),
      sessionsTerminated,
      entitlements: entitlements.rows.map((row) => ({
        instanceId: row.instance_id,
        product: row.product,
        syncState: row.sync_state,
      })),
      propagationNote:
        'Sessions terminated and platform bindings removed. Product-side revocation follows the ' +
        'guarantee class of each instance: applied, pending, edge only or unsupported.',
    };
  }

  async accessRequests(): Promise<AccessRequest[]> {
    /**
     * The queue is read by a person, so it carries names and the owning domain, not the opaque
     * identifiers the row stores: `requester_idp_id` is a subject id and `target` is a catalog key
     * for an entitlement request. Resolving both here keeps every consumer honest — joining in the
     * console would have left the API returning identifiers under a field called "name".
     */
    const result = await this.pool.query<{
      id: string;
      requester_idp_id: string;
      kind: string;
      target: string;
      justification: string;
      state: string;
      created_at: Date;
      decided_by: string | null;
      decided_at: Date | null;
      requester_name: string | null;
      decider_name: string | null;
      domain: string | null;
    }>(`SELECT ar.id, ar.requester_idp_id, ar.kind, ar.target, ar.justification, ar.state,
               ar.created_at, ar.decided_by, ar.decided_at,
               coalesce(ru.display_name, ru.username) AS requester_name,
               coalesce(du.display_name, du.username) AS decider_name,
               ce.domain
          FROM access_request ar
          LEFT JOIN idp_user ru ON ru.idp_id = ar.requester_idp_id
          LEFT JOIN idp_user du ON du.idp_id = ar.decided_by
          LEFT JOIN catalog_entry ce ON ce.key = ar.target
         ORDER BY ar.created_at DESC`);
    return result.rows.map((row) => ({
      id: row.id,
      requester: { id: row.requester_idp_id, name: row.requester_name ?? row.requester_idp_id },
      kind: row.kind as AccessRequest['kind'],
      target: row.target,
      justification: row.justification,
      state: row.state as AccessRequest['state'],
      createdAt: row.created_at.toISOString(),
      // A decided row whose decider has left the directory still reports who decided it.
      decidedBy: row.decided_by === null ? null : (row.decider_name ?? row.decided_by),
      decidedAt: row.decided_at?.toISOString() ?? null,
      domain: row.domain ?? 'Platform',
    }));
  }

  async createAccessRequest(
    request: { entryKey: string; justification: string },
    requesterIdpId: string,
  ): Promise<AccessRequest> {
    const [entry, requester] = await Promise.all([
      this.pool.query<{ domain: string }>(`SELECT domain FROM catalog_entry WHERE key = $1`, [
        request.entryKey,
      ]),
      // The queue shows a person, not a subject identifier — the same reason the list joins here.
      this.pool.query<{ name: string | null }>(
        `SELECT coalesce(display_name, username) AS name FROM idp_user WHERE idp_id = $1`,
        [requesterIdpId],
      ),
    ]);
    if (entry.rowCount === 0) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No catalog entry ${request.entryKey}.`,
        remediation: 'Refresh the requestable list.',
      });
    }
    const inserted = await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const result = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO access_request (requester_idp_id, kind, target, justification, state)
         VALUES ($1, 'entitlement', $2, $3, 'open') RETURNING id, created_at`,
        [requesterIdpId, request.entryKey, request.justification],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('access_request insert returned no row');
      await this.audit.append(
        {
          action: 'access.requested',
          actorType: 'user',
          actorId: requesterIdpId,
          targetType: 'catalog_entry',
          targetId: request.entryKey,
          outcome: 'success',
          detail: { requestId: row.id },
        },
        tx,
      );
      return row;
    });

    return {
      id: inserted.id,
      requester: { id: requesterIdpId, name: requester.rows[0]?.name ?? requesterIdpId },
      kind: 'entitlement',
      target: request.entryKey,
      justification: request.justification,
      state: 'open',
      createdAt: inserted.created_at.toISOString(),
      decidedBy: null,
      decidedAt: null,
      domain: entry.rows[0]?.domain ?? 'Platform',
    };
  }

  async accessRequest(id: string): Promise<AccessRequestView> {
    const result = await this.pool.query<{
      requester_idp_id: string;
      kind: string;
      target: string;
      justification: string;
      state: string;
      created_at: Date;
    }>(
      `SELECT requester_idp_id, kind, target, justification, state, created_at
         FROM access_request WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No access request ${id}.`,
        remediation: 'Refresh the queue.',
      });
    }
    return {
      requesterIdpId: row.requester_idp_id,
      kind: row.kind,
      target: row.target,
      justification: row.justification,
      state: row.state,
      createdAt: row.created_at,
    };
  }

  /**
   * The row lock and the state transition, nothing else. Governance decides whether the request may
   * be decided at all (self-approval, capability) and records why — this only guarantees that two
   * concurrent deciders cannot both win.
   */
  async decideAccessRequest(
    tx: Queryable,
    input: { id: string; decision: 'approve' | 'reject'; actorId: string },
  ): Promise<AccessRequestDecision> {
    const current = await tx.query<{
      state: string;
      requester_idp_id: string;
      kind: string;
      target: string;
    }>(
      `SELECT state, requester_idp_id, kind, target FROM access_request WHERE id = $1 FOR UPDATE`,
      [input.id],
    );
    const row = current.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No access request ${input.id}.`,
        remediation: 'Refresh the queue.',
      });
    }
    if (row.state !== 'open') {
      throw new AppError({
        code: 'STATE_CONFLICT',
        status: 409,
        detail: `The access request is ${row.state} and cannot be ${input.decision}d.`,
        remediation: 'Refresh the queue; only an open request can be decided.',
      });
    }

    await tx.query(
      `UPDATE access_request SET state = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
      [input.id, input.decision === 'approve' ? 'approved' : 'rejected', input.actorId],
    );

    return { requesterIdpId: row.requester_idp_id, kind: row.kind, target: row.target };
  }

  private assertActor(actorId: string): void {
    if (actorId.length === 0) {
      throw new AppError({
        code: 'UNAUTHORIZED',
        detail: 'A sync run must be attributed to an actor.',
        remediation: 'Sign in and retry.',
      });
    }
  }

  /**
   * The three facts the `/admin` shape derives, for **all** the ids at once.
   *
   * Three statements instead of three per user, and every id gets an entry so a subject with no
   * roles, no entitlements and no groups still renders — absence is a real answer here, not a
   * missing key.
   */
  private async userDetails(ids: readonly string[]): Promise<Map<string, UserDetail>> {
    const details = new Map<string, UserDetail>(
      ids.map((id) => [id, { roles: [], entitlementCount: 0, groups: [] }]),
    );
    if (ids.length === 0) return details;

    const [roles, entitlements, groups] = await Promise.all([
      this.pool.query<{
        subject: string;
        role: string;
        scope_type: string;
        scope_id: string | null;
      }>(
        `SELECT subject_idp_id AS subject, role, scope_type, scope_id
           FROM role_binding WHERE subject_idp_id = ANY($1::text[])`,
        [ids],
      ),
      this.pool.query<{ subject: string; count: string }>(
        `SELECT subject_idp_id AS subject, count(*)::text AS count
           FROM entitlement WHERE subject_idp_id = ANY($1::text[])
          GROUP BY subject_idp_id`,
        [ids],
      ),
      /*
       * Membership, not a role proxy. The previous query joined `group_mapping` to the subject's
       * roles — that is "which groups grant the roles this person holds", a different question and
       * one that answers nothing while no mapping exists. `idp_group_member` is the mirrored fact.
       */
      this.pool.query<{ subject: string; path: string }>(
        `SELECT m.subject_idp_id AS subject, g.path
           FROM idp_group_member m
           JOIN idp_group g ON g.idp_id = m.group_idp_id
          WHERE m.subject_idp_id = ANY($1::text[])
          ORDER BY g.path`,
        [ids],
      ),
    ]);

    for (const row of roles.rows) details.get(row.subject)?.roles.push(row);
    for (const row of entitlements.rows) {
      const entry = details.get(row.subject);
      if (entry !== undefined) entry.entitlementCount = Number.parseInt(row.count, 10);
    }
    for (const row of groups.rows) details.get(row.subject)?.groups.push(row.path);
    return details;
  }

  private toUser(row: UserRow, detail: UserDetail | undefined): IdpUser {
    return {
      id: row.idp_id,
      username: row.username,
      displayName: row.display_name ?? row.username,
      email: row.email ?? `${row.username}@seamnex.local`,
      initials: initialsOf(row.display_name ?? row.username),
      enabled: row.enabled,
      groups: detail?.groups ?? [],
      roles: (detail?.roles ?? []).map((binding) => ({
        role: binding.role as IdpUser['roles'][number]['role'],
        scopeLabel: binding.scope_id ?? ROLE_SCOPE_LABEL[binding.scope_type] ?? 'Platform',
      })),
      entitlementCount: detail?.entitlementCount ?? 0,
      lastLoginAt: row.last_login_at?.toISOString() ?? null,
      /*
       * `created_at`, not `updated_at`. The mirror bumps `updated_at` whenever the provider
       * changes something, so the fallback re-dated every account on the evidence screen after a
       * sync cycle — and again on every disable.
       */
      createdAt: row.created_at.toISOString(),
      mfaEnrolled: row.mfa_enrolled,
      jobTitle: row.job_title ?? 'Platform member',
    };
  }
}

type UserRow = {
  idp_id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  enabled: boolean;
  mfa_enrolled: boolean;
  last_login_at: Date | null;
  job_title: string | null;
  created_at: Date;
  updated_at: Date;
};

function notFound(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No directory object ${id}.`,
    remediation: 'Refresh the directory.',
  });
}

/**
 * The run's own verdict, then the fallback for rows written before it was recorded.
 *
 * A cycle that threw left `errors = 1` behind and nothing else, so every aborted cycle — a Keycloak
 * 401 that mirrored nobody — was read back as `partial`, the note reserved for a cycle that
 * reconciled the directory and disagreed with one route. `detail.outcome` is written by the worker;
 * rows that predate it keep the old derivation, so the history does not change shape.
 */
function runState(detail: Record<string, unknown>, errorCount: number): SyncRun['state'] {
  const outcome = detail.outcome;
  if (outcome === 'succeeded' || outcome === 'partial' || outcome === 'failed') return outcome;
  return errorCount > 0 ? 'partial' : 'succeeded';
}
