import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  MFA_REQUIRED_CAPABILITIES,
  accessFor,
  can,
  canMutate,
  capabilitySets,
  entryAccess,
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
      'exception.request',
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

  it('files a policy exception from R1 alone, and never from the auditor (FR-1.20)', () => {
    expect(canMutate('R1', 'exception.request')).toBe(true);
    for (const role of ['R2', 'R3', 'R4', 'R5', 'R6'] as const) {
      expect(canMutate(role, 'exception.request'), role).toBe(false);
    }
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
 * The sets are a rendering input, not a second policy: every member has to be the same answer the
 * PDP would give, or a guard and the server disagree about the same role.
 */
describe('capabilitySets', () => {
  it('is exactly can() and canMutate() over the capability list', () => {
    for (const role of PLATFORM_ROLES) {
      const { held, mutable } = capabilitySets(role);
      for (const capability of CAPABILITIES) {
        expect(held.has(capability), `${role} held ${capability}`).toBe(can(role, capability));
        expect(mutable.has(capability), `${role} mutable ${capability}`).toBe(
          canMutate(role, capability),
        );
      }
    }
  });

  it('keeps a scoped grant in held and out of mutable', () => {
    const { held, mutable } = capabilitySets('R3');
    expect(held.has('instance.view_logs')).toBe(true);
    expect(mutable.has('instance.view_logs')).toBe(false);
  });
});

/**
 * ADR-FE-01: a menu entry is a three-valued question. `can()` collapses `none` and `scoped`, which
 * is how an entry the role may only partly use came to look like one it may not open at all.
 */
describe('entryAccess', () => {
  it('answers the best of the listed capabilities', () => {
    expect(entryAccess('R1', ['instance.view_logs'])).toBe('full');
    expect(entryAccess('R3', ['instance.view_logs'])).toBe('scoped');
    expect(entryAccess('R6', ['instance.view_logs'])).toBe('none');
  });

  it('prefers a full grant over a scoped one in the same entry', () => {
    // The maintenance entry lists three capabilities with different cells per role.
    expect(entryAccess('R1', ['maintenance.configure', 'settings.view', 'exception.decide'])).toBe(
      'full',
    );
    expect(entryAccess('R3', ['maintenance.configure', 'settings.view', 'exception.decide'])).toBe(
      'full',
    );
    // An approver-only entry: the request capability is R1-scoped, approval is R2-scoped.
    expect(entryAccess('R2', ['breakglass.request', 'breakglass.approve'])).toBe('scoped');
    expect(entryAccess('R4', ['breakglass.request', 'breakglass.approve'])).toBe('none');
  });

  it('is none for an empty set, so a mis-declared entry hides instead of opening', () => {
    expect(entryAccess('R1', [])).toBe('none');
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
      for (const role of ['R1', 'R2'] as const) {
        if (requiresMfa(role, capability)) {
          expect(can(role, capability), `${role} ${capability}`).toBe(true);
        }
      }
    }
  });

  it('does not step up the administrator for the auditor-only review (ADR-BE-25)', () => {
    expect(can('R2', 'license.review')).toBe(true);
    expect(can('R1', 'license.review')).toBe(false);
    expect(requiresMfa('R2', 'license.review')).toBe(true);
    // A factor demanded from an operator who is denied anyway can never succeed.
    expect(requiresMfa('R1', 'license.review')).toBe(false);
  });

  it('leaves ordinary reads and portal actions alone', () => {
    expect(requiresMfa('R1', 'audit.view')).toBe(false);
    expect(requiresMfa('R1', 'portal.launch')).toBe(false);
    expect(requiresMfa('R1', 'settings.view')).toBe(false);
  });
});
