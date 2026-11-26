import { CONSOLE_ROUTES, hrefOf, routeById } from './routes';

/**
 * Route chunk prefetching, derived from the route registry (ADR-FE-01).
 *
 * Without this, opening a screen is two serialised round trips: the chunk is fetched only after
 * the route renders its fallback, and the screen's data is fetched only after the chunk executes.
 * Warming the chunk on hover or focus collapses that to one, because the module is usually
 * resolved before the click lands.
 *
 * This used to be a hand-kept path → `import()` table, a third declaration of the same route set
 * beside the sidebar and the router. It now reads the registry, so a new screen is prefetched by
 * existing, and detail routes are warmed as well.
 */
const started = new Set<string>();

function preloadHref(href: string, screen: { preload: () => Promise<unknown> }): void {
  if (started.has(href)) return;
  started.add(href);
  void screen.preload().catch(() => {
    // Allow a later hover to try again after a transient failure.
    started.delete(href);
  });
}

/**
 * Warms the chunk behind a route. Never awaited and never reported: a prefetch that fails is the
 * navigation's problem, not the operator's, and the retrying `lazyScreen` still runs.
 */
export function preloadRoute(href: string): void {
  const route = CONSOLE_ROUTES.find((candidate) => hrefOf(candidate) === href);
  if (route === undefined) return;
  preloadHref(href, route.screen);
}

/** The screens an operator opens first, warmed once the page is idle. */
const CRITICAL = ['catalog', 'instances'] as const;

export function preloadCriticalRoutes(): void {
  const run = (): void => {
    for (const id of CRITICAL) {
      const route = routeById(id);
      if (route !== undefined) preloadHref(hrefOf(route), route.screen);
    }
  };
  const idle = (
    window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === 'function') idle(run, { timeout: 2_000 });
  else window.setTimeout(run, 1_000);
}
