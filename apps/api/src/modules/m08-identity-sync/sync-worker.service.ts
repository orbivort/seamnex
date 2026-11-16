import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { canApplyWithoutProductPush, type SyncRun } from '@seamnex/domain';
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
import { IDENTITY_PUSH, type IdentityPushPort } from './identity-push.contract';

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
    @Inject(IDENTITY_PUSH) private readonly push: IdentityPushPort,
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

      /*
       * The per-instance facts the entitlement state depends on, read once.
       *
       * `auth_mode` decides whether a native product already has the identity client the platform
       * configured, and `rolePush` declares whether the product accepts a role push at all. Both are
       * needed *before* the state is written: claiming `applied` for a native product with neither
       * was the defect ISSUE-20 records.
       */
      const plans = await this.pool.query<{
        instance_id: string;
        slug: string;
        guarantee_class: 'native' | 'fa_header' | 'fa_delegated' | 'fa_gate';
        auth_mode: string | null;
        push_path: string | null;
        push_role_field: string | null;
        push_secret_name: string | null;
        api_base_url: string | null;
      }>(
        `SELECT i.id AS instance_id, i.slug, c.guarantee_class, r.auth_mode,
                c.payload #>> '{integration,rolePush,path}' AS push_path,
                c.payload #>> '{integration,rolePush,roleField}' AS push_role_field,
                c.payload #>> '{integration,rolePush,secretName}' AS push_secret_name,
                c.payload #>> '{integration,apiBaseUrl}' AS api_base_url
           FROM instance i
           JOIN catalog_entry c ON c.key = i.entry_key
           LEFT JOIN instance_route r ON r.instance_id = i.id
          WHERE i.deleted_at IS NULL
            AND NOT (i.slug = ANY ($1::text[]))`,
        [[...conflicting]],
      );
      const plansById = new Map(plans.rows.map((row) => [row.instance_id, row]));

      /*
       * FR-2.4: the entitlement carries the mapping's product role, and `applied` is written only
       * where the platform has something to point at.
       *
       *   fa_gate      — the edge enforces access; the product never learns the grant → unsupported
       *   fa_delegated — the product keeps a local role record → pending until a cycle applies it
       *   native       — applied only with an OIDC/SAML client the platform configured, otherwise
       *                  pending until the entry's declared push succeeds
       *   fa_header    — the platform applies the identity per request → applied
       *
       * `applied_at` is set in the same statement as the state, so `applied` cannot outlive the
       * evidence that justified it: a state that drops back to pending clears the timestamp.
       */
      const entitlements = await this.pool.query<{
        subject_idp_id: string;
        instance_id: string;
        product_role: string;
        sync_state: string;
      }>(
        `WITH granted AS (
           SELECT m.sub AS subject_idp_id, i.id AS instance_id, gm.product_role
             FROM jsonb_to_recordset($1::jsonb) AS m(sub text, group_idp_id text)
             JOIN group_mapping gm ON gm.group_idp_id = m.group_idp_id
             JOIN idp_user u ON u.idp_id = m.sub AND u.enabled
             JOIN instance i ON i.deleted_at IS NULL
             JOIN catalog_entry c ON c.key = i.entry_key
            WHERE (gm.scope_type = 'platform'
               OR (gm.scope_type = 'domain' AND gm.scope_id = c.domain)
               OR (gm.scope_type = 'instance' AND gm.scope_id = i.id::text))
              AND NOT (i.slug = ANY ($2::text[]))
            GROUP BY m.sub, i.id, gm.product_role
         )
         INSERT INTO entitlement (subject_idp_id, instance_id, product_role, source, sync_state, synced_at, applied_at)
         SELECT g.subject_idp_id, g.instance_id, g.product_role, 'group', state.derived, now(),
                CASE WHEN state.derived = 'applied' THEN now() END
           FROM granted g
           JOIN instance i ON i.id = g.instance_id
           JOIN catalog_entry c ON c.key = i.entry_key
           LEFT JOIN instance_route r ON r.instance_id = i.id
           CROSS JOIN LATERAL (
             SELECT CASE
               WHEN c.guarantee_class = 'fa_gate' THEN 'unsupported'
               WHEN c.guarantee_class = 'fa_delegated' THEN 'pending'
               WHEN c.guarantee_class = 'native' AND r.auth_mode IN ('oidc', 'saml') THEN 'applied'
               WHEN c.guarantee_class = 'fa_header' THEN 'applied'
               ELSE 'pending'
             END AS derived
           ) state
         ON CONFLICT (subject_idp_id, instance_id, product_role) DO UPDATE
            SET sync_state = EXCLUDED.sync_state,
                synced_at = now(),
                applied_at = CASE WHEN EXCLUDED.sync_state = 'applied'
                                  THEN COALESCE(entitlement.applied_at, now())
                                  ELSE NULL END
          WHERE entitlement.source = 'group'
            AND entitlement.sync_state IS DISTINCT FROM EXCLUDED.sync_state
         RETURNING subject_idp_id, instance_id, product_role, sync_state`,
        [JSON.stringify(memberships), [...conflicting]],
      );
      changes += entitlements.rowCount ?? 0;

      /*
       * FR-2.4: apply the grants that are still pending because the product needs to be told.
       *
       * Only a `native` or `fa_header` product whose entry declared `rolePush`, whose mapping opted
       * into product propagation, and whose instance holds the named secret is a candidate. A push
       * that fails leaves the entitlement `pending` and records why; nothing is ever updated to
       * `applied` on the strength of having tried.
       */
      const changed: {
        subjectIdpId: string;
        instanceId: string;
        productRole: string;
        state: 'applied' | 'pending' | 'unsupported' | 'edge_only';
        reason: string | null;
      }[] = entitlements.rows.map((row) => ({
        subjectIdpId: row.subject_idp_id,
        instanceId: row.instance_id,
        productRole: row.product_role,
        state: row.sync_state as 'applied' | 'pending' | 'unsupported' | 'edge_only',
        reason: null,
      }));

      if (this.config.SEAMNEX_IDENTITY_PUSH_ENABLED) {
        const emails = new Map(snapshot.users.map((user) => [user.sub, user.email]));
        for (const entry of changed) {
          if (entry.state !== 'pending') continue;
          const plan = plansById.get(entry.instanceId);
          if (plan === undefined) continue;
          // One source of truth for "a push could still settle this grant" (`@seamnex/domain`).
          if (!canApplyWithoutProductPush(plan.guarantee_class)) continue;
          if (
            plan.guarantee_class === 'native' &&
            (plan.auth_mode === 'oidc' || plan.auth_mode === 'saml')
          ) {
            // The identity client already carries the group claim; there is nothing to push.
            continue;
          }
          if (
            plan.push_path === null ||
            plan.push_role_field === null ||
            plan.push_secret_name === null
          ) {
            entry.reason = `${plan.slug}: no role-push API is declared for this entry`;
            continue;
          }
          const pushed = await this.push.push({
            instanceId: entry.instanceId,
            slug: plan.slug,
            baseUrl: plan.api_base_url,
            path: plan.push_path,
            roleField: plan.push_role_field,
            secretName: plan.push_secret_name,
            subjectIdpId: entry.subjectIdpId,
            email: emails.get(entry.subjectIdpId) ?? entry.subjectIdpId,
            productRole: entry.productRole,
          });
          if (!pushed.ok) {
            entry.reason = `${plan.slug}: ${pushed.detail}`;
            continue;
          }
          await this.pool.query(
            `UPDATE entitlement
                SET sync_state = 'applied', applied_at = now(), synced_at = now()
              WHERE subject_idp_id = $1 AND instance_id = $2 AND product_role = $3`,
            [entry.subjectIdpId, entry.instanceId, entry.productRole],
          );
          entry.state = 'applied';
          changes += 1;
        }
      }

      /*
       * Entitlements are derived from the memberships and the mappings, so they converge too.
       *
       * A mapping moved to a narrower scope withdrew the role and left the products it had granted
       * in the subject's launcher for ever — the access a mapping change was supposed to remove
       * outlived it, and no cycle ever looked. The `product_role` is part of the check: a re-map to a
       * different product role is a *different* grant, so the old role must go with the old mapping.
       * Only rows the sync minted (`source = 'group'`) are considered; a `direct` grant made by an
       * approved access request is a decision, not derived state.
       */
      const withdrawnEntitlements = await this.pool.query(
        `DELETE FROM entitlement e
           USING instance i
           JOIN catalog_entry c ON c.key = i.entry_key
          WHERE e.instance_id = i.id
            AND e.source = 'group'
            AND NOT EXISTS (
              SELECT 1 FROM idp_group_member m
                JOIN group_mapping gm ON gm.group_idp_id = m.group_idp_id
                JOIN idp_user u ON u.idp_id = m.subject_idp_id AND u.enabled
               WHERE m.subject_idp_id = e.subject_idp_id
                 AND gm.product_role = e.product_role
                 AND (gm.scope_type = 'platform'
                   OR (gm.scope_type = 'domain' AND gm.scope_id = c.domain)
                   OR (gm.scope_type = 'instance' AND gm.scope_id = i.id::text)))`,
      );
      changes += withdrawnEntitlements.rowCount ?? 0;

      /*
       * AC-11/AC-48: record what changed, and when it changed relative to the membership.
       *
       * `detected_at` is the moment the mirror first observed the membership that produced this
       * grant. It is the closest fact the platform owns to "the directory changed"; the poll interval
       * bounds how late that observation can be, and the console states both.
       */
      const propagation = await this.recordPropagation(run.id, run.started_at, changed);

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

      /*
       * Two different numbers, and they are never mixed.
       *
       * `p95_latency_ms` is how long the directory upserts took — a mirror diagnostic.
       * `p95_propagation_ms` is the membership change → applied entitlement interval over the
       * changes *this run recorded*, which is the figure AC-48 asks for. `null` when no change was
       * measured: a run with nothing to measure cannot pass the five-minute target.
       */
      const mirrorP95 = percentile95(samples);
      const propagationSamples = propagation.latencies.length;
      const p95Propagation =
        propagationSamples === 0 ? null : Math.round(percentile95(propagation.latencies));
      const state = errors.length === 0 ? 'succeeded' : 'partial';
      const finishedAt = new Date();
      await this.pool.query(
        `UPDATE sync_run
            SET finished_at = now(), changes = $2, p95_latency_ms = $3, errors = $4,
                p95_propagation_ms = $5, propagation_samples = $6, detail = $7::jsonb
          WHERE id = $1`,
        [
          run.id,
          changes,
          mirrorP95,
          errors.length,
          p95Propagation,
          propagationSamples,
          // The outcome travels with the run: `errors > 0` alone cannot tell "two routes disagreed"
          // from "the directory was never read", and the evidence screen has to.
          JSON.stringify({
            trigger,
            users,
            groups,
            errors,
            outcome: state,
            // Pending grants are not errors — a product with no declared push API is a configuration
            // fact, not a failure. The count keeps them visible without turning every cycle partial.
            propagationPending: propagation.pending.length,
            propagationPendingReasons: propagation.pending.slice(0, 10),
          }),
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
          detail: {
            trigger,
            changes,
            users,
            groups,
            p95LatencyMs: mirrorP95,
            p95PropagationMs: p95Propagation,
            propagationSamples,
          },
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
        mirrorP95Ms: mirrorP95,
        p95PropagationMs: p95Propagation,
        propagationSamples,
        durationMs: Date.now() - started,
      });

      return {
        id: run.id,
        startedAt: run.started_at.toISOString(),
        finishedAt: finishedAt.toISOString(),
        users,
        groups,
        changes,
        p95LatencyMs: mirrorP95,
        p95PropagationMs: p95Propagation,
        propagationSamples,
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

  /**
   * AC-11/AC-48: one row per change, with the interval it took to reach the product.
   *
   * A change that did not propagate is recorded too — with no `applied_at` and no latency, plus the
   * reason — because "three grants are still pending, and here is why" is the evidence an operator
   * needs. Only applied changes contribute to the p95; counting a pending one as 0 ms would make the
   * target look met exactly when it is not.
   */
  private async recordPropagation(
    runId: string,
    startedAt: Date,
    changed: readonly {
      subjectIdpId: string;
      instanceId: string;
      productRole: string;
      state: 'applied' | 'pending' | 'unsupported' | 'edge_only';
      reason: string | null;
    }[],
  ): Promise<{ latencies: number[]; pending: string[] }> {
    if (changed.length === 0) return { latencies: [], pending: [] };

    await this.pool.query(
      `INSERT INTO propagation_sample
         (sync_run_id, subject_idp_id, instance_id, product_role, guarantee_class,
          detected_at, applied_at, latency_ms, outcome, reason)
       SELECT $1, c.subject, c.instance_id, c.product_role, ce.guarantee_class,
              COALESCE(detected.at, $2::timestamptz),
              CASE WHEN c.sync_state = 'applied' THEN now() END,
              CASE WHEN c.sync_state = 'applied'
                   THEN GREATEST(0, (EXTRACT(EPOCH FROM (now() - COALESCE(detected.at, $2::timestamptz))) * 1000)::int) END,
              c.sync_state,
              c.reason
         FROM jsonb_to_recordset($3::jsonb)
              AS c(subject text, instance_id uuid, product_role text, sync_state text, reason text)
         JOIN instance i ON i.id = c.instance_id
         JOIN catalog_entry ce ON ce.key = i.entry_key
         LEFT JOIN LATERAL (
           SELECT max(m.updated_at) AS at
             FROM idp_group_member m
             JOIN group_mapping gm ON gm.group_idp_id = m.group_idp_id
            WHERE m.subject_idp_id = c.subject
              AND gm.product_role = c.product_role
              AND (gm.scope_type = 'platform'
                OR (gm.scope_type = 'domain' AND gm.scope_id = ce.domain)
                OR (gm.scope_type = 'instance' AND gm.scope_id = c.instance_id::text))
         ) detected ON true`,
      [
        runId,
        startedAt,
        JSON.stringify(
          changed.map((entry) => ({
            subject: entry.subjectIdpId,
            instance_id: entry.instanceId,
            product_role: entry.productRole,
            sync_state: entry.state,
            reason: entry.reason,
          })),
        ),
      ],
    );

    const measured = await this.pool.query<{ latency_ms: number }>(
      `SELECT latency_ms FROM propagation_sample
        WHERE sync_run_id = $1 AND latency_ms IS NOT NULL`,
      [runId],
    );

    // Evidence, not history: a quarter of samples is enough to see a trend and small enough that the
    // table does not become the largest one in the database.
    await this.pool
      .query(`DELETE FROM propagation_sample WHERE created_at < now() - interval '30 days'`)
      .catch((error: unknown) => {
        this.logger.warn(`propagation samples could not be pruned (${String(error)})`);
      });

    return {
      latencies: measured.rows.map((row) => row.latency_ms),
      pending: changed
        .filter((entry) => entry.state !== 'applied')
        .map(
          (entry) =>
            `${entry.productRole} on ${entry.instanceId}: ${entry.reason ?? 'not applied yet'}`,
        ),
    };
  }
}

/** Nearest-rank p95; an empty sample set is 0 rather than NaN. */
export function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Math.round(sorted[index] ?? 0);
}
