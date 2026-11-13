import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CAPABILITY_MATRIX,
  isReservedPolicyKey,
  requiresMfa,
  scopeRuleFor,
  type Capability,
  type PolicyKey,
  type PolicyResource,
} from '@seamnex/domain';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import type { RequestContext } from '../../common/identity/request-context';
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

    const domain = await this.domainOf(resource);
    if (rule === 'domain') {
      if (grant.scopeType === 'domain') return grant.scopeId !== null && grant.scopeId === domain;
      if (grant.scopeType === 'instance' && resource.type === 'instance') {
        return grant.scopeId === resource.id;
      }
      return false;
    }

    // `instance` rule.
    const instanceId = resource.type === 'instance' ? resource.id : null;
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
