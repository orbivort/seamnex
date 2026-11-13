import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { SYNC_STATE_BY_GUARANTEE_CLASS, type SyncRun } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import {
  IDENTITY_PROVIDER,
  type IdentityProvider,
} from '../../common/identity/identity-provider.contract';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SESSION_SERVICE, type SessionService } from '../m10-portal-bff/session.contract';

/**
 * Deliverable 3.6 — the identity sync worker.
 *
 * It is a process role, not a timer inside the API: `main-sync-worker.ts` starts this service and a
 * second replica cannot double-run by accident (the manual endpoint refuses while a cycle runs).
 *
 * Invariants it encodes:
 *   - `group_mapping` is never written here (invariant 10); the worker only reads it.
 *   - the bindings it derives from a membership are reconciled, not appended: a mapping that
 *     changes and a membership that ends both withdraw the authority they used to grant, and the
 *     entitlements those bindings produced leave the launcher with them.
 *   - every entitlement carries the sync state its guarantee class allows
 *     (`packages/domain/src/propagation.ts`), so "applied" is never claimed for a native product.
 *   - a user that becomes disabled loses every session; the kill happens after the transaction.
 *   - latency is measured per mirrored user and stored as `p95_latency_ms` (AC-11/AC-12).
 */
@Injectable()
export class SyncWorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger('identity-sync');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
  ) {}

  /** Started by the `sync-worker` role. The first cycle runs immediately so a boot is observable. */
  start(): void {
    if (this.timer !== undefined) return;
    void this.runOnce('bootstrap').catch((error: unknown) => {
      this.logger.error(`bootstrap sync failed (${String(error)})`);
    });
    this.timer = setInterval(() => {
      void this.runOnce('interval').catch((error: unknown) => {
        this.logger.error(`scheduled sync failed (${String(error)})`);
      });
    }, this.config.SEAMNEX_SYNC_INTERVAL_MS);
    this.timer.unref();
    this.logger.log({
      msg: 'sync worker started',
      intervalMs: this.config.SEAMNEX_SYNC_INTERVAL_MS,
    });
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  async runOnce(trigger: 'interval' | 'manual' | 'bootstrap'): Promise<SyncRun> {
    if (this.running) {
      throw new Error('an identity sync cycle is already running');
    }
    this.running = true;

    const started = Date.now();
    const inserted = await this.pool.query<{ id: string; started_at: Date }>(
      `INSERT INTO sync_run (detail) VALUES ($1::jsonb) RETURNING id, started_at`,
      [JSON.stringify({ trigger })],
    );
    const run = inserted.rows[0];
    if (run === undefined) throw new Error('sync_run insert returned no row');

    const errors: string[] = [];
    const samples: number[] = [];
    let changes = 0;
    let users = 0;
    let groups = 0;

    try {
      const snapshot = await this.provider.directory();
      users = snapshot.users.length;
      groups = snapshot.groups.length;

      // Detect newly disabled accounts before the mirror overwrites `enabled`.
      const previouslyEnabled = await this.pool.query<{ idp_id: string }>(
        `SELECT idp_id FROM idp_user WHERE enabled`,
      );
      const enabledBefore = new Set(previouslyEnabled.rows.map((row) => row.idp_id));

      for (const user of snapshot.users) {
        const t0 = performance.now();
        const mirrored = await this.pool.query<{ inserted: boolean }>(
          `INSERT INTO idp_user (idp_id, username, email, display_name, enabled, mfa_enrolled, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (idp_id) DO UPDATE
             SET username = EXCLUDED.username,
                 email = EXCLUDED.email,
                 display_name = EXCLUDED.display_name,
                 enabled = EXCLUDED.enabled,
                 mfa_enrolled = EXCLUDED.mfa_enrolled,
                 updated_at = now()
             WHERE (idp_user.username, idp_user.email, idp_user.display_name, idp_user.enabled, idp_user.mfa_enrolled)
               IS DISTINCT FROM (EXCLUDED.username, EXCLUDED.email, EXCLUDED.display_name, EXCLUDED.enabled, EXCLUDED.mfa_enrolled)
           RETURNING (xmax = 0) AS inserted`,
          [user.sub, user.username, user.email, user.displayName, user.enabled, user.mfaEnrolled],
        );
        samples.push(performance.now() - t0);
        if (mirrored.rowCount === 1) changes += 1;
      }

      for (const group of snapshot.groups) {
        const mirrored = await this.pool.query(
          `INSERT INTO idp_group (idp_id, path, member_count, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (idp_id) DO UPDATE
             SET path = EXCLUDED.path, member_count = EXCLUDED.member_count, updated_at = now()
             WHERE (idp_group.path, idp_group.member_count) IS DISTINCT FROM (EXCLUDED.path, EXCLUDED.member_count)`,
          [group.id, group.path, group.members.length],
        );
        if (mirrored.rowCount === 1) changes += 1;
      }

      /*
       * The mirror converges; it does not accumulate.
       *
       * A group deleted in the directory stayed in `idp_group` for ever, so the console listed three
       * groups the realm no longer had and the membership mirror kept rows the directory had
       * revoked. Only rows the directory can no longer vouch for are removed, and a group that still
       * carries a durable mapping is the exception: that row is an administrator's decision, not
       * mirror state, so it is kept and named in `errors` instead of being deleted silently.
       *
       * An empty group list is treated as a failed read rather than an empty directory: deleting
       * every group on a provider fault would take the mappings with it.
       */
      if (snapshot.groups.length > 0) {
        const groupIds = snapshot.groups.map((group) => group.id);
        const stale = await this.pool.query<{ idp_id: string; path: string; mapped: boolean }>(
          `SELECT g.idp_id, g.path,
                  EXISTS (SELECT 1 FROM group_mapping gm WHERE gm.group_idp_id = g.idp_id) AS mapped
             FROM idp_group g
            WHERE g.idp_id <> ALL ($1::text[])`,
          [groupIds],
        );
        const removable = stale.rows.filter((row) => !row.mapped).map((row) => row.idp_id);
        if (removable.length > 0) {
          const deleted = await this.pool.query(
            `DELETE FROM idp_group WHERE idp_id = ANY ($1::text[])`,
            [removable],
          );
          changes += deleted.rowCount ?? 0;
        }
        for (const row of stale.rows.filter((entry) => entry.mapped)) {
          errors.push(
            `${row.path} is no longer in the directory but still carries a durable mapping; the group ` +
              'row was kept so the mapping is not deleted silently. Remove the mapping to retire the group.',
          );
        }
      }

      /*
       * The membership mirror, and it comes before the bindings that are derived from it.
       *
       * Membership used to be read here, joined against `group_mapping` to mint bindings and then
       * dropped, so nothing could answer "which groups is this person in": `/admin/users` had no
       * source and rendered an empty Groups column for every account. It is mirrored state, like
       * `idp_user`, and is reconciled by difference so an unchanged directory reports no change.
       */
      const memberships = snapshot.groups.flatMap((group) =>
        group.members.map((sub) => ({ sub, group_idp_id: group.id })),
      );
      const membershipJson = JSON.stringify(memberships);
      const removedMemberships = await this.pool.query(
        `DELETE FROM idp_group_member m
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS x(sub text, group_idp_id text)
             WHERE x.group_idp_id = m.group_idp_id AND x.sub = m.subject_idp_id)`,
        [membershipJson],
      );
      const addedMemberships = await this.pool.query(
        // Both sides are joined so a membership for a subject or group that has not been mirrored
        // (a removal mid-page) is skipped rather than failing the whole cycle on a foreign key.
        `INSERT INTO idp_group_member (group_idp_id, subject_idp_id)
         SELECT x.group_idp_id, x.sub
           FROM jsonb_to_recordset($1::jsonb) AS x(sub text, group_idp_id text)
           JOIN idp_user u ON u.idp_id = x.sub
           JOIN idp_group g ON g.idp_id = x.group_idp_id
         ON CONFLICT DO NOTHING`,
        [membershipJson],
      );
      changes += (removedMemberships.rowCount ?? 0) + (addedMemberships.rowCount ?? 0);

      /*
       * Bindings are derived state, so they are reconciled — not appended to.
       *
       * The insert below only ever added: changing a group's mapping (or removing a subject from
       * the group) left the previous binding in place, so a re-map granted the new role and kept
       * the old one — the "change" on `/admin/groups` was contradicted by the subject's own record,
       * and a mapping moved to a narrower role revoked nothing. Bindings the platform minted
       * (`granted_by = 'sync'`) are withdrawn as soon as no current membership × mapping pair
       * supports them; seed and administrator grants are never touched.
       *
       * Guarded by the same "an empty group list is a failed read" rule as the group mirror above:
       * a provider fault must not empty every sync-granted role on the platform.
       */
      if (snapshot.groups.length > 0) {
        const withdrawn = await this.pool.query(
          `DELETE FROM role_binding rb
            WHERE rb.granted_by = 'sync'
              AND NOT EXISTS (
                SELECT 1
                  FROM jsonb_to_recordset($1::jsonb) AS m(sub text, group_idp_id text)
                  JOIN group_mapping gm ON gm.group_idp_id = m.group_idp_id
                  JOIN idp_user u ON u.idp_id = m.sub AND u.enabled
                 WHERE rb.subject_idp_id = m.sub
                   AND rb.role = gm.role
                   AND rb.scope_type = gm.scope_type
                   AND rb.scope_id IS NOT DISTINCT FROM gm.scope_id)`,
          [JSON.stringify(memberships)],
        );
        changes += withdrawn.rowCount ?? 0;
      }

      /*
       * Bindings for enabled subjects only, de-duplicated by hand.
       *
       * `group_mapping` permits a platform grant with `scope_id = NULL`, and a unique index treats
       * NULLs as distinct — so `ON CONFLICT DO NOTHING` never fired for it and every cycle appended
       * another identical `role_binding`: a duplicated role in the console and a phantom "change"
       * every five minutes. The NOT EXISTS guard compares the scope with IS NOT DISTINCT FROM.
       */
      const bindings = await this.pool.query(
        `INSERT INTO role_binding (subject_idp_id, role, scope_type, scope_id, granted_by)
         SELECT m.sub, gm.role, gm.scope_type, gm.scope_id, 'sync'
           FROM jsonb_to_recordset($1::jsonb) AS m(sub text, group_idp_id text)
           JOIN group_mapping gm ON gm.group_idp_id = m.group_idp_id
           JOIN idp_user u ON u.idp_id = m.sub AND u.enabled
          WHERE NOT EXISTS (
            SELECT 1 FROM role_binding rb
             WHERE rb.subject_idp_id = m.sub
               AND rb.role = gm.role
               AND rb.scope_type = gm.scope_type
               AND rb.scope_id IS NOT DISTINCT FROM gm.scope_id)`,
        [JSON.stringify(memberships)],
      );
      changes += bindings.rowCount ?? 0;

      /*
       * One row per (subject, instance). The invariant trigger in migration 0009 refuses
       * `sync_state = 'unsupported'` unless the instance route says `fa_gate`, and the state here is
       * derived from the catalog guarantee class. When a route disagreed, the statement aborted —
       * and because it is a single statement, *no* subject got *any* entitlement, so a deployed
       * product never reached a launcher and the only trace was one line in `sync_run.errors`.
       * Conflicting instances are now excluded from the write and named instead, so the rest of the
       * platform keeps syncing while the defect is reported where an operator looks.
       */
      const conflicts = await this.pool.query<{
        slug: string;
        key: string;
        guarantee_class: string;
        auth_mode: string | null;
        blocking: boolean;
      }>(
        `SELECT i.slug, c.key, c.guarantee_class, r.auth_mode,
                -- Blocking: the state this class requires is one the invariant will refuse.
                (c.guarantee_class = 'fa_gate' AND r.auth_mode IS DISTINCT FROM 'fa_gate') AS blocking
           FROM instance i
           JOIN catalog_entry c ON c.key = i.entry_key
           LEFT JOIN instance_route r ON r.instance_id = i.id
          WHERE i.deleted_at IS NULL
            AND (CASE WHEN c.guarantee_class = 'fa_gate' THEN r.auth_mode IS DISTINCT FROM 'fa_gate'
                      ELSE r.auth_mode = 'fa_gate' END)`,
      );
      const conflicting = new Set(
        conflicts.rows.filter((row) => row.blocking).map((row) => row.slug),
      );
      for (const row of conflicts.rows) {
        errors.push(
          `${row.slug} (${row.key}): route authMode "${row.auth_mode ?? 'none'}" contradicts guaranteeClass ` +
            `"${row.guarantee_class}"${
              row.blocking
                ? '; its entitlements were skipped because the write would violate the sync-state invariant'
                : '; its entitlements were synced, but the portal will mislabel the sign-in path'
            }. Align the route with the catalog entry.`,
        );
      }

      const entitlements = await this.pool.query(
        `WITH guarantee(class, state) AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS g(class text, state text)
         )
         INSERT INTO entitlement (subject_idp_id, instance_id, product_role, source, sync_state, synced_at)
         SELECT rb.subject_idp_id, i.id, 'member', 'group',
                COALESCE(g.state, 'unsupported'), now()
           FROM role_binding rb
           JOIN instance i ON i.deleted_at IS NULL
           JOIN catalog_entry c ON c.key = i.entry_key
           LEFT JOIN guarantee g ON g.class = c.guarantee_class
          WHERE (rb.scope_type = 'platform'
             OR (rb.scope_type = 'domain' AND rb.scope_id = c.domain)
             OR (rb.scope_type = 'instance' AND rb.scope_id = i.id::text))
            AND NOT (i.slug = ANY ($2::text[]))
         ON CONFLICT (subject_idp_id, instance_id, product_role) DO UPDATE
           SET sync_state = EXCLUDED.sync_state, synced_at = now()
           WHERE entitlement.sync_state IS DISTINCT FROM EXCLUDED.sync_state`,
        [
          JSON.stringify(
            Object.entries(SYNC_STATE_BY_GUARANTEE_CLASS).map(([guaranteeClass, state]) => ({
              class: guaranteeClass,
              state,
            })),
          ),
          [...conflicting],
        ],
      );
      changes += entitlements.rowCount ?? 0;

      /*
       * Entitlements are derived from the bindings reconciled above, so they converge too.
       *
       * A mapping moved to a narrower scope withdrew the role and left the products it had granted
       * in the subject's launcher for ever — the access a mapping change was supposed to remove
       * outlived it, and no cycle ever looked. Only rows the sync minted (`source = 'group'`) are
       * considered, and only when no current binding covers that instance: a `direct` grant made by
       * an approved access request is a decision, not derived state, and is never withdrawn here.
       */
      const withdrawnEntitlements = await this.pool.query(
        `DELETE FROM entitlement e
           USING instance i
           JOIN catalog_entry c ON c.key = i.entry_key
          WHERE e.instance_id = i.id
            AND e.source = 'group'
            AND NOT EXISTS (
              SELECT 1 FROM role_binding rb
               WHERE rb.subject_idp_id = e.subject_idp_id
                 AND (rb.scope_type = 'platform'
                   OR (rb.scope_type = 'domain' AND rb.scope_id = c.domain)
                   OR (rb.scope_type = 'instance' AND rb.scope_id = i.id::text)))`,
      );
      changes += withdrawnEntitlements.rowCount ?? 0;

      // Session kill after the mirror commits: a disable is only effective once the directory says
      // so, and a failed kill is reported rather than rolled back (the account stays disabled).
      const newlyDisabled = snapshot.users.filter(
        (user) => !user.enabled && enabledBefore.has(user.sub),
      );
      for (const user of newlyDisabled) {
        const killed = await this.sessions.killSubject(
          user.sub,
          'identity provider disabled the account',
        );
        this.logger.warn({ msg: 'disabled account sessions terminated', sub: user.sub, killed });
      }

      const p95 = percentile95(samples);
      const state = errors.length === 0 ? 'succeeded' : 'partial';
      const finishedAt = new Date();
      await this.pool.query(
        `UPDATE sync_run
            SET finished_at = now(), changes = $2, p95_latency_ms = $3, errors = $4, detail = $5::jsonb
          WHERE id = $1`,
        [
          run.id,
          changes,
          p95,
          errors.length,
          // The outcome travels with the run: `errors > 0` alone cannot tell "two routes disagreed"
          // from "the directory was never read", and the evidence screen has to.
          JSON.stringify({ trigger, users, groups, errors, outcome: state }),
        ],
      );

      await this.audit
        .append({
          action: 'identity.sync.completed',
          actorType: 'system',
          actorId: 'sync-worker',
          targetType: 'sync_run',
          targetId: run.id,
          outcome: 'success',
          detail: { trigger, changes, users, groups, p95LatencyMs: p95 },
        })
        .catch((error: unknown) => {
          this.logger.error(`sync run could not be audited (${String(error)})`);
        });

      this.logger.log({
        msg: 'identity sync completed',
        runId: run.id,
        trigger,
        users,
        groups,
        changes,
        p95LatencyMs: p95,
        durationMs: Date.now() - started,
      });

      return {
        id: run.id,
        startedAt: run.started_at.toISOString(),
        finishedAt: finishedAt.toISOString(),
        users,
        groups,
        changes,
        p95LatencyMs: p95,
        errors,
        state,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      /*
       * The cycle aborted, so nothing was reconciled: the run is `failed`, not `partial`. Recording
       * that here is what stops a provider outage from being reported in the same caution tone as a
       * cycle that mirrored everyone and disagreed with one route.
       */
      await this.pool
        .query(
          `UPDATE sync_run SET finished_at = now(), errors = $2, detail = $3::jsonb WHERE id = $1`,
          [
            run.id,
            errors.length,
            JSON.stringify({ trigger, users, groups, errors, outcome: 'failed' }),
          ],
        )
        .catch(() => undefined);
      throw error;
    } finally {
      this.running = false;
    }
  }
}

/** Nearest-rank p95; an empty sample set is 0 rather than NaN. */
export function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Math.round(sorted[index] ?? 0);
}
