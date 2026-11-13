import type { PlatformRole } from './enums';
import { PLATFORM_ROLES } from './enums';

export const CAPABILITIES = [
  'portal.sign_in',
  'portal.view_entitlements',
  'portal.launch',
  'portal.view_status',
  'catalog.browse',
  'catalog.read_metadata',
  'instance.deploy',
  'instance.lifecycle',
  'instance.configure',
  'instance.env',
  'instance.backup',
  'instance.view_logs',
  'identity.view_users',
  'identity.manage_users',
  'identity.manage_groups',
  'entitlement.grant',
  'product.assign_roles',
  'audit.view',
  'audit.verify',
  'audit.export',
  'license.view',
  'license.manage',
  'capacity.view',
  'metadata.manage',
  'exception.decide',
  'alert.configure',
  'maintenance.configure',
  'workflow.author',
  'workflow.run',
  'workflow.view_runs',
  'workflow.credentials',
  'workflow.approve',
  'breakglass.request',
  'breakglass.approve',
  'breakglass.revoke',
  'recovery.view',
  'recovery.manage',
  'privacy.view',
  'privacy.manage',
  'access.request',
  'registry.view',
  'patch.view',
  'posture.view',
  'settings.view',
  'settings.manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type Access = 'full' | 'scoped' | 'none';

/**
 * Requirements §5.2 capability matrix.
 * `full` = permitted; `scoped` = permitted within a narrower scope, a request flow, or a
 * break-glass session; `none` = denied. The evaluator is deny-by-default.
 */
export const CAPABILITY_MATRIX = {
  'portal.sign_in': { R1: 'full', R2: 'full', R3: 'full', R4: 'full', R5: 'full', R6: 'scoped' },
  'portal.view_entitlements': {
    R1: 'full',
    R2: 'full',
    R3: 'full',
    R4: 'full',
    R5: 'full',
    R6: 'none',
  },
  'portal.launch': { R1: 'full', R2: 'none', R3: 'full', R4: 'full', R5: 'full', R6: 'scoped' },
  'portal.view_status': {
    R1: 'full',
    R2: 'full',
    R3: 'full',
    R4: 'full',
    R5: 'full',
    R6: 'scoped',
  },
  'catalog.browse': { R1: 'full', R2: 'full', R3: 'full', R4: 'full', R5: 'scoped', R6: 'none' },
  'catalog.read_metadata': {
    R1: 'full',
    R2: 'full',
    R3: 'full',
    R4: 'full',
    R5: 'scoped',
    R6: 'none',
  },
  'instance.deploy': { R1: 'full', R2: 'none', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'instance.lifecycle': { R1: 'full', R2: 'none', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'instance.configure': {
    R1: 'full',
    R2: 'none',
    R3: 'scoped',
    R4: 'scoped',
    R5: 'none',
    R6: 'none',
  },
  'instance.env': { R1: 'full', R2: 'none', R3: 'scoped', R4: 'scoped', R5: 'none', R6: 'none' },
  'instance.backup': { R1: 'full', R2: 'none', R3: 'scoped', R4: 'none', R5: 'none', R6: 'none' },
  'instance.view_logs': {
    R1: 'full',
    R2: 'full',
    R3: 'scoped',
    R4: 'scoped',
    R5: 'none',
    R6: 'none',
  },
  /**
   * Read-only directory evidence. Design §10.3 grants `GET /admin/users` to R1 and R2,
   * while mutations stay on `identity.manage_users` (full = R1 only). Keeping read and
   * write apart is what removes the old role-literal gate on the users route.
   */
  'identity.view_users': { R1: 'full', R2: 'full', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'identity.manage_users': {
    R1: 'full',
    R2: 'none',
    R3: 'scoped',
    R4: 'scoped',
    R5: 'none',
    R6: 'none',
  },
  'identity.manage_groups': {
    R1: 'full',
    R2: 'none',
    R3: 'scoped',
    R4: 'none',
    R5: 'none',
    R6: 'none',
  },
  'entitlement.grant': {
    R1: 'full',
    R2: 'none',
    R3: 'scoped',
    R4: 'scoped',
    R5: 'none',
    R6: 'none',
  },
  'product.assign_roles': {
    R1: 'scoped',
    R2: 'none',
    R3: 'scoped',
    R4: 'scoped',
    R5: 'none',
    R6: 'none',
  },
  'audit.view': { R1: 'full', R2: 'full', R3: 'scoped', R4: 'scoped', R5: 'none', R6: 'none' },
  'audit.verify': { R1: 'full', R2: 'full', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'audit.export': { R1: 'full', R2: 'full', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'license.view': { R1: 'full', R2: 'full', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  /**
   * Design §10.3: `/licenses` is R1 (R2 read). The register is a release gate, so the
   * hosted-service toggle is its own capability — an auditor who may read the register must not
   * be able to change the configuration it certifies (AC-44).
   */
  'license.manage': { R1: 'full', R2: 'none', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'capacity.view': { R1: 'full', R2: 'full', R3: 'scoped', R4: 'none', R5: 'none', R6: 'none' },
  'metadata.manage': { R1: 'full', R2: 'scoped', R3: 'scoped', R4: 'none', R5: 'none', R6: 'none' },
  /** NFR-4.15: a policy exception needs a second party; the requester (R2) may not decide it. */
  'exception.decide': { R1: 'full', R2: 'none', R3: 'full', R4: 'none', R5: 'none', R6: 'none' },
  'alert.configure': { R1: 'full', R2: 'none', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'maintenance.configure': {
    R1: 'full',
    R2: 'none',
    R3: 'none',
    R4: 'none',
    R5: 'none',
    R6: 'none',
  },
  'workflow.author': {
    R1: 'scoped',
    R2: 'none',
    R3: 'scoped',
    R4: 'scoped',
    R5: 'none',
    R6: 'none',
  },
  'workflow.run': { R1: 'scoped', R2: 'none', R3: 'scoped', R4: 'scoped', R5: 'none', R6: 'none' },
  'workflow.view_runs': {
    R1: 'full',
    R2: 'full',
    R3: 'scoped',
    R4: 'scoped',
    R5: 'none',
    R6: 'none',
  },
  'workflow.credentials': {
    R1: 'full',
    R2: 'none',
    R3: 'scoped',
    R4: 'none',
    R5: 'none',
    R6: 'none',
  },
  /**
   * FR-5.10: a human decision on a waiting approval node. It is not `workflow.run` — running a
   * workflow does not imply the right to approve someone else's write, and the token, not the
   * route, identifies the run, so the scope rule is `request`.
   */
  'workflow.approve': { R1: 'full', R2: 'none', R3: 'full', R4: 'scoped', R5: 'none', R6: 'none' },
  'breakglass.request': {
    R1: 'scoped',
    R2: 'none',
    R3: 'none',
    R4: 'none',
    R5: 'none',
    R6: 'none',
  },
  'breakglass.approve': {
    R1: 'none',
    R2: 'scoped',
    R3: 'full',
    R4: 'none',
    R5: 'none',
    R6: 'none',
  },
  'breakglass.revoke': { R1: 'full', R2: 'none', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'recovery.view': { R1: 'full', R2: 'full', R3: 'scoped', R4: 'none', R5: 'none', R6: 'none' },
  'recovery.manage': { R1: 'full', R2: 'none', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'privacy.view': { R1: 'full', R2: 'full', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'privacy.manage': { R1: 'full', R2: 'none', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'access.request': { R1: 'none', R2: 'none', R3: 'none', R4: 'none', R5: 'scoped', R6: 'none' },
  'registry.view': { R1: 'full', R2: 'full', R3: 'full', R4: 'full', R5: 'none', R6: 'none' },
  'patch.view': { R1: 'full', R2: 'full', R3: 'scoped', R4: 'none', R5: 'none', R6: 'none' },
  'posture.view': { R1: 'full', R2: 'full', R3: 'scoped', R4: 'none', R5: 'none', R6: 'none' },
  'settings.view': { R1: 'full', R2: 'full', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
  'settings.manage': { R1: 'full', R2: 'none', R3: 'none', R4: 'none', R5: 'none', R6: 'none' },
} as const satisfies Record<Capability, Record<PlatformRole, Access>>;

/**
 * Step-up policy (ADR-BE-13).
 *
 * The matrix answers "may this role do this?"; it cannot answer "with which assurance?". These two
 * roles are the ones whose accounts the platform requires a second factor for (AC-46), and these
 * capabilities are the ones whose misuse is not recoverable by a support ticket: settings, the
 * identity directory, the license register, recovery, privacy execution, break-glass revocation,
 * deploy/lifecycle, workflow credentials and audit export.
 *
 * The PDP refuses such a capability when the *session* does not carry a satisfied second factor.
 * In the stub directory the two roles always enrol, so the gate is invisible there; it is the live
 * provider (Phase 4D) that can assert `pwd` alone, and this is where that assertion stops.
 */
export const MFA_REQUIRED_ROLES: readonly PlatformRole[] = ['R1', 'R2'];

export const MFA_REQUIRED_CAPABILITIES: readonly Capability[] = [
  'settings.manage',
  'alert.configure',
  'maintenance.configure',
  'identity.manage_users',
  'identity.manage_groups',
  'license.manage',
  'metadata.manage',
  'recovery.manage',
  'privacy.manage',
  'breakglass.revoke',
  'instance.deploy',
  'instance.lifecycle',
  'workflow.credentials',
  'audit.export',
];

/** True when this role needs a satisfied second factor to use this capability at all. */
export function requiresMfa(role: PlatformRole, capability: Capability): boolean {
  return (
    MFA_REQUIRED_ROLES.includes(role) &&
    (MFA_REQUIRED_CAPABILITIES as readonly string[]).includes(capability)
  );
}

export function accessFor(role: PlatformRole, capability: Capability): Access {
  return CAPABILITY_MATRIX[capability][role];
}

export function can(role: PlatformRole, capability: Capability): boolean {
  return accessFor(role, capability) !== 'none';
}

/** Mutating UI affordances are only enabled on a `full` grant; `scoped` shows a request path. */
export function canMutate(role: PlatformRole, capability: Capability): boolean {
  return accessFor(role, capability) === 'full';
}

export function scopedReason(role: PlatformRole, capability: Capability): string {
  const access = accessFor(role, capability);
  if (access === 'none')
    return `${role} does not hold this capability. Ask a platform administrator.`;
  return `${role} holds this capability only within a narrower scope or through an approval flow.`;
}

export const ROLES: readonly PlatformRole[] = PLATFORM_ROLES;
