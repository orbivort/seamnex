import { describe, expect, it } from 'vitest';
import { ROUTES, ROUTE_BY_PATH } from '../../src/routes';

/**
 * Route metadata is what the navigation and the traceability matrix read, so an entry without a
 * requirement or a purpose is not cosmetic: it is a screen nobody can audit.
 */
describe('route metadata', () => {
  it('records the requirement and design section behind every route', () => {
    expect(ROUTES.length).toBeGreaterThan(0);
    for (const route of ROUTES) {
      expect(route.path.startsWith('/'), route.path).toBe(true);
      expect(['portal', 'console'], route.path).toContain(route.app);
      expect(route.title.length, route.path).toBeGreaterThan(0);
      expect(route.purpose.length, route.path).toBeGreaterThan(0);
      expect(route.group.length, route.path).toBeGreaterThan(0);
      expect(route.requirements.length, route.path).toBeGreaterThan(0);
    }
  });

  it('indexes the console routes by path, and only those', () => {
    const consolePaths = ROUTES.filter((route) => route.app === 'console').map(
      (route) => route.path,
    );

    expect(Object.keys(ROUTE_BY_PATH).sort()).toEqual([...consolePaths].sort());
    // The portal's own routes are not part of the console navigation.
    expect(ROUTE_BY_PATH['/entitlements']).toBeUndefined();
    expect(ROUTE_BY_PATH['/catalog']?.title).toBe('Catalog');
  });
});
