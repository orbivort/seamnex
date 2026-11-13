/**
 * Route chunk prefetching.
 *
 * Without this, opening a screen is two serialised round trips: the chunk is fetched only after
 * the route renders its fallback, and the screen's data is fetched only after the chunk executes.
 * Warming the chunk on hover or focus collapses that to one, because the module is usually
 * resolved before the click lands.
 *
 * The loaders are duplicated from the route table on purpose: `import()` of the same specifier
 * resolves to the same chunk, so a preloader never adds weight, and a route without one simply
 * behaves as it did before.
 */
type Preloader = () => Promise<unknown>;

const PRELOADERS: Record<string, Preloader> = {
  '/': () => import('./features/overview/OverviewPage'),
  '/catalog': () => import('./features/catalog/CatalogPage'),
  '/instances': () => import('./features/instances/InstancesPage'),
  '/jobs': () => import('./features/jobs/JobsPage'),
  '/registry': () => import('./features/registry/RegistryPage'),
  '/capacity': () => import('./features/capacity/CapacityPage'),
  '/workflows': () => import('./features/workflows/WorkflowsPage'),
  '/governance/audit': () => import('./features/governance/AuditPage'),
  '/governance/licenses': () => import('./features/governance/LicensesPage'),
  '/governance/patches': () => import('./features/governance/PatchesPage'),
  '/governance/posture': () => import('./features/governance/PosturePage'),
  '/governance/recovery': () => import('./features/governance/RecoveryPage'),
  '/governance/privacy': () => import('./features/governance/PrivacyPage'),
  '/governance/break-glass': () => import('./features/governance/BreakGlassPage'),
  '/governance/access-requests': () => import('./features/governance/AccessRequestsPage'),
  '/governance/maintenance': () => import('./features/governance/MaintenancePage'),
  '/admin/users': () => import('./features/admin/UsersPage'),
  '/admin/groups': () => import('./features/admin/GroupsPage'),
  '/admin/identity-sync': () => import('./features/admin/IdentitySyncPage'),
  '/admin/settings': () => import('./features/admin/SettingsPage'),
};

const started = new Set<string>();

/**
 * Warms the chunk behind a route. Never awaited and never reported: a prefetch that fails is the
 * navigation's problem, not the operator's, and the retrying `lazyScreen` still runs.
 */
export function preloadRoute(href: string): void {
  const load = PRELOADERS[href];
  if (load === undefined || started.has(href)) return;
  started.add(href);
  void load().catch(() => {
    // Allow a later hover to try again after a transient failure.
    started.delete(href);
  });
}

/** The screens an operator opens first, warmed once the page is idle. */
const CRITICAL = ['/catalog', '/instances'] as const;

export function preloadCriticalRoutes(): void {
  const run = (): void => {
    for (const href of CRITICAL) preloadRoute(href);
  };
  const idle = (
    window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === 'function') idle(run, { timeout: 2_000 });
  else window.setTimeout(run, 1_000);
}
