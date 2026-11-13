import { describe, expect, it } from 'vitest';
import { ROLE_IDS } from '../../../src/config/config';
import { idleRoles, roleDefinition, ROLES } from '../../../src/roles/registry';

describe('process roles', () => {
  it('declares exactly the roles of design §4.3 plus the ADR-BE-22 relay', () => {
    expect(ROLES).toHaveLength(10);
    expect(ROLES.map((role) => role.id).sort()).toEqual([...ROLE_IDS].sort());
  });

  it('describes the relay as a sign-in relay, never as single sign-on', () => {
    const relay = roleDefinition('relay');
    expect(relay.description.toLowerCase()).not.toContain('sso');
    expect(relay.description.toLowerCase()).not.toContain('single sign');
  });

  it('marks the Phase 1 roles as implemented and names the phase for the rest', () => {
    expect(roleDefinition('api').implemented).toBe(true);
    expect(roleDefinition('deploy-worker').implemented).toBe(true);
    expect(roleDefinition('scheduler').implemented).toBe(true);

    for (const id of idleRoles()) {
      const role = roleDefinition(id);
      expect(role.implemented).toBe(false);
      expect(role.phase.length).toBeGreaterThan(0);
      // An idle role must name the phase that gives it a capability — "later" is not a plan.
      expect(role.phase).toMatch(/^[0-9]/);
    }
  });

  it('gives every role a description', () => {
    for (const role of ROLES) expect(role.description.length).toBeGreaterThan(10);
  });

  it('resolves every declared role by id', () => {
    for (const id of ROLE_IDS) {
      expect(roleDefinition(id).id).toBe(id);
    }
  });

  it('refuses an unknown role rather than defaulting to the API', () => {
    expect(() => roleDefinition('not-a-role' as never)).toThrow(/Unknown role: not-a-role/);
  });

  it('reports no idle roles now that every role is implemented', () => {
    expect(idleRoles()).toEqual([]);
    expect(ROLES.every((role) => role.implemented)).toBe(true);
  });

  it('reports a role that a phase leaves idle', () => {
    const first = ROLES[0] as { implemented: boolean };
    const original = first.implemented;
    try {
      first.implemented = false;
      expect(idleRoles()).toEqual([ROLES[0]?.id]);
    } finally {
      first.implemented = original;
    }
  });

  it('names a phase for every role', () => {
    for (const role of ROLES) expect(role.phase).toMatch(/^[0-9]/);
  });
});
