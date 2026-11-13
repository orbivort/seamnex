import { describe, expect, it } from 'vitest';
import { PLATFORM_ROLES, can, canMutate } from '@seamnex/domain';
import type { Capability, PlatformRole } from '@seamnex/domain';
import { defaultRouteFor, flatNav, navigationFor } from '../../src/navigation';

/**
 * The navigation is the console's second authorization surface: a route the guard admits but the
 * sidebar hides is unreachable in practice, and a sidebar entry the guard refuses is a dead end.
 * These tests pin both the filtering rule and the landing route for every platform role.
 */
describe('role navigation', () => {
  it('only lists entries the role can actually open', () => {
    for (const role of PLATFORM_ROLES) {
      const entries = flatNav(role);
      for (const entry of entries) {
        const admitted = entry.requireFull
          ? entry.capabilities.some((capability) => canMutate(role, capability))
          : entry.capabilities.some((capability) => can(role, capability));
        expect(admitted, `${role} ${entry.href}`).toBe(true);
      }
    }
  });

  it('drops every empty group rather than rendering a heading with no items', () => {
    for (const role of PLATFORM_ROLES) {
      const groups = navigationFor(role);
      expect(groups.every((group) => group.items.length > 0)).toBe(true);
      expect(groups).toEqual(navigationFor(role).filter((group) => group.items.length > 0));
    }
  });

  it('gives the platform administrator every group in a stable order', () => {
    const groups = navigationFor('R1');
    expect(groups.map((group) => group.label)).toEqual([
      'Operations',
      'Automation',
      'Governance',
      'Administration',
    ]);
    expect(groups[0]?.items[0]?.href).toBe('/');
  });

  it('gives an end user only the catalog it may browse', () => {
    expect(flatNav('R5').map((entry) => entry.href)).toEqual(['/catalog']);
  });

  it('gives a guest no console section at all', () => {
    expect(navigationFor('R6')).toEqual([]);
    expect(flatNav('R6')).toEqual([]);
  });

  it('hides administration from a role that may only read the directory', () => {
    const admin = navigationFor('R2').find((group) => group.label === 'Administration');
    expect(admin?.items.map((item) => item.href)).toEqual(['/admin/users', '/admin/settings']);
  });

  it('requires an outright grant for administration, not a scoped one', () => {
    // R3 holds `identity.manage_groups` and `identity.manage_users` only as `scoped`.
    const admin = navigationFor('R3').find((group) => group.label === 'Administration');
    expect(admin).toBeUndefined();
  });

  it('keeps break-glass reachable for the approver and the requester alike', () => {
    const governance = (role: PlatformRole) =>
      navigationFor(role)
        .flatMap((group) => group.items)
        .find((item) => item.href === '/governance/break-glass');

    expect(governance('R1')).toBeDefined();
    expect(governance('R2')).toBeDefined();
    expect(governance('R3')).toBeDefined();
    expect(governance('R4')).toBeUndefined();
  });

  it('marks the admin entries that need an unscoped grant', () => {
    const entries = flatNav('R1');
    const requiresFull = entries.filter((entry) => entry.requireFull).map((entry) => entry.href);
    expect(requiresFull).toEqual(['/admin/groups', '/admin/identity-sync', '/admin/settings']);
  });

  it('lands each role on the first surface it may read', () => {
    expect(defaultRouteFor('R1')).toBe('/');
    expect(defaultRouteFor('R2')).toBe('/');
    expect(defaultRouteFor('R3')).toBe('/');
    // A product administrator has no capacity board but may read instances.
    expect(defaultRouteFor('R4')).toBe('/instances');
    // End users and guests belong to the portal.
    expect(defaultRouteFor('R5')).toBe('/forbidden');
    expect(defaultRouteFor('R6')).toBe('/forbidden');
  });

  it('never lands a role on a route its own sidebar hides', () => {
    for (const role of PLATFORM_ROLES) {
      const route = defaultRouteFor(role);
      if (route === '/forbidden') continue;
      expect(flatNav(role).map((entry) => entry.href)).toContain(route);
    }
  });

  it('labels every entry and carries an icon component', () => {
    for (const entry of flatNav('R1')) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.icon).toBeTypeOf('object');
    }
  });

  it('answers the mutation question through the same matrix the guards use', () => {
    // Guards ask `canMutate`; navigation asks `canMutate` for `requireFull` entries. If the two
    // disagree, an admin screen opens and immediately renders its own 403.
    const capability: Capability = 'settings.view';
    expect(canMutate('R2', capability)).toBe(true);
    expect(flatNav('R2').map((item) => item.href)).toContain('/admin/settings');
  });
});
