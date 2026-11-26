import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_ROLES, can, canMutate, entryAccess } from '@seamnex/domain';
import type { Capability, PlatformRole } from '@seamnex/domain';
import { defaultRouteFor, flatNav, navigationFor } from '../../src/navigation';
import { CONSOLE_ROUTES, hrefOf } from '../../src/routes';

/**
 * The navigation is the console's second rendering of the policy — not a second authorization
 * surface (ADR-FE-01), but the place an operator first learns what their role reaches. These tests
 * pin the filtering rule, the scope marker and the landing route for every platform role.
 */
describe('role navigation', () => {
  it('only lists entries the role can actually open', () => {
    for (const role of PLATFORM_ROLES) {
      for (const entry of flatNav(role)) {
        const route = CONSOLE_ROUTES.find((candidate) => hrefOf(candidate) === entry.href);
        expect(route, entry.href).toBeDefined();
        const access = entryAccess(role, entry.capabilities);
        const admitted =
          access === 'full' ||
          (access === 'scoped' && route?.admits === 'any' && route.scopedRead === true);
        expect(admitted, `${role} ${entry.href}`).toBe(true);
      }
    }
  });

  /**
   * ADR-FE-01's other half: the marker is a promise that the screen works narrowly. These screens
   * hold the capability for a domain owner, but their reads are platform-wide (`/audit-events`,
   * `/posture`, `/recovery`, `/patch-register`, `/admin/access-requests` all resolve to a resource
   * with no id), so the platform answers `403`. Offering them marked SCOPED put the operator in
   * front of that refusal — the very symptom the marker was added to prevent.
   */
  it('hides a scoped screen whose read the platform cannot narrow', () => {
    const hrefs = flatNav('R3').map((entry) => entry.href);
    expect(hrefs).not.toContain('/governance/audit');
    expect(hrefs).not.toContain('/governance/patches');
    expect(hrefs).not.toContain('/governance/posture');
    expect(hrefs).not.toContain('/governance/recovery');
    expect(hrefs).not.toContain('/governance/access-requests');
  });

  it('keeps the governance screens a domain owner can actually use', () => {
    const governance = navigationFor('R3').find((group) => group.label === 'Governance');
    expect(governance?.items.map((item) => item.href)).toEqual([
      '/governance/break-glass',
      '/governance/maintenance',
    ]);
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
    // R3 holds `identity.manage_groups` and `identity.manage_users` only as `scoped`, so the
    // directory screens stay shut. `profile.request` is a full grant, which is why the group itself
    // is reachable — with exactly one item, the one the role may actually use.
    const admin = navigationFor('R3').find((group) => group.label === 'Administration');
    expect(admin?.items.map((item) => item.href)).toEqual(['/admin/environment-profiles']);
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
    const requiresFull = entries
      .filter((entry) => entry.admits === 'full')
      .map((entry) => entry.href);
    expect(requiresFull).toEqual([
      '/admin/groups',
      '/admin/identity-sync',
      '/admin/environment-profiles',
      '/admin/settings',
    ]);
  });

  /**
   * ADR-FE-01: a `scoped` grant opens the screen, so the entry stays visible and says so. Hiding it
   * would tell a domain owner that Instances is not theirs to open, which was never true.
   */
  it('marks an entry the role holds only within a narrower scope', () => {
    const instances = (role: PlatformRole) =>
      flatNav(role).find((entry) => entry.href === '/instances');

    expect(instances('R1')?.scopeLimited).toBe(false);
    expect(instances('R3')?.scopeLimited).toBe(true);
    expect(instances('R4')?.scopeLimited).toBe(true);
    // R5 holds no instance capability at all: the entry is absent, not merely marked.
    expect(instances('R5')).toBeUndefined();
  });

  it('takes its capability list from the registry rather than a local copy', () => {
    // Identity, not equality: a literal array would pass a deep comparison today and drift
    // tomorrow, which is exactly the failure this registry exists to prevent.
    for (const role of PLATFORM_ROLES) {
      for (const entry of flatNav(role)) {
        const route = CONSOLE_ROUTES.find((candidate) => hrefOf(candidate) === entry.href);
        expect(route?.capabilities, `${role} ${entry.href}`).toBe(entry.capabilities);
      }
    }
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
    // Guards ask `canMutate`; navigation asks it through `entryAccess` for `full` entries. If the
    // two disagree, an admin screen opens and immediately renders its own 403.
    const capability: Capability = 'settings.view';
    expect(canMutate('R2', capability)).toBe(true);
    expect(can('R2', capability)).toBe(true);
    expect(flatNav('R2').map((item) => item.href)).toContain('/admin/settings');
  });
});

/**
 * The landing decision walks a curated id order and must survive a registry that no longer matches
 * it: an id that was removed, and a route that is not a sidebar destination. Neither is reachable
 * through the shipped registry — every landing id exists and every one of them carries a `nav`
 * entry — so the registry is substituted here rather than the ordering being trusted.
 */
describe('landing route against a registry that no longer matches', () => {
  const registry = (routeById: (id: string) => unknown) => () => ({
    CONSOLE_ROUTES: [],
    GROUP_ORDER: [],
    admitsRoute: () => true,
    scopeLimitedRoute: () => false,
    hrefOf: (route: { path: string; index?: true }) =>
      route.index === true ? '/' : `/${route.path}`,
    routeById,
  });

  afterEach(() => {
    vi.doUnmock('../../src/routes');
    vi.resetModules();
  });

  it('skips a landing id the registry does not declare', async () => {
    vi.doMock(
      '../../src/routes',
      registry((id) =>
        id === 'instances'
          ? {
              id,
              path: 'instances',
              capabilities: [],
              admits: 'any',
              screen: {},
              nav: { group: 'Operations', label: 'Instances', icon: {} },
            }
          : undefined,
      ),
    );
    vi.resetModules();
    const { defaultRouteFor } = await import('../../src/navigation');

    // `overview` is gone, so the chain falls through to the next surface instead of guessing.
    expect(defaultRouteFor('R1')).toBe('/instances');
  });

  it('falls through a landing route that has no sidebar entry', async () => {
    vi.doMock(
      '../../src/routes',
      registry((id) =>
        id === 'overview'
          ? { id, path: '', index: true, capabilities: [], admits: 'any', screen: {} }
          : undefined,
      ),
    );
    vi.resetModules();
    const { defaultRouteFor } = await import('../../src/navigation');

    // A detail route is not a home surface: offering it would land the operator on a 404 shell.
    expect(defaultRouteFor('R1')).toBe('/forbidden');
  });
});
