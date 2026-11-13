import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Route chunk prefetching. A prefetch is never awaited and never reported: it exists so the click
 * lands on an already-resolved module, and a failed prefetch must leave the retrying `lazyScreen`
 * to do the real work.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('route preloading', () => {
  it('warms a known route without awaiting it', async () => {
    const { preloadRoute } = await import('../../src/lazy-routes');

    expect(() => preloadRoute('/catalog')).not.toThrow();
    await Promise.resolve();
  });

  it('ignores a route it has no preloader for', async () => {
    const { preloadRoute } = await import('../../src/lazy-routes');

    expect(() => preloadRoute('/not-a-route')).not.toThrow();
    expect(() => preloadRoute('')).not.toThrow();
  });

  it('warms the critical screens through requestIdleCallback when the browser has it', async () => {
    const idle = vi.fn((callback: () => void, _options?: { timeout?: number }) => {
      callback();
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', idle);
    const { preloadCriticalRoutes } = await import('../../src/lazy-routes');

    preloadCriticalRoutes();

    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle.mock.calls[0]?.[1]).toEqual({ timeout: 2_000 });
  });

  it('falls back to a timer when requestIdleCallback is missing', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
    const timeout = vi.spyOn(window, 'setTimeout');
    const { preloadCriticalRoutes } = await import('../../src/lazy-routes');

    preloadCriticalRoutes();

    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
    vi.runOnlyPendingTimers();
  });

  it('warms every route the console exposes', async () => {
    const { preloadRoute } = await import('../../src/lazy-routes');

    const routes = [
      '/',
      '/catalog',
      '/instances',
      '/jobs',
      '/registry',
      '/capacity',
      '/workflows',
      '/governance/audit',
      '/governance/licenses',
      '/governance/patches',
      '/governance/posture',
      '/governance/recovery',
      '/governance/privacy',
      '/governance/break-glass',
      '/governance/access-requests',
      '/governance/maintenance',
      '/admin/users',
      '/admin/groups',
      '/admin/identity-sync',
      '/admin/settings',
    ];

    for (const href of routes) {
      expect(() => preloadRoute(href)).not.toThrow();
    }
    await Promise.resolve();
  });
});
