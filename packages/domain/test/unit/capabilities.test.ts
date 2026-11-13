import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  MFA_REQUIRED_CAPABILITIES,
  accessFor,
  can,
  canMutate,
  requiresMfa,
  scopedReason,
} from '../../src/capabilities';
import { PLATFORM_ROLES } from '../../src/enums';

describe('capability matrix (§5.2)', () => {
  it('declares an access level for every capability and every role', () => {
    for (const capability of CAPABILITIES) {
      const row = CAPABILITY_MATRIX[capability];
      expect(row, `missing matrix row for ${capability}`).toBeDefined();
      for (const role of PLATFORM_ROLES) {
        expect(['full', 'scoped', 'none'], `${capability} × ${role}`).toContain(row[role]);
      }
    }
  });

  it('denies by default: an unknown capability is not reachable', () => {
    // @ts-expect-error — the guard must also hold for callers that bypass the type system.
    expect(() => can('R1', 'does.not.exist')).toThrow();
  });

  it('explains a scoped grant and a refusal differently', () => {
    // A `scoped` grant points at the approval flow; a `none` grant points at an administrator.
    expect(scopedReason('R6', 'portal.launch')).toMatch(/through an approval flow/);
    expect(scopedReason('R2', 'portal.launch')).toMatch(/does not hold this capability/);
  });

  it('separates read from write for the user directory (design §10.3)', () => {
    expect(can('R1', 'identity.view_users')).toBe(true);
    expect(can('R2', 'identity.view_users')).toBe(true);
    expect(canMutate('R2', 'identity.manage_users')).toBe(false);
    expect(canMutate('R1', 'identity.manage_users')).toBe(true);
  });

  it('keeps the auditor out of every mutating surface', () => {
    const mutating: (typeof CAPABILITIES)[number][] = [
      'portal.launch',
      'instance.deploy',
      'instance.lifecycle',
      'instance.configure',
      'instance.env',
      'instance.backup',
      'identity.manage_users',
      'identity.manage_groups',
      'entitlement.grant',
      'product.assign_roles',
      'metadata.manage',
      'exception.decide',
      'alert.configure',
      'maintenance.configure',
      'workflow.author',
      'workflow.run',
      'workflow.credentials',
      'breakglass.request',
      'recovery.manage',
      'privacy.manage',
      'settings.manage',
    ];
    const allowed = mutating.filter((capability) => canMutate('R2', capability));
    expect(allowed).toEqual([]);
  });

  it('gives only the platform administrator platform-wide recovery rights', () => {
    expect(canMutate('R1', 'recovery.manage')).toBe(true);
    for (const role of ['R2', 'R3', 'R4', 'R5', 'R6'] as const) {
      expect(canMutate(role, 'recovery.manage'), role).toBe(false);
    }
  });

  it('does not let the exception requester decide their own exception (NFR-4.15)', () => {
    expect(canMutate('R2', 'exception.decide')).toBe(false);
    expect(canMutate('R3', 'exception.decide')).toBe(true);
    expect(canMutate('R1', 'exception.decide')).toBe(true);
  });

  it('treats scoped as permitted-but-narrower and explains it', () => {
    expect(accessFor('R3', 'instance.configure')).toBe('scoped');
    expect(can('R3', 'instance.configure')).toBe(true);
    expect(canMutate('R3', 'instance.configure')).toBe(false);
    expect(scopedReason('R3', 'instance.configure')).toMatch(/narrower scope|approval flow/);
  });

  it('never grants the guest anything beyond the portal surfaces', () => {
    for (const capability of CAPABILITIES) {
      if (accessFor('R6', capability) === 'none') continue;
      expect(capability.startsWith('portal.'), capability).toBe(true);
    }
  });
});

/**
 * ADR-BE-13: the matrix answers "may this role", the step-up policy answers "with which assurance".
 * Keeping the second list small is the point — a capability that needs a factor nobody has enrolled
 * becomes a lockout, not a control.
 */
describe('step-up policy (ADR-BE-13)', () => {
  it('covers only the roles the MFA policy names', () => {
    expect(requiresMfa('R1', 'settings.manage')).toBe(true);
    expect(requiresMfa('R2', 'audit.export')).toBe(true);
    for (const role of ['R3', 'R4', 'R5', 'R6'] as const) {
      expect(requiresMfa(role, 'settings.manage'), role).toBe(false);
    }
  });

  it('never asks for a factor on a capability the role cannot use anyway', () => {
    for (const capability of MFA_REQUIRED_CAPABILITIES) {
      expect(can('R1', capability), capability).toBe(true);
    }
  });

  it('leaves ordinary reads and portal actions alone', () => {
    expect(requiresMfa('R1', 'audit.view')).toBe(false);
    expect(requiresMfa('R1', 'portal.launch')).toBe(false);
    expect(requiresMfa('R1', 'settings.view')).toBe(false);
  });
});
