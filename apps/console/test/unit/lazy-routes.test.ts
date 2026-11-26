import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Route chunk prefetching. A prefetch is never awaited and never reported: it exists so the click
 * lands on an already-resolved module, and a failed prefetch must leave the retrying `lazyScreen`
 * to do the real work.
 */
afterEach(() => {
  vi.doUnmock('../../src/routes');
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

/** The registry's own answer for a path, so a renamed route fails here rather than silently. */
async function routeForHref(href: string) {
  const { CONSOLE_ROUTES, hrefOf } = await import('../../src/routes');
  const route = CONSOLE_ROUTES.find((candidate) => hrefOf(candidate) === href);
  if (route === undefined) throw new Error(`the registry no longer declares ${href}`);
  return route;
}

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

  it('warms a route once, however often the sidebar is hovered', async () => {
    const { preloadRoute } = await import('../../src/lazy-routes');
    const route = await routeForHref('/catalog');
    const preload = vi.spyOn(route.screen, 'preload').mockResolvedValue(undefined);

    preloadRoute('/catalog');
    preloadRoute('/catalog');
    preloadRoute('/catalog');

    // The chunk is expensive and the hover events arrive in bursts: one warm per href per session.
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('releases a route whose prefetch failed so the next hover retries', async () => {
    const { preloadRoute } = await import('../../src/lazy-routes');
    const route = await routeForHref('/catalog');
    let fail!: (error: Error) => void;
    const failing = new Promise<unknown>((_resolve, reject) => {
      fail = reject;
    });
    // Only the first attempt fails; the retry after the release must reach the real loader.
    const preload = vi.spyOn(route.screen, 'preload').mockReturnValueOnce(failing);

    preloadRoute('/catalog');
    expect(preload).toHaveBeenCalledTimes(1);

    fail(new Error('the chunk was replaced by a newer deployment'));
    await failing.catch(() => undefined);

    // Otherwise one transient failure would leave that section cold for the rest of the session.
    preloadRoute('/catalog');
    expect(preload).toHaveBeenCalledTimes(2);
  });

  it('skips a critical id the registry no longer declares', async () => {
    const preload = vi.fn(() => Promise.resolve());
    vi.doMock('../../src/routes', () => ({
      CONSOLE_ROUTES: [],
      hrefOf: () => '/instances',
      routeById: (id: string) =>
        id === 'instances'
          ? { id, path: 'instances', capabilities: [], admits: 'any', screen: { preload } }
          : undefined,
    }));
    vi.resetModules();
    const idle = vi.fn((callback: () => void) => {
      callback();
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', idle);
    const { preloadCriticalRoutes } = await import('../../src/lazy-routes');

    preloadCriticalRoutes();

    // `catalog` is gone from the registry: warming the surviving critical screen must not throw.
    expect(preload).toHaveBeenCalledTimes(1);
  });
});
