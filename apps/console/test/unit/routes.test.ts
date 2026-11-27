import { describe, expect, it } from 'vitest';
import { PLATFORM_ROLES, entryAccess } from '@seamnex/domain';
import type { PlatformRole } from '@seamnex/domain';
import { CONSOLE_ROUTES, GROUP_ORDER, hrefOf, routeById } from '../../src/routes';
import type { ConsoleRoute } from '../../src/routes';
import { flatNav, navigationFor } from '../../src/navigation';

/**
 * The admission rule, written out independently of the implementation so this file specifies it
 * rather than agreeing with it: a `full` grant opens any surface, a `scoped` grant opens one only
 * when the registry says the platform can serve its reads narrowed (ADR-FE-01, ADR-BE-44).
 */
function admits(role: PlatformRole, route: ConsoleRoute): boolean {
  const access = entryAccess(role, route.capabilities);
  if (access === 'none') return false;
  if (access === 'full') return true;
  return route.admits === 'any' && route.scopedRead === true;
}

/**
 * ADR-FE-01 — the registry is the only declaration of a console surface, and these are the
 * properties that make that true. Before the registry, a screen's capability was written in the
 * sidebar and again in the router, and nothing failed the day they diverged: the sidebar offered an
 * entry whose route refused it, or hid one the router would have opened.
 */
describe('console route registry', () => {
  it('declares each id, path and href exactly once', () => {
    const ids = CONSOLE_ROUTES.map((route) => route.id);
    const paths = CONSOLE_ROUTES.map((route) => route.path);
    const hrefs = CONSOLE_ROUTES.map(hrefOf);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('has one index route, declared first, with a sidebar entry', () => {
    const indexRoutes = CONSOLE_ROUTES.filter((route) => route.index === true);
    expect(indexRoutes).toHaveLength(1);
    const [indexRoute] = indexRoutes;
    expect(CONSOLE_ROUTES[0]?.index).toBe(true);
    expect(indexRoute?.path).toBe('');
    expect(indexRoute === undefined ? '' : hrefOf(indexRoute)).toBe('/');
    expect(indexRoute?.nav).toBeDefined();
  });

  it('gives every surface a capability and a lazy screen that can be prefetched', () => {
    for (const route of CONSOLE_ROUTES) {
      expect(route.capabilities.length, route.id).toBeGreaterThan(0);
      expect(route.screen, route.id).toBeTypeOf('object');
      expect(route.screen.preload, route.id).toBeTypeOf('function');
    }
  });

  it('admits every route for at least one role', () => {
    // A route no role can open is dead weight in the bundle and a lie in the sidebar.
    for (const route of CONSOLE_ROUTES) {
      expect(
        PLATFORM_ROLES.some((role) => admits(role, route)),
        route.id,
      ).toBe(true);
    }
  });

  /**
   * The claim behind the sidebar's SCOPED marker: the platform answers this surface's reads for a
   * narrowed grant. Four of these are the collection reads ADR-BE-44 made scope-bearing; the rest
   * resolve a domain or the caller from an addressed path. A screen that only *opens* is not
   * enough — its first request answered `403` before this field existed.
   *
   * Adding an id here is adding a claim about the API, so it is written down where a reviewer sees
   * it changing rather than inferred from an `admits` literal.
   */
  it('declares a narrowed read only for the surfaces the platform can serve', () => {
    const scopedReadable = CONSOLE_ROUTES.filter((route) => route.scopedRead === true).map(
      (route) => route.id,
    );
    expect(scopedReadable).toEqual([
      'overview',
      'catalog',
      'catalog-entry',
      'instances',
      'instance',
      'jobs',
      'job',
      'capacity',
      'workflows',
      'workflow',
      'break-glass',
    ]);
  });

  it('keeps a surface whose read cannot be narrowed shut to a scoped-only role', () => {
    for (const route of CONSOLE_ROUTES) {
      if (route.scopedRead === true) continue;
      for (const role of PLATFORM_ROLES) {
        if (entryAccess(role, route.capabilities) !== 'scoped') continue;
        expect(admits(role, route), `${role} ${route.id}`).toBe(false);
      }
    }
  });

  it('uses only groups the sidebar knows how to order', () => {
    for (const route of CONSOLE_ROUTES) {
      if (route.nav === undefined) continue;
      expect(GROUP_ORDER, route.id).toContain(route.nav.group);
    }
  });

  it('resolves every id through the exported lookup, and nothing else', () => {
    for (const route of CONSOLE_ROUTES) {
      expect(routeById(route.id)).toBe(route);
    }
    expect(routeById('no-such-route')).toBeUndefined();
  });

  /**
   * The drift check. Every sidebar entry must be exactly the route's declaration — same capability
   * list (by identity, so a copied literal fails) and same admission — and every href the sidebar
   * offers must be a path the router renders.
   */
  it('offers nothing the router does not declare, and nothing it would refuse', () => {
    for (const role of PLATFORM_ROLES) {
      const entries = flatNav(role);
      const hrefs = new Set(CONSOLE_ROUTES.map(hrefOf));
      for (const entry of entries) {
        expect(hrefs, `${role} ${entry.href}`).toContain(entry.href);
        const route = CONSOLE_ROUTES.find((candidate) => hrefOf(candidate) === entry.href);
        expect(route, entry.href).toBeDefined();
        expect(entry.admits, entry.href).toBe(route?.admits);
        expect(entry.capabilities, entry.href).toBe(route?.capabilities);
      }
    }
  });

  it('renders every nav group in the declared order', () => {
    const labels = navigationFor('R1').map((group) => group.label);
    expect(labels).toEqual(['Operations', 'Automation', 'Governance', 'Administration']);
    const ordered = labels.map((label) => GROUP_ORDER.indexOf(label));
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
  });
});
