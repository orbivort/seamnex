import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  selectEgressInstance,
  workflowWriteAuthority,
  type PlatformRole,
  type WorkflowAuthorityRefusalList,
  type WorkflowGrant,
  type WorkflowWriteTarget,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { currentContext } from '../../common/identity/request-context';
import { isUuid } from '../../common/http/uuid';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import {
  ACCESS_CONTROL_SERVICE,
  type AccessControlService,
} from '../m09-access-control/access-control.contract';
import { GOVERNANCE_SERVICE, type GovernanceService } from '../m18-governance/governance.contract';
import type {
  WorkflowAuthority,
  WorkflowAuthorityEvidence,
  WorkflowAuthorityRequest,
  WorkflowListScope,
} from './workflow-authority.contract';

/** Roles whose `workflow.view_runs` cell is anything but `none` (requirements §5.2). */
const READ_ROLES: readonly PlatformRole[] = ['R1', 'R2', 'R3', 'R4'];

const NO_EVIDENCE: WorkflowAuthorityEvidence = { elevations: [] };

/**
 * FR-5.9 / AC-26 / NFR-4.4 — the precise workflow authority gate.
 *
 * The rule itself is a pure function in `@seamnex/domain`; this service is only the part that
 * gathers its three facts and turns a refusal into a problem document plus evidence:
 *
 *  - **grants** — the live `role_binding` rows, read per call rather than from the session, so a
 *    revoked binding stops authorising writes immediately (the route layer's 60 s allow cache is
 *    coarse; this is not cached at all);
 *  - **targets** — the instances the definition will actually write to, resolved with the same
 *    selection rule the compiler uses (`selectEgressInstance`), never re-derived;
 *  - **elevations** — active read-write break-glass sessions for an R1, read through the module
 *    that owns `break_glass_session`.
 *
 * It is called from the authoring service (create, import, every IR edit, activation, run) and from
 * the workflow read/write service (rename, delete), so a new route that funnels through either
 * cannot skip it.
 */
@Injectable()
export class PostgresWorkflowAuthority implements WorkflowAuthority {
  private readonly logger = new Logger('m13.workflow.authority');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ACCESS_CONTROL_SERVICE) private readonly access: AccessControlService,
    @Inject(GOVERNANCE_SERVICE) private readonly governance: GovernanceService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async assertPermitted(request: WorkflowAuthorityRequest): Promise<WorkflowAuthorityEvidence> {
    const role = request.role ?? currentContext()?.role ?? 'R5';
    const targets = await this.targets(request).catch(async (error: unknown) => {
      // Fail closed, and say so: an unreadable target set must never be mistaken for "this
      // definition writes nowhere", which the rule permits.
      this.logger.error({
        msg: 'workflow write targets could not be resolved',
        action: request.action,
        err: error instanceof Error ? error.message : String(error),
      });
      return this.refuse({ ...request, role }, [
        {
          instanceId: request.workflowId ?? 'unresolved',
          entryKey: 'unresolved',
          missing: 'unresolved',
          detail:
            'The write targets of this workflow could not be resolved, so the write was refused rather than assumed safe.',
          remediation: 'Retry once the platform is reachable. The refusal was audited.',
        },
      ]);
    });
    // Nothing is written through, so there is no write authority to hold: a draft with no bound
    // write node is refused by validation, not here (FR-5.9, "read-only targets require entitlement
    // only").
    if (targets.length === 0) return NO_EVIDENCE;

    const grants = await this.grants(request.actorId, role);
    const elevations = grants.some((grant) => grant.role === 'R1')
      ? await this.activeElevations(request.actorId, targets)
      : new Map<string, string>();

    const verdict = workflowWriteAuthority({ grants, targets, elevations });
    if (verdict.allowed) return { elevations: verdict.elevations };
    return this.refuse({ ...request, role }, verdict.refusals);
  }

  async listScope(actorId: string, role?: PlatformRole): Promise<WorkflowListScope> {
    const grants = await this.grants(actorId, role ?? currentContext()?.role ?? 'R5');
    const reading = grants.filter((grant) => READ_ROLES.includes(grant.role));
    // A platform-scoped reading role sees the whole portfolio; this is the R1/R2 answer and the
    // `grantsFor` fallback for a subject with no binding row.
    if (reading.some((grant) => grant.scopeType === 'platform')) return { unrestricted: true };
    return {
      unrestricted: false,
      domains: unique(
        reading.flatMap((grant) => (grant.scopeType === 'domain' ? [grant.scopeId] : [])),
      ),
      instanceIds: unique(
        reading.flatMap((grant) => (grant.scopeType === 'instance' ? [grant.scopeId] : [])),
      ),
    };
  }

  /**
   * The live grant set, with the same fallback the PDP uses: a subject with no binding row keeps
   * the role its session carries, otherwise a seeded demo administrator holds nothing.
   *
   * A database failure is **not** that fallback — it denies. Reading "I could not check" as "no
   * restriction" would be the one failure mode this gate exists to prevent.
   */
  private async grants(actorId: string, role: PlatformRole): Promise<WorkflowGrant[]> {
    try {
      const live = await this.access.grantsFor(actorId);
      if (live.length > 0) {
        return live.map((grant) => ({
          role: grant.role,
          scopeType: grant.scopeType,
          scopeId: grant.scopeId,
        }));
      }
    } catch (error) {
      this.logger.error(
        `role bindings unavailable; denying (${error instanceof Error ? error.message : String(error)})`,
      );
      return [];
    }
    return [{ role, scopeType: 'platform', scopeId: null }];
  }

  /** instanceId → session id, for the elevations this actor holds on the targets in play. */
  private async activeElevations(
    actorId: string,
    targets: readonly WorkflowWriteTarget[],
  ): Promise<Map<string, string>> {
    const ids = unique(targets.map((target) => target.instanceId));
    const elevations = await this.governance.activeWriteElevations(actorId, ids);
    return new Map(elevations.map((elevation) => [elevation.instanceId, elevation.sessionId]));
  }

  /**
   * The products this call writes through, resolved to the instance the run will use.
   *
   * An entry key with no usable deployment is **skipped**, not refused: an imported definition may
   * name a product this host does not run, and `validate`/`activate`/`run` already refuse that with
   * a precise reason. Authority is about instances that exist.
   */
  private async targets(request: WorkflowAuthorityRequest): Promise<WorkflowWriteTarget[]> {
    const resolved: WorkflowWriteTarget[] = [];

    const explicit = (request.instanceIds ?? []).filter(isUuid);
    if (explicit.length > 0) {
      const rows = await this.pool.query<{
        instance_id: string;
        entry_key: string;
        domain: string | null;
        product: string | null;
      }>(
        `SELECT i.id AS instance_id, i.entry_key, c.domain, c.payload->>'product' AS product
           FROM instance i
           LEFT JOIN catalog_entry c ON c.key = i.entry_key
          WHERE i.id = ANY($1::uuid[]) AND i.deleted_at IS NULL
          ORDER BY i.id`,
        [explicit],
      );
      resolved.push(
        ...rows.rows.map((row) => ({
          instanceId: row.instance_id,
          entryKey: row.entry_key,
          domain: row.domain,
          product: row.product,
        })),
      );
    }

    const entryKeys = unique(request.entryKeys ?? []);
    if (entryKeys.length > 0) {
      const rows = await this.pool.query<{
        entry_key: string;
        instance_id: string | null;
        domain: string | null;
        product: string | null;
        granularity: string | null;
      }>(
        `SELECT t.entry_key, i.id AS instance_id, c.domain, c.payload->>'product' AS product,
                seamnex_effective_granularity(i.id) AS granularity
           FROM unnest($1::text[]) AS t(entry_key)
           LEFT JOIN instance i ON i.entry_key = t.entry_key AND i.deleted_at IS NULL
           LEFT JOIN catalog_entry c ON c.key = t.entry_key
          ORDER BY t.entry_key, i.id`,
        [entryKeys],
      );

      const byEntry = new Map<string, (typeof rows.rows)[number][]>();
      for (const row of rows.rows) {
        if (row.instance_id === null) continue;
        const bucket = byEntry.get(row.entry_key) ?? [];
        bucket.push(row);
        byEntry.set(row.entry_key, bucket);
      }
      for (const [entryKey, candidates] of byEntry) {
        // The candidate travels with the choice, so the catalogue facts come from the row that was
        // actually selected rather than from a second lookup that could disagree.
        const chosen = selectEgressInstance(
          candidates.map((candidate) => ({
            instanceId: candidate.instance_id as string,
            granularity: candidate.granularity,
            candidate,
          })),
          'write',
        );
        if (chosen === undefined) continue;
        resolved.push({
          instanceId: chosen.instanceId,
          entryKey,
          domain: chosen.candidate.domain,
          product: chosen.candidate.product,
        });
      }
    }

    // One product is one write target, whatever the IR repeats: a duplicated refusal would read as
    // two problems and send the operator looking for a second one.
    return [...new Map(resolved.map((target) => [target.instanceId, target])).values()];
  }

  /**
   * Records the refusal and answers it. `detail` names **every** offending target with the fix for
   * each, because the alternative — "forbidden" — leaves the author guessing which product to
   * remove and whom to ask.
   */
  private async refuse(
    request: WorkflowAuthorityRequest,
    refusals: WorkflowAuthorityRefusalList,
  ): Promise<never> {
    const requestId = currentContext()?.requestId;
    await this.audit
      .denied({
        actorType: 'user',
        actorId: request.actorId,
        targetType: 'workflow',
        targetId: request.workflowId ?? refusals[0].instanceId,
        detail: {
          policyKey: request.policyKey,
          reason: 'fr-5.9 write-target authority not held',
          action: request.action,
          role: request.role,
          refusals: refusals.map((refusal) => ({
            instanceId: refusal.instanceId,
            entryKey: refusal.entryKey,
            missing: refusal.missing,
          })),
        },
        ...(requestId === undefined ? {} : { requestId }),
      })
      // Fail closed in the security direction: an audit outage must not turn into an allow, and the
      // refusal itself is still the answer.
      .catch((error: unknown) => {
        this.logger.error({
          msg: 'workflow authority refusal could not be audited',
          err: String(error),
        });
      });

    throw new AppError({
      code: 'WORKFLOW_WRITE_NOT_PERMITTED',
      status: 403,
      detail: refusals.map((refusal) => refusal.detail).join(' '),
      fieldErrors: refusals.map((refusal) => ({
        field: 'writeTargets',
        code: refusal.missing,
        message: refusal.detail,
      })),
      remediation: refusals[0].remediation,
    });
  }
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value !== ''))];
}
