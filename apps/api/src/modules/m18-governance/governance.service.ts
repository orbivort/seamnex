import { Inject, Injectable } from '@nestjs/common';
import { breakGlassStateAt, licenseTerms } from '@seamnex/domain';
import type {
  BreakGlassSession,
  DsarRequest,
  LicenseGate,
  LicenseRecord,
  MaintenanceWindow,
  PatchRecord,
  PolicyException,
  PostureSummary,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { AppError } from '../../common/problem/app-error';
import { isUuid } from '../../common/http/uuid';
import type { GovernanceService } from './governance.contract';
import {
  MAINTENANCE_WINDOW_SELECT,
  policyExceptionDiff,
  policyExceptionRequester,
  toMaintenanceWindow,
  type MaintenanceWindowRow,
} from './maintenance-window';

/** NFR-3.5: a passed restore drill is evidence for one quarter, not forever. */
const RESTORE_VALID_DAYS = 90;

/** M18 read surface plus the one pure-DB write (hosted-service gate). */

@Injectable()
export class PostgresGovernanceService implements GovernanceService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  /**
   * FR-1.14 / AC-44: one row per deployed instance.
   *
   * `license_record` holds the *review* (obligations, restriction flags, sign-off). The licence
   * identity belongs to the deployment and its catalog entry. Starting the query at
   * `license_record` meant a deployment nobody had reviewed yet was absent from the register
   * entirely — and a register that omits a deployment cannot gate it.
   */
  async licenses(): Promise<LicenseRecord[]> {
    const result = await this.pool.query<{
      instance_id: string;
      entry_key: string;
      product: string;
      license_id: string;
      obligations: unknown;
      recorded: boolean;
      resale_restricted: boolean;
      hosted_service_restricted: boolean;
      hosted_service_enabled: boolean;
      reviewed_by: string | null;
      reviewed_at: Date | null;
    }>(
      `SELECT i.id AS instance_id, i.entry_key,
              coalesce(i.payload->>'product', c.product, i.entry_key) AS product,
              coalesce(l.license_id, c.license_id, i.payload->>'licenseId', 'unreviewed') AS license_id,
              coalesce(l.obligations, '[]'::jsonb) AS obligations,
              (l.instance_id IS NOT NULL) AS recorded,
              coalesce(l.resale_restricted, false) AS resale_restricted,
              coalesce(l.hosted_service_restricted, false) AS hosted_service_restricted,
              coalesce(l.hosted_service_enabled, false) AS hosted_service_enabled,
              l.reviewed_by, l.reviewed_at
         FROM instance i
         LEFT JOIN catalog_entry c ON c.key = i.entry_key
         LEFT JOIN license_record l ON l.instance_id = i.id
        WHERE i.deleted_at IS NULL
        ORDER BY product`,
    );
    return result.rows.map((row) => {
      const terms = licenseTerms(row.license_id);
      // A review that exists is authoritative: a negotiated commercial licence may lift a default
      // restriction. Until one exists, the licence table supplies both the obligations and the
      // restriction flags, so the register states a term instead of an empty cell.
      const obligations = Array.isArray(row.obligations) ? (row.obligations as string[]) : [];
      return {
        instanceId: row.instance_id,
        entryKey: row.entry_key,
        product: row.product,
        licenseId: row.license_id,
        obligations: obligations.length > 0 ? obligations : [...(terms?.obligations ?? [])],
        resaleRestricted: row.recorded ? row.resale_restricted : (terms?.resaleRestricted ?? false),
        hostedServiceRestricted: row.recorded
          ? row.hosted_service_restricted
          : (terms?.hostedServiceRestricted ?? false),
        // The review is evidence: an unreviewed record reports no reviewer and no date rather than
        // a placeholder name and "today", which made an unreviewed licence look audited.
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at?.toISOString() ?? null,
        status: row.reviewed_at === null ? 'review_required' : 'cleared',
        hostedService: row.hosted_service_enabled,
      };
    });
  }

  /**
   * FR-1.14 / AC-44: the register is a release gate.
   *
   * Fails closed when the licence restricts resale or hosted-service provision, and when the
   * licence id is in neither the review record nor the licence table. The refusal names the
   * licence and is appended to the audit chain before it is thrown, because a refusal that leaves
   * no trail did not happen as far as governance is concerned.
   */
  async setHostedService(
    instanceId: string,
    enabled: boolean,
    actorId: string,
  ): Promise<LicenseGate> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const result = await this.pool.query<{
      entry_key: string;
      product: string;
      license_id: string | null;
      obligations: unknown;
      recorded: boolean;
      resale_restricted: boolean;
      hosted_service_restricted: boolean;
      hosted_service_enabled: boolean;
      reviewed_at: Date | null;
    }>(
      `SELECT i.entry_key,
              coalesce(i.payload->>'product', c.product, i.entry_key) AS product,
              coalesce(l.license_id, c.license_id, i.payload->>'licenseId') AS license_id,
              coalesce(l.obligations, '[]'::jsonb) AS obligations,
              (l.instance_id IS NOT NULL) AS recorded,
              coalesce(l.resale_restricted, false) AS resale_restricted,
              coalesce(l.hosted_service_restricted, false) AS hosted_service_restricted,
              coalesce(l.hosted_service_enabled, false) AS hosted_service_enabled,
              l.reviewed_at
         FROM instance i
         LEFT JOIN catalog_entry c ON c.key = i.entry_key
         LEFT JOIN license_record l ON l.instance_id = i.id
        WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound(instanceId);

    const licenseId = row.license_id ?? 'unreviewed';
    // Resale restriction and hosted-service restriction are two stated limits on the same act
    // (offering the product to third parties), so either one blocks the configuration.
    const terms = licenseTerms(licenseId);
    const recordedObligations = Array.isArray(row.obligations) ? (row.obligations as string[]) : [];
    const resaleRestricted = row.recorded
      ? row.resale_restricted
      : (terms?.resaleRestricted ?? false);
    const hostedServiceRestricted = row.recorded
      ? row.hosted_service_restricted
      : (terms?.hostedServiceRestricted ?? false);
    const restricted = resaleRestricted || hostedServiceRestricted;
    // A licence in neither the review record nor the licence table has unverified terms: the gate
    // refuses rather than assuming the permissive answer (C-3).
    const unknown = !row.recorded && terms === null;
    const gateReason = unknown
      ? `No licence terms are recorded for ${row.product} (${licenseId}), so hosted-service mode stays off.`
      : restricted
        ? `${row.product} is licensed under ${licenseId}, which does not permit resale or offering it as a hosted service.`
        : null;

    if (enabled && gateReason !== null) {
      await this.audit.append({
        action: 'license.hosted_service.denied',
        actorType: 'user',
        actorId,
        targetType: 'instance',
        targetId: instanceId,
        outcome: 'denied',
        detail: {
          enabled,
          licenseId,
          recorded: row.recorded,
          reviewed: row.reviewed_at !== null,
          resaleRestricted,
          hostedServiceRestricted,
        },
      });
      throw new AppError({
        code: 'LICENCE_RESTRICTED',
        detail: gateReason,
        remediation:
          'Keep the instance for internal use, or complete the licence review and obtain a commercial licence before enabling hosted-service mode.',
      });
    }

    // 4F.3: the toggle is state on the licence row. It used to be written into
    // `instance.payload.licenseRestricted`, which is the restriction flag the instance projection
    // reads — so enabling hosted service erased the restriction itself.
    const current = row.recorded ? row.hosted_service_enabled : false;
    if (current !== enabled) {
      await withTransaction(this.pool, async (tx) => {
        await this.audit.lockChain(tx);
        // The first toggle is also the register's write path: it creates the record from the
        // licence table without pretending a review happened (`reviewed_by`/`reviewed_at` stay
        // null). On conflict only the toggle moves, so a signed-off review is never overwritten.
        await tx.query(
          `INSERT INTO license_record
                  (instance_id, license_id, obligations, resale_restricted, hosted_service_restricted,
                   hosted_service_enabled)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6)
           ON CONFLICT (instance_id) DO UPDATE
              SET hosted_service_enabled = EXCLUDED.hosted_service_enabled`,
          [
            instanceId,
            licenseId,
            JSON.stringify(
              recordedObligations.length > 0 ? recordedObligations : (terms?.obligations ?? []),
            ),
            resaleRestricted,
            hostedServiceRestricted,
            enabled,
          ],
        );
        // A toggle is not a review: `reviewed_by`/`reviewed_at` stay untouched, otherwise the
        // register was silently cleared by the very change it is supposed to gate.
        await this.audit.append(
          {
            action: 'license.hosted_service.updated',
            actorType: 'user',
            actorId,
            targetType: 'instance',
            targetId: instanceId,
            outcome: 'success',
            detail: { enabled, licenseId, entryKey: row.entry_key, recorded: row.recorded },
          },
          tx,
        );
      });
    }

    return {
      instanceId,
      hostedService: enabled,
      restricted,
      reason: gateReason,
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * FR-4.7 / NFR-4.7: current version, available upstream version, last upgrade and the age of the
   * oldest unapplied security update, per instance.
   *
   * Three corrections matter here:
   * - the register starts at `instance`, not at `patch_record`. An instance whose version check has
   *   never run was absent from the register entirely, and a register that omits an instance cannot
   *   report on it — the same defect `licenses()` describes above.
   * - soft-deleted instances are excluded; they were listed as live.
   * - `last_upgrade_at` is when the running definition was last applied, not `instance.updated_at`
   *   — that column moves on every start, stop and status sample, so a restart used to rewrite the
   *   "last upgrade" date the patch clock is measured from. `render_set.applied_at` is the moment a
   *   new version reached the host, and it is already a declared read for this module.
   *
   * Where `patch_record` has no row, the catalog's upstream projection supplies the versions (the
   * repository adapter refreshes it per AD-09), so a fresh host shows what is actually running
   * instead of an empty register.
   */
  async patches(): Promise<PatchRecord[]> {
    const result = await this.pool.query<{
      instance_id: string;
      entry_key: string;
      product: string;
      current_version: string | null;
      latest_version: string | null;
      last_upgrade_at: Date | null;
      created_at: Date;
      oldest_unapplied_security_days: number | null;
      checked_at: Date;
    }>(
      `SELECT i.id AS instance_id, i.entry_key,
              coalesce(i.payload->>'product', c.product, i.entry_key) AS product,
              coalesce(p.current_version, c.payload->'upstream'->>'currentVersion') AS current_version,
              coalesce(p.latest_version, c.payload->'upstream'->>'latestVersion') AS latest_version,
              (SELECT max(r.applied_at)
                 FROM render_set r
                WHERE r.instance_id = i.id
                  AND r.applied_at IS NOT NULL) AS last_upgrade_at,
              i.created_at,
              p.oldest_unapplied_security_days,
              coalesce(p.checked_at, c.updated_at, i.updated_at) AS checked_at
         FROM instance i
         LEFT JOIN catalog_entry c ON c.key = i.entry_key
         LEFT JOIN patch_record p ON p.instance_id = i.id
        WHERE i.deleted_at IS NULL
        ORDER BY product`,
    );
    return result.rows.map((row) => {
      const currentVersion = row.current_version ?? 'unknown';
      const latestVersion = row.latest_version ?? currentVersion;
      const behind = latestVersion !== currentVersion;
      return {
        instanceId: row.instance_id,
        entryKey: row.entry_key,
        product: row.product,
        currentVersion,
        latestVersion,
        // The contract requires a date, and none of these fallbacks is invented: the last applied
        // render set, else when the instance was installed, else when the versions were checked.
        lastUpgradeAt: (row.last_upgrade_at ?? row.created_at ?? row.checked_at).toISOString(),
        // `null` stays `null`: with no check there is no age, and reporting 0 would tell the
        // operator "nothing pending" about an instance nobody has looked at.
        oldestUnappliedSecurityDays: row.oldest_unapplied_security_days,
        severity: !behind
          ? 'info'
          : (row.oldest_unapplied_security_days ?? 0) > 30
            ? 'critical'
            : 'warning',
        checkedAt: row.checked_at.toISOString(),
      };
    });
  }

  /**
   * FR-4.8. Counts are per **deployment**, the basis S-2 uses for the native floor: D5 and D6
   * share the ERPNext deployment, so counting catalog entries credits that one deployment twice.
   * `sso.totalEntries` is the distinct entry count and is deliberately a different denominator.
   * `coveragePercent` is restore verification only — it has never been SSO coverage, and labelling
   * it as such made a fully IdP-gated fleet read "0% coverage".
   *
   * NFR-3.5: a passed drill is current for one quarter. Older evidence is reported as overdue with
   * its date, not as "never verified".
   */
  async posture(): Promise<PostureSummary> {
    const [instances, restores, stale, managed] = await Promise.all([
      this.pool.query<{
        id: string;
        product: string;
        entry_key: string;
        guarantee_class: string | null;
        ready: boolean | null;
      }>(
        `SELECT i.id, coalesce(i.payload->>'product', i.entry_key) AS product, i.entry_key, c.guarantee_class,
                s.ready
           FROM instance i
           LEFT JOIN catalog_entry c ON c.key = i.entry_key
           LEFT JOIN instance_status s ON s.instance_id = i.id
          WHERE i.deleted_at IS NULL`,
      ),
      this.pool.query<{ instance_id: string | null; performed_at: Date }>(
        `SELECT instance_id, max(performed_at) AS performed_at FROM restore_drill WHERE passed GROUP BY instance_id`,
      ),
      this.pool.query<{
        entry_key: string;
        product: string;
        verified_at: Date;
        next_review_at: Date;
      }>(
        `SELECT m.entry_key, coalesce(c.product, m.entry_key) AS product, m.verified_at, m.next_review_at
           FROM integration_metadata m LEFT JOIN catalog_entry c ON c.key = m.entry_key
          WHERE m.next_review_at IS NOT NULL AND m.next_review_at < now()`,
      ),
      /*
       * ADR-BE-22. A proxy-gate deployment whose sign-in the platform relays holds a per-user
       * credential for a product it does not own. The posture screen has to say so — "provisioned
       * outside the platform" was true before this existed and is not any more, and S-2's native
       * floor must not be able to absorb a relayed password as if it were single sign-on.
       */
      this.pool.query<{ count: string }>(
        `SELECT count(DISTINCT instance_id)::text AS count FROM product_account`,
      ),
    ]);

    const total = instances.rows.length;
    const native = instances.rows.filter((row) => row.guarantee_class === 'native').length;
    const forwardAuth = instances.rows.filter(
      (row) => row.guarantee_class === 'fa_header' || row.guarantee_class === 'fa_delegated',
    ).length;
    // An unclassified deployment cannot be claimed as SSO, so it joins the proxy-gate bucket and
    // the three classes still partition the fleet.
    const signInRequired = total - native - forwardAuth;

    const latestDrill = new Map(
      restores.rows
        .filter(
          (row): row is { instance_id: string; performed_at: Date } => row.instance_id !== null,
        )
        .map((row) => [row.instance_id, row.performed_at]),
    );
    const restoreCutoff = Date.now() - RESTORE_VALID_DAYS * 86_400_000;
    const isCurrent = (instanceId: string): boolean => {
      const performedAt = latestDrill.get(instanceId);
      return performedAt !== undefined && performedAt.getTime() >= restoreCutoff;
    };

    const unverifiedRestores = instances.rows
      .filter((row) => !isCurrent(row.id))
      .map((row) => ({
        instanceId: row.id,
        product: row.product,
        lastVerifiedAt: latestDrill.get(row.id)?.toISOString() ?? null,
      }));

    const missingHealthChecks = instances.rows
      .filter((row) => row.ready === null)
      .map((row) => ({ instanceId: row.id, product: row.product }));

    return {
      generatedAt: new Date().toISOString(),
      sso: {
        native,
        forwardAuth,
        signInRequired,
        totalEntries: new Set(instances.rows.map((row) => row.entry_key)).size,
        // Deployments where the platform holds the product credential (ADR-BE-22). These stay in
        // `signInRequired`: the class does not change, and neither bucket above may claim them.
        platformManagedCredentials: Number(managed.rows[0]?.count ?? 0),
      },
      missingHealthChecks,
      unverifiedRestores,
      // No TLS-expiry feed is wired yet. An empty list is therefore not evidence that every
      // certificate is healthy, and the posture screen must not describe it as proof.
      expiringCertificates: [],
      staleMetadata: stale.rows.map((row) => ({
        entryKey: row.entry_key,
        product: row.product,
        verifiedAt: row.verified_at.toISOString(),
        daysOverdue: Math.max(
          1,
          Math.floor((Date.now() - row.next_review_at.getTime()) / 86_400_000),
        ),
      })),
      instancesWithoutHealthCheck: missingHealthChecks.length,
      totalInstances: total,
      coveragePercent:
        total === 0 ? 0 : Math.round(((total - unverifiedRestores.length) / total) * 100),
    };
  }

  async breakGlass(): Promise<BreakGlassSession[]> {
    const result = await this.pool.query<{
      id: string;
      requester: string;
      requester_name: string;
      instance_id: string | null;
      product: string | null;
      access_mode: string;
      justification: string;
      approver: string | null;
      approver_name: string | null;
      self_approved: boolean;
      state: string;
      created_at: Date;
      granted_at: Date | null;
      expires_at: Date | null;
      revoked_at: Date | null;
      created_accounts: unknown;
      retention_reason: string | null;
    }>(
      /*
       * The identities are resolved to something a person can read. The register previously showed
       * a raw `idp_id` under "Approver", and the requester was not on the screen at all — which is
       * the one fact an approver needs before deciding.
       */
      `SELECT b.id, b.requester, b.instance_id, coalesce(i.payload->>'product', i.entry_key) AS product,
              b.access_mode, b.justification, b.approver, b.self_approved, b.state, b.created_at,
              b.granted_at, b.expires_at, b.revoked_at, b.created_accounts, b.retention_reason,
              coalesce(ru.display_name, ru.username, b.requester) AS requester_name,
              CASE WHEN b.approver IS NULL THEN NULL
                   ELSE coalesce(au.display_name, au.username, b.approver) END AS approver_name
         FROM break_glass_session b
         LEFT JOIN instance i ON i.id = b.instance_id
         LEFT JOIN idp_user ru ON ru.idp_id = b.requester
         LEFT JOIN idp_user au ON au.idp_id = b.approver
        ORDER BY b.created_at DESC`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      requester: { id: row.requester, name: row.requester_name },
      instanceId: row.instance_id ?? row.id,
      product: row.product ?? 'Platform',
      // The elevation records the approver, never a domain owner; the screen says so instead of
      // presenting the approver as the owner of the domain.
      domainOwner: 'Platform',
      accessMode: row.access_mode as BreakGlassSession['accessMode'],
      justification: row.justification,
      approver: row.approver_name,
      selfApproved: row.self_approved,
      /*
       * Derived, not stored: between sweeps an overdue grant still reads `active` in the column,
       * and a list that repeats it is the console telling an operator that live access exists when
       * it does not.
       */
      state: breakGlassStateAt(row.state as BreakGlassSession['state'], row.expires_at),
      requestedAt: row.created_at.toISOString(),
      grantedAt: row.granted_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      createdAccounts: Array.isArray(row.created_accounts) ? row.created_accounts.length : 0,
      retentionReason: row.retention_reason,
    }));
  }

  async maintenance(): Promise<MaintenanceWindow[]> {
    /* Newest first: the window an operator needs is the one that is running or next up. */
    const result = await this.pool.query<MaintenanceWindowRow>(
      `${MAINTENANCE_WINDOW_SELECT} ORDER BY m.starts_at DESC`,
    );
    return result.rows.map((row) => toMaintenanceWindow(row));
  }

  async policyExceptions(): Promise<PolicyException[]> {
    const result = await this.pool.query<{
      id: string;
      rule: string;
      scope: string;
      justification: string;
      approver: string;
      state: string;
      created_at: Date;
      expires_at: Date;
      patch_diff: unknown;
      requester_name: string | null;
      approver_name: string | null;
    }>(
      /* Both columns hold subject identifiers. The row shows a person on either side, so each is
         resolved to the directory name once, here, rather than in every screen that reads it. */
      `SELECT pe.id, pe.rule, pe.scope, pe.justification, pe.approver, pe.state, pe.created_at,
              pe.expires_at, pe.patch_diff,
              coalesce(r.display_name, r.username) AS requester_name,
              coalesce(a.display_name, a.username) AS approver_name
         FROM policy_exception pe
         LEFT JOIN idp_user r ON r.idp_id = coalesce(pe.patch_diff->>'requestedBy', pe.approver)
         LEFT JOIN idp_user a ON a.idp_id = pe.approver
        ORDER BY pe.created_at DESC`,
    );
    return result.rows.map((row) => {
      const state = toPolicyExceptionState(row.state);
      return {
        id: row.id,
        rule: row.rule,
        scope: row.scope,
        justification: row.justification,
        // The requester to the row, never the approver: the console decides who may act on it.
        requester: row.requester_name ?? policyExceptionRequester(row),
        // `approver` is NOT NULL and holds the creator until a decision overwrites it, so reading
        // it raw reported an open exception as already approved by its own requester.
        approver: state === 'requested' ? null : (row.approver_name ?? row.approver),
        state,
        requestedAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        patchDiff: policyExceptionDiff(row.patch_diff),
      };
    });
  }

  async dsar(): Promise<DsarRequest[]> {
    const result = await this.pool.query<{
      id: string;
      subject_ref: string | null;
      kind: string;
      state: string;
      opened_by: string;
      opened_at: Date;
      closed_at: Date | null;
      evidence: Record<string, unknown>;
    }>(
      `SELECT id, subject_ref, kind, state, opened_by, opened_at, closed_at, evidence FROM dsar_request ORDER BY opened_at DESC`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      subjectRef: row.subject_ref ?? 'erased',
      kind: row.kind as DsarRequest['kind'],
      state: toDsarState(row.state),
      openedBy: row.opened_by,
      openedAt: row.opened_at.toISOString(),
      closedAt: row.closed_at?.toISOString() ?? null,
      evidence: Array.isArray(row.evidence.notes) ? (row.evidence.notes as string[]) : [],
    }));
  }
}

function toDsarState(state: string): DsarRequest['state'] {
  switch (state) {
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'complete';
    case 'rejected':
    case 'expired':
      return 'failed';
    default:
      return 'open';
  }
}

/**
 * `policy_exception.state` stores `pending`, `approved`, `rejected`, `expired` (migration 0006);
 * the wire contract names the open state `requested`. Passing the column through untouched made
 * the list fail its own response schema in development — a 500 for every pending exception — and
 * left the console rendering rows whose approve button can never appear, because it keys on
 * `requested`. The mapping belongs here, at the boundary, once.
 */
function toPolicyExceptionState(state: string): PolicyException['state'] {
  switch (state) {
    case 'pending':
    case 'requested':
      return 'requested';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'expired';
  }
}

function notFound(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No instance ${id}.`,
    remediation: 'Refresh the licence register.',
  });
}
