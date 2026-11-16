import { accessFor } from './capabilities';
import type { AccessMode, PlatformRole } from './enums';

/**
 * FR-4.11 / AC-47 / NFR-4.4 — who may approve a break-glass elevation.
 *
 * The rule is stated once, here, because three callers need the same answer: the API's decision
 * transaction, the console's affordance and the mock platform the console tests run against. It was
 * previously written in the console alone (`BreakGlassPage.tsx`), which is the defect `ISSUE-05`
 * records: a caller talking to the API directly could have a read-write elevation approved by an R2
 * auditor, and the approval was then audited as legitimate.
 *
 * Approver eligibility follows the **request**, not the approver's role alone:
 *
 *  - **R2 auditors** hold `breakglass.approve` as `scoped`, so they may approve a read-only
 *    elevation only. A read-write elevation needs the owner of the affected domain.
 *  - **R3 domain owners** hold it as `full` and may approve either mode, but only for an elevation
 *    targeting an instance in a domain they own. A platform-scoped binding owns everything.
 *  - **Everyone else** does not hold the capability at all; the route's policy decision answers that
 *    before this rule is consulted.
 *
 * The mode comes from the capability matrix rather than a hardcoded role name, so changing the
 * matrix moves the rule with it. A scoped grant (R2) is *not* a weaker yes that a UI can upgrade.
 */

/** The subset of `role_binding` this rule reads. `scopeId` is null only for a platform scope. */
export type ApprovalGrant = {
  readonly role: PlatformRole;
  readonly scopeType: 'platform' | 'domain' | 'instance';
  readonly scopeId: string | null;
};

/**
 * What the elevation would touch: `catalog_entry.domain` of the target instance (the specific
 * domain, not the cluster) and that instance's id. Both are nullable because `instance_id` may be
 * unset and an entry may declare no domain — an unresolved target is refused, never assumed.
 */
export type BreakGlassTarget = {
  readonly instanceId: string | null;
  readonly domain: string | null;
};

export type BreakGlassApprovalFacts = {
  /** The role the session carries; used only for the message, never for the decision. */
  readonly role: PlatformRole;
  readonly accessMode: AccessMode;
  /** The approver's live grants, already resolved with the platform's binding fallback. */
  readonly grants: readonly ApprovalGrant[];
  readonly target: BreakGlassTarget;
};

/**
 * Two refusals, because each has a different fix: an auditor cannot become the domain owner by
 * retrying, and a domain owner of another domain cannot widen their own binding.
 */
export type BreakGlassApprovalRefusalCode = 'APPROVAL_MODE_FORBIDDEN' | 'APPROVAL_SCOPE_FORBIDDEN';

export type BreakGlassApprovalRefusal = {
  readonly code: BreakGlassApprovalRefusalCode;
  readonly detail: string;
  readonly remediation: string;
};

/**
 * The mode half of the rule, for a caller that knows only the role: a `full` grant approves either
 * mode, a `scoped` grant approves a read-only elevation only.
 *
 * The console uses this to disable a button it must not offer; the server calls it through
 * `breakGlassApprovalRefusal`, which also resolves the target scope.
 */
export function mayApproveAccessMode(role: PlatformRole, accessMode: AccessMode): boolean {
  const access = accessFor(role, 'breakglass.approve');
  if (access === 'none') return false;
  return access === 'full' || accessMode === 'read_only';
}

/**
 * The verdict, or `null` when the approver may decide this request.
 *
 * `null` is also the answer when the grant set holds no `breakglass.approve` at all: that is the
 * capability matrix's refusal, already answered by the route policy, and inventing a second one
 * here would tell the caller to ask a domain owner for a capability they may never hold.
 */
export function breakGlassApprovalRefusal(
  facts: BreakGlassApprovalFacts,
): BreakGlassApprovalRefusal | null {
  const approvals = facts.grants
    .map((grant) => ({ grant, access: accessFor(grant.role, 'breakglass.approve') }))
    .filter(({ access }) => access !== 'none');
  if (approvals.length === 0) return null;

  const covers = (grant: ApprovalGrant): boolean => {
    if (grant.scopeType === 'platform') return true;
    if (grant.scopeType === 'domain') {
      return facts.target.domain !== null && grant.scopeId === facts.target.domain;
    }
    return facts.target.instanceId !== null && grant.scopeId === facts.target.instanceId;
  };

  // A `full` grant is mode-agnostic; a `scoped` grant reaches this point only for a read-only
  // request. Anything left is the mode rule, which is answered before the scope rule so an auditor
  // is told the mode is the problem rather than where the instance lives.
  const eligible = approvals.filter(
    ({ access }) => access === 'full' || facts.accessMode === 'read_only',
  );
  if (eligible.some(({ grant }) => covers(grant))) return null;

  if (eligible.length === 0) {
    return {
      code: 'APPROVAL_MODE_FORBIDDEN',
      detail: `${facts.role} may approve read-only elevations only, and this request asks for read-write access.`,
      remediation:
        'Ask the owner of the affected domain to approve this elevation. An auditor can decline it instead.',
    };
  }

  const where = facts.target.domain ?? facts.target.instanceId ?? 'the affected product';
  return {
    code: 'APPROVAL_SCOPE_FORBIDDEN',
    detail: `The elevation targets ${where}, which is outside the domains you own.`,
    remediation:
      'Ask an approver who owns that domain, or a platform administrator, to decide this request.',
  };
}
