import type { PlatformRole } from './enums';

/**
 * FR-5.9 / DD-08 / AC-26 / NFR-4.4 — who may write through a workflow.
 *
 * The rule is stated once, here, because three callers need the same answer: the API's authoring
 * gate, the mock platform a screen may be talking to, and the tests that prove the negative cases.
 * It was previously written twice — once as a mock helper and not at all in the API — which is the
 * defect `ISSUE-04` records.
 *
 * Authority follows the **write targets**, never the workflow's existence:
 *
 *  - R1 holds platform authority only, so writing through a product is break-glass: a time-boxed,
 *    justification-recorded, audited elevation on *that* instance (§5.1, FR-4.11).
 *  - R3 needs the product's domain for **every** write target.
 *  - R4 needs the specific instance, and only when it is the **only** write target: authority over
 *    one product is not authority over a pipeline through three.
 *  - Read-only targets need no write authority at all ("entitlement only"), so a definition that
 *    writes nowhere is not gated by this rule.
 */

export type WorkflowGrantScope = 'platform' | 'domain' | 'instance';

/** The subset of `role_binding` this rule reads. `scopeId` is null only for a platform scope. */
export type WorkflowGrant = {
  readonly role: PlatformRole;
  readonly scopeType: WorkflowGrantScope;
  readonly scopeId: string | null;
};

/**
 * One product a definition writes to, resolved to the instance the run will actually call.
 *
 * `domain` is `catalog_entry.domain` (the specific domain, not the cluster): "Revenue & Customer"
 * groups D1-D4 and is not a domain any R3 is granted. `product` is the display name when the
 * catalogue knows it.
 */
export type WorkflowWriteTarget = {
  readonly instanceId: string;
  readonly entryKey: string;
  readonly domain: string | null;
  readonly product: string | null;
};

/**
 * Why one target was refused. The kinds are distinct because each has a different fix: an operator
 * cannot turn a missing elevation into a domain grant by retrying.
 *
 * `unresolved` is the API's fail-closed answer when the targets themselves could not be read. It is
 * a refusal rather than a `500` on purpose: the write did not happen either way, and a `5xx` would
 * invite a retry loop against a platform that is already refusing to answer.
 */
export type WorkflowAuthorityMissing =
  'elevation' | 'domain' | 'sole-target' | 'instance' | 'role' | 'unresolved';

export type WorkflowAuthorityRefusal = {
  readonly instanceId: string;
  readonly entryKey: string;
  readonly missing: WorkflowAuthorityMissing;
  /** Names the target and the authority that is absent. */
  readonly detail: string;
  readonly remediation: string;
};

/**
 * The elevation an R1 request leaned on, recorded on the change it authorised.
 *
 * `elevationId` rather than `sessionId`: the audit detail passes through the platform's key-based
 * masker, which masks anything matching `session[-_]?id` — an auth-session rule that would blank the
 * one identifier the audit trail needs to point at the grant that was exercised.
 */
export type WorkflowElevationUsed = {
  readonly instanceId: string;
  readonly elevationId: string;
};

export type WorkflowAuthorityInput = {
  readonly grants: readonly WorkflowGrant[];
  readonly targets: readonly WorkflowWriteTarget[];
  /** instanceId → active read-write break-glass session id, for the requesting actor only. */
  readonly elevations: ReadonlyMap<string, string>;
};

/**
 * A denial always names at least one target: a caller has to be told *which* product refused, and a
 * verdict that said "not permitted" without one would be unprintable. Encoded in the type so the
 * refusal path needs no unreachable fallback.
 */
export type WorkflowAuthorityRefusalList = readonly [
  WorkflowAuthorityRefusal,
  ...WorkflowAuthorityRefusal[],
];

export type WorkflowAuthorityVerdict =
  | {
      readonly allowed: true;
      readonly refusals: readonly [];
      readonly elevations: readonly WorkflowElevationUsed[];
    }
  | {
      readonly allowed: false;
      readonly refusals: WorkflowAuthorityRefusalList;
      readonly elevations: readonly WorkflowElevationUsed[];
    };

/** Roles the rule knows how to authorise through a write target. */
const WRITING_ROLES: readonly PlatformRole[] = ['R1', 'R3', 'R4'];

export function workflowWriteAuthority(input: WorkflowAuthorityInput): WorkflowAuthorityVerdict {
  // A platform-scoped grant covers everything, exactly as `PdpService.scopeCovers` reads it. Keeping
  // the two in step matters: the route layer must not admit a statement this rule then refuses for
  // an unrelated reason.
  const scopedToEverything = (grant: WorkflowGrant): boolean => grant.scopeType === 'platform';

  const holds = (roles: readonly PlatformRole[]): boolean =>
    input.grants.some((grant) => roles.includes(grant.role));

  const domainGrant = (target: WorkflowWriteTarget): boolean =>
    input.grants.some(
      (grant) =>
        grant.role === 'R3' &&
        (scopedToEverything(grant) ||
          (grant.scopeType === 'domain' &&
            grant.scopeId !== null &&
            grant.scopeId === target.domain)),
    );

  const instanceGrant = (target: WorkflowWriteTarget): boolean =>
    input.grants.some(
      (grant) =>
        grant.role === 'R4' &&
        (scopedToEverything(grant) ||
          (grant.scopeType === 'instance' && grant.scopeId === target.instanceId) ||
          (grant.scopeType === 'domain' &&
            grant.scopeId !== null &&
            grant.scopeId === target.domain)),
    );

  /*
   * Duplicate targets would otherwise multiply the refusals for one product: the persisted
   * `write_targets` is a set of entry keys, and two nodes on one product mint one scope.
   */
  const targets = [...new Map(input.targets.map((target) => [target.instanceId, target])).values()];

  if (targets.length === 0) {
    // Read-only targets require entitlement only, and the capability matrix already decided that at
    // the route. Inventing a write-authority gate here would refuse a workflow nobody writes through.
    return { allowed: true, refusals: [], elevations: [] };
  }

  const holdsR1 = holds(['R1']);
  const holdsR3 = holds(['R3']);
  const holdsR4 = holds(['R4']);
  const refusals: WorkflowAuthorityRefusal[] = [];
  const elevations: WorkflowElevationUsed[] = [];

  for (const target of targets) {
    // Standing authority first: an elevation that was not needed must not be recorded as used.
    if (domainGrant(target)) continue;

    if (instanceGrant(target) && targets.length === 1) continue;

    if (holdsR1) {
      const elevationId = input.elevations.get(target.instanceId);
      if (elevationId !== undefined) {
        elevations.push({ instanceId: target.instanceId, elevationId });
        continue;
      }
      refusals.push({
        instanceId: target.instanceId,
        entryKey: target.entryKey,
        missing: 'elevation',
        detail: `Writing through ${labelOf(target)} needs a break-glass session: R1 authority inside a product is time-boxed and recorded, never standing.`,
        remediation: `Request a read-write break-glass session for ${labelOf(target)}, have a second party approve it, then retry.`,
      });
      continue;
    }

    if (instanceGrant(target)) {
      refusals.push({
        instanceId: target.instanceId,
        entryKey: target.entryKey,
        missing: 'sole-target',
        detail: `A product administrator may write to exactly one instance, and this workflow writes to ${targets.length}.`,
        remediation:
          'Keep a single write target, or ask the owner of the affected domain to author the workflow.',
      });
      continue;
    }

    if (holdsR3) {
      refusals.push({
        instanceId: target.instanceId,
        entryKey: target.entryKey,
        missing: 'domain',
        detail: `${labelOf(target)} is outside the domains you own.`,
        remediation:
          'Remove that write target, or ask the platform administrator to grant your domain the product.',
      });
      continue;
    }

    if (holdsR4) {
      refusals.push({
        instanceId: target.instanceId,
        entryKey: target.entryKey,
        missing: 'instance',
        detail: `You do not administer ${labelOf(target)}.`,
        remediation: 'Remove that write target, or ask the administrator of that instance.',
      });
      continue;
    }

    refusals.push({
      instanceId: target.instanceId,
      entryKey: target.entryKey,
      missing: 'role',
      detail: `This role cannot author workflows; ${labelOf(target)} is a write target.`,
      remediation:
        'Workflow authoring needs platform or domain authority. Ask the platform administrator.',
    });
  }

  const [first, ...rest] = refusals;

  return first === undefined
    ? { allowed: true, refusals: [], elevations }
    : {
        allowed: false,
        refusals: [first, ...rest],
        // Only elevations this verdict actually relied on: an R1 with standing domain authority must
        // not leave an elevation recorded as used.
        elevations,
      };
}

/**
 * Whether a role could author a workflow at all, before any target is known.
 *
 * The route layer needs this for `POST /workflows`, which has no definition yet: the decision there
 * is "this role may use the capability", and the target rule runs in the service before the first
 * write. Exported so the two cannot drift.
 */
export function canAuthorWorkflows(grants: readonly WorkflowGrant[]): boolean {
  return grants.some((grant) => WRITING_ROLES.includes(grant.role));
}

/** The operator-facing name of a write target: product and entry key, never a bare UUID. */
export function labelOf(target: Pick<WorkflowWriteTarget, 'entryKey' | 'product'>): string {
  return target.product === null || target.product.length === 0
    ? target.entryKey
    : `${target.product} (${target.entryKey})`;
}
