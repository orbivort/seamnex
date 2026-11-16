import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CAPABILITY_MATRIX,
  isReservedPolicyKey,
  requiresMfa,
  scopeRuleFor,
  selectEgressInstance,
  type Capability,
  type PolicyKey,
  type PolicyResource,
} from '@seamnex/domain';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import type { RequestContext } from '../../common/identity/request-context';
import { isUuid } from '../../common/http/uuid';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { ACCESS_CONTROL_SERVICE, type AccessControlService } from './access-control.contract';
import { PolicyCompiler } from './policy.compiler';

export type PolicyDecision = {
  readonly allowed: boolean;
  readonly policyVersion: number;
  readonly reason: string;
};

/**
 * The refusal reason for a capability that needs a satisfied second factor. Exported so the route
 * layer can answer `401 MFA_REQUIRED` (re-authenticate) instead of a generic `403` that would read
 * as "you may never do this".
 */
export const MFA_REASON = 'second factor not satisfied';

type Grant = Awaited<ReturnType<AccessControlService['grantsFor']>>[number];

/**
 * ADR-BE-05 — the policy decision point.
 *
 * Evaluation order is fixed: authenticated actor → matrix access for the role → scope resolution →
 * decision. Every missing link denies. `full` decisions are a map lookup; only `scoped` decisions
 * touch the database or the Redis cache, which is what keeps `GET /me/launcher` inside its budget.
 *
 * Caching choice: **allow** decisions are cached for 60 s keyed by policy version; **denials are
 * never cached** because AC-38 requires every refusal to leave an `access.denied` audit row, and a
 * cached denial would silently skip one.
 */
@Injectable()
export class PdpService {
  private readonly logger = new Logger('pdp');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(ACCESS_CONTROL_SERVICE) private readonly access: AccessControlService,
    // Explicit token: no `emitDecoratorMetadata` at runtime (see `contract/route-table.ts`).
    @Inject(PolicyCompiler) private readonly compiler: PolicyCompiler,
  ) {}

  async decide(input: {
    context: RequestContext;
    policyKey: PolicyKey;
    resource: PolicyResource;
  }): Promise<PolicyDecision> {
    const decision = await this.evaluate(input);
    if (decision.allowed) return decision;
    return this.deny(
      input.context,
      input.policyKey,
      input.resource,
      decision.policyVersion,
      decision.reason,
    );
  }

  /**
   * Any-of evaluation for the few operations whose readers do not share a capability.
   *
   * It is still **one** decision: the first key that allows wins, and a refusal produces a single
   * `access.denied` row naming the set. Evaluating the keys as separate `decide` calls would audit
   * a refusal for every key an auditor does not hold — turning a legitimate page load into a stream
   * of false denials in the evidence trail.
   */
  async decideAny(input: {
    context: RequestContext;
    policyKeys: readonly PolicyKey[];
    resource: PolicyResource;
    /** The declared key of the operation; the refusal is recorded against it, not against the set. */
    declaredKey: PolicyKey;
  }): Promise<PolicyDecision> {
    let first: PolicyDecision | undefined;
    for (const policyKey of input.policyKeys) {
      const decision = await this.evaluate({ ...input, policyKey });
      if (decision.allowed) return decision;
      first ??= decision;
      // A step-up refusal is decisive evidence about the session, not about the set.
      if (decision.reason === MFA_REASON) {
        return this.deny(
          input.context,
          policyKey,
          input.resource,
          decision.policyVersion,
          decision.reason,
        );
      }
    }
    return this.deny(
      input.context,
      input.declaredKey,
      input.resource,
      first?.policyVersion ?? this.compiler.activeVersion,
      `no role grants any of: ${input.policyKeys.join(', ')}`,
    );
  }

  /**
   * The decision without its audit row. `decide`/`decideAny` own the refusal record so an any-of
   * set cannot write more than one; the cache is still per capability, so an allow is reused.
   */
  private async evaluate(input: {
    context: RequestContext;
    policyKey: PolicyKey;
    resource: PolicyResource;
  }): Promise<PolicyDecision> {
    const { context, policyKey, resource } = input;
    const version = this.compiler.activeVersion;

    if (isReservedPolicyKey(policyKey)) {
      if (policyKey === 'auth.session.read' && context.actorType !== 'anonymous') {
        return { allowed: true, policyVersion: version, reason: 'own session' };
      }
      return {
        allowed: false,
        policyVersion: version,
        reason: 'reserved key is not a role capability',
      };
    }

    if (context.actorType === 'service') {
      const allowed = context.scopes.includes(policyKey);
      if (allowed) return { allowed: true, policyVersion: version, reason: 'machine scope' };
      return {
        allowed: false,
        policyVersion: version,
        reason: 'machine scope does not include the capability',
      };
    }

    if (context.actorType === 'anonymous') {
      return {
        allowed: false,
        policyVersion: version,
        reason: 'anonymous request on a protected operation',
      };
    }

    /*
     * Step-up gate (ADR-BE-13). The matrix says which role may act; it says nothing about the
     * assurance behind the session. A capability whose misuse is not recoverable by a support
     * ticket therefore also requires a satisfied second factor, which is read from the session
     * record — not from the request. Evaluated before the allow cache, so a cached decision can
     * never outlive the assurance it was made under.
     */
    if (requiresMfa(context.role, policyKey)) {
      // Evidence, not absence of evidence (ADR-BE-14): `mfaAsserted` is false when the identity
      // provider published no authentication methods at all, and refusing on that would lock every
      // administrator out of a realm that enforces the factor in its login flow but does not map
      // it into `amr`. A provider that *states* `pwd` only is refused here.
      if (context.mfaAsserted && !context.mfaSatisfied) {
        return { allowed: false, policyVersion: version, reason: MFA_REASON };
      }
    }

    const cacheKey = this.cacheKey(version, context.subject.idpId, policyKey, resource);
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached === 'allow')
      return { allowed: true, policyVersion: version, reason: 'cached allow' };

    const grants = await this.grantsFor(context);
    const rule = scopeRuleFor(policyKey);
    let scoped = false;

    for (const grant of grants) {
      const access = CAPABILITY_MATRIX[policyKey as Capability]?.[grant.role];
      if (access === undefined) continue;
      if (access === 'none') continue;
      if (access === 'full') {
        await this.cacheAllow(cacheKey);
        return {
          allowed: true,
          policyVersion: version,
          reason: `${grant.role} holds ${policyKey}`,
        };
      }
      // `scoped` is not a weaker yes: it must resolve to a scope this actor actually owns.
      scoped = true;
      if (await this.scopeCovers(grant, rule, resource, context)) {
        await this.cacheAllow(cacheKey);
        return {
          allowed: true,
          policyVersion: version,
          reason: `${grant.role} holds ${policyKey} within ${grant.scopeType}`,
        };
      }
    }

    return {
      allowed: false,
      policyVersion: version,
      reason: scoped
        ? 'the scoped grant does not cover this resource'
        : 'no role grants the capability',
    };
  }

  /**
   * The live grant set, not the roles captured at sign-in: a revoked binding must stop working
   * within the 60 s policy window rather than at the next sign-in. A database failure denies.
   */
  private async grantsFor(context: RequestContext): Promise<Grant[]> {
    try {
      const grants = await this.access.grantsFor(context.subject.idpId);
      if (grants.length > 0) return grants;
    } catch (error) {
      this.logger.error(
        `role bindings unavailable; denying (${error instanceof Error ? error.message : String(error)})`,
      );
      return [];
    }
    // A session whose subject has no binding still has the role the session carried; that is how a
    // platform-scoped role granted outside `role_binding` (a seeded demo) stays usable.
    return [
      {
        role: context.role,
        scopeType: 'platform',
        scopeId: null,
        expiresAt: null,
      },
    ];
  }

  private async scopeCovers(
    grant: Grant,
    rule: ReturnType<typeof scopeRuleFor>,
    resource: PolicyResource,
    context: RequestContext,
  ): Promise<boolean> {
    if (rule === 'self' || rule === 'request') return true;
    if (rule === 'platform') return false;
    if (grant.scopeType === 'platform') return true;

    /*
     * FR-5.9: a workflow is not a place, it is a set of write targets. Resolving the resource to the
     * instances it writes to is what lets an R3 see and reach the definitions in their own domains;
     * before this, every scoped grant was refused because `domainOf` only knew instances and catalog
     * entries. The precise rule — R1 break-glass, R4 as the sole write target — is enforced by
     * `WorkflowAuthority` in m13 before anything is written; this layer answers the coarser question
     * "does this grant reach this definition at all", so the two cannot disagree in the permissive
     * direction.
     */
    if (resource.type === 'workflow') return this.workflowScopeCovers(grant, resource.id, context);

    const domain = await this.domainOf(resource);
    if (rule === 'domain') {
      if (grant.scopeType === 'domain') return grant.scopeId !== null && grant.scopeId === domain;
      if (grant.scopeType === 'instance' && resource.type === 'instance') {
        return grant.scopeId === resource.id;
      }
      return false;
    }

    /*
     * `instance` rule.
     *
     * A `self` resource from an instance-bound session *is* that session's instance: the launcher
     * and the product deep link are the guest's own surface, and §5.2 grants R6 "one product"
     * through `portal.launch`, whose rule is `instance`. Without this, `scoped` could never satisfy
     * an instance rule on a `/me`-shaped read and the guest's only screen stayed a 403. The grant
     * comparison below still runs, so R6 needs a binding to that exact instance — this is a
     * resolution rule, not a weaker yes.
     *
     * It is general on purpose: a future instance-scoped capability read through `/me` means the
     * same thing. Only `portal.launch` is in that position today.
     */
    const instanceId =
      resource.type === 'instance'
        ? resource.id
        : resource.type === 'self' && context.instanceId !== null
          ? context.instanceId
          : null;
    if (instanceId === null) return false;
    // R6 is single-surface: a guest session is bound to exactly one instance.
    if (context.instanceId !== null && context.instanceId !== instanceId) return false;
    if (grant.scopeType === 'instance') return grant.scopeId === instanceId;
    if (grant.scopeType === 'domain') return grant.scopeId !== null && grant.scopeId === domain;
    return false;
  }

  private async domainOf(resource: PolicyResource): Promise<string | null> {
    if (resource.id.length === 0) return null;
    try {
      if (resource.type === 'instance') {
        const result = await this.pool.query<{ domain: string }>(
          `SELECT c.domain FROM instance i JOIN catalog_entry c ON c.key = i.entry_key
            WHERE i.id::text = $1 OR i.slug = $1 LIMIT 1`,
          [resource.id],
        );
        return result.rows[0]?.domain ?? null;
      }
      if (resource.type === 'catalog') {
        const result = await this.pool.query<{ domain: string }>(
          `SELECT domain FROM catalog_entry WHERE key = $1 LIMIT 1`,
          [resource.id],
        );
        return result.rows[0]?.domain ?? null;
      }
    } catch (error) {
      this.logger.warn(`scope resolution failed; treating as unresolved (${String(error)})`);
    }
    return null;
  }

  /**
   * A workflow — or one of its runs — resolved to the products it writes to (FR-5.9).
   *
   * Four answers are deliberate:
   *
   *  - **No id yet** (`POST /workflows`, `POST /workflows/import`) is admitted on role alone. The
   *    definition does not exist, so there is no target to resolve; m13 enforces the target rule
   *    before it writes anything.
   *  - **A definition that writes nowhere** is reachable by its author only. Resolving it to an
   *    empty set must not read as "covers everything", and a read-only draft is still not a shared
   *    document.
   *  - **A declared target that no deployment can write to** (`account`-wide credential, C-11) is
   *    not a target: the write gate skips it for exactly the same reason, and a definition that
   *    cannot run must not answer differently to the two gates.
   *  - **Every target must be covered**, by domain (`scope_id = catalog_entry.domain`) or, for an
   *    instance grant, by being the single write target. A stronger answer than FR-5.9 would refuse
   *    reads the requirement grants; a weaker one would leak another domain's definition.
   */
  private async workflowScopeCovers(
    grant: Grant,
    id: string,
    context: RequestContext,
  ): Promise<boolean> {
    if (id.length === 0) return true;
    // A malformed segment cannot address a row and would reach PostgreSQL as `22P02`; the route
    // layer answers `422` before any decision, and a decision taken here stays a denial.
    if (!isUuid(id)) return false;

    const scope = await this.workflowScope(id);
    if (!scope.found) return false;
    if (scope.targets.length === 0) {
      if (scope.declaresTargets) return true;
      return scope.ownerId !== null && scope.ownerId === context.subject.idpId;
    }
    if (grant.scopeType === 'domain') {
      return scope.targets.every(
        (target) => target.domain !== null && target.domain === grant.scopeId,
      );
    }
    const [only] = scope.targets;
    return (
      scope.targets.length === 1 &&
      only !== undefined &&
      grant.scopeId !== null &&
      only.instanceId === grant.scopeId
    );
  }

  private async workflowScope(id: string): Promise<{
    readonly found: boolean;
    readonly ownerId: string | null;
    /** The definition names at least one write target, resolved or not. */
    readonly declaresTargets: boolean;
    readonly targets: readonly {
      readonly entryKey: string;
      readonly domain: string | null;
      readonly instanceId: string;
    }[];
  }> {
    try {
      const result = await this.pool.query<{
        owner_id: string | null;
        entry_key: string | null;
        domain: string | null;
        instance_id: string | null;
        granularity: string | null;
      }>(WORKFLOW_SCOPE_SQL, [id]);
      if (result.rows.length === 0) {
        return { found: false, ownerId: null, declaresTargets: false, targets: [] };
      }

      const byEntry = new Map<
        string,
        { domain: string | null; candidates: { instanceId: string; granularity: string | null }[] }
      >();
      for (const row of result.rows) {
        if (row.entry_key === null) continue;
        const bucket = byEntry.get(row.entry_key) ?? { domain: row.domain, candidates: [] };
        if (row.instance_id !== null) {
          bucket.candidates.push({ instanceId: row.instance_id, granularity: row.granularity });
        }
        byEntry.set(row.entry_key, bucket);
      }

      const targets: { entryKey: string; domain: string | null; instanceId: string }[] = [];
      for (const [entryKey, bucket] of byEntry) {
        const chosen = selectEgressInstance(bucket.candidates, 'write');
        if (chosen === undefined) continue;
        targets.push({ entryKey, domain: bucket.domain, instanceId: chosen.instanceId });
      }

      return {
        found: true,
        ownerId: result.rows[0]?.owner_id ?? null,
        declaresTargets: byEntry.size > 0,
        targets,
      };
    } catch (error) {
      // Fail closed: an unreachable database must never read as "this grant covers everything".
      this.logger.warn(
        `workflow scope resolution failed; treating as unresolved (${String(error)})`,
      );
      return { found: false, ownerId: null, declaresTargets: false, targets: [] };
    }
  }

  private async deny(
    context: RequestContext,
    policyKey: PolicyKey,
    resource: PolicyResource,
    version: number,
    reason: string,
  ): Promise<PolicyDecision> {
    // Fail closed in the security direction: an audit outage logs the failure and the denial stands.
    await this.audit
      .denied({
        actorType:
          context.actorType === 'service'
            ? 'service'
            : context.actorType === 'anonymous'
              ? 'system'
              : 'user',
        actorId: context.subject.idpId,
        targetType: resource.type,
        targetId: resource.id.length > 0 ? resource.id : policyKey,
        detail: { policyKey, policyVersion: version, reason, role: context.role },
        requestId: context.requestId,
      })
      .catch((error: unknown) => {
        this.logger.error({
          msg: 'denied request could not be audited',
          policyKey,
          err: error instanceof Error ? error.message : String(error),
        });
      });

    this.logger.warn({
      msg: 'access denied',
      policyKey,
      policyVersion: version,
      policyId: context.subject.idpId,
      resource: resource.type,
      reason,
    });

    return { allowed: false, policyVersion: version, reason };
  }

  private cacheKey(
    version: number,
    sub: string,
    policyKey: PolicyKey,
    resource: PolicyResource,
  ): string {
    return `seamnex:pdp:${version}:${sub}:${policyKey}:${resource.type}:${resource.id}`;
  }

  private async cacheAllow(key: string): Promise<void> {
    await this.redis.set(key, 'allow', 'EX', 60).catch((error: unknown) => {
      this.logger.warn(`decision cache unavailable (${String(error)})`);
    });
  }
}

/**
 * The write targets of a workflow, or of the workflow a run belongs to.
 *
 * One statement, because the route resolves `GET /workflow-runs/:runId` and
 * `POST /workflow-runs/:runId/replay` to a *run* id while every other workflow path carries the
 * definition's. Instances are aggregated per entry key: a product may be deployed twice, and the
 * decision is about the domain and about whether the grant is the single write target, not about
 * which of two deployments an egress plan would pick (that is `WorkflowAuthority`'s job).
 *
 * `deleted_at IS NULL` matters: a torn-down instance is not a write target, and counting it would
 * deny a definition that can no longer write anywhere.
 */
/**
 * A workflow (or one of its runs) with one row per deployed instance of each write target.
 *
 * The instance rows are selected down to one per entry key in TypeScript with the same
 * `selectEgressInstance` the compiler uses: a read must be authorised against the deployment the
 * run would write to, or a caller could create a definition and then be refused the screen that
 * shows it.
 */
const WORKFLOW_SCOPE_SQL = `
  WITH definition AS (
    SELECT w.id, w.owner_idp_id, w.write_targets
      FROM workflow w
     WHERE w.id = $1::uuid
    UNION ALL
    SELECT w.id, w.owner_idp_id, w.write_targets
      FROM workflow_run r
      JOIN workflow w ON w.id = r.workflow_id
     WHERE r.id = $1::uuid
    LIMIT 1
  )
  SELECT d.owner_idp_id AS owner_id,
         t.entry_key,
         c.domain,
         i.id AS instance_id,
         seamnex_effective_granularity(i.id) AS granularity
    FROM definition d
    LEFT JOIN LATERAL unnest(d.write_targets) AS t(entry_key) ON TRUE
    LEFT JOIN instance i ON i.entry_key = t.entry_key AND i.deleted_at IS NULL
    LEFT JOIN catalog_entry c ON c.key = t.entry_key
   ORDER BY t.entry_key, i.id`;
