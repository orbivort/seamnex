import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ArchiveRestore,
  BadgeCheck,
  BookLock,
  Boxes,
  FileClock,
  FileLock2,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  PackageCheck,
  ScrollText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  UsersRound,
  Workflow,
  Wrench,
} from 'lucide-react';
import { entryAccess, type Capability, type PlatformRole } from '@seamnex/domain';
import { lazyScreen, type LazyScreen } from './lazy';

/**
 * ADR-FE-01 — one declaration per console surface.
 *
 * Before this, a screen's capability was written twice: once in `navigation.ts` (what the sidebar
 * offers) and once in `app.tsx` (what the router admits). The two lists were kept in step by hand,
 * and a comment in the router said so. Nothing detected the day they diverged — the sidebar would
 * offer an entry whose route refused it, or hide one the router would have opened.
 *
 * This module is the single declaration; `navigationFor` derives the sidebar from it and `app.tsx`
 * derives the route tree from it, so the only way they can disagree is if this file is wrong. The
 * screen is held as the `lazyScreen` component (not a loader) so code-splitting survives: importing
 * the registry costs the icon set and the lazy wrappers, never a page chunk.
 */

export type ConsoleGroup = 'Operations' | 'Automation' | 'Governance' | 'Administration';

/**
 * `any` admits a capability at any level — a `scoped` grant opens the screen, which then states the
 * narrower scope. `full` requires an outright grant: an administration surface is not enterable on
 * a request/approval scope.
 */
export type Admission = 'any' | 'full';

export type ConsoleScreen = LazyScreen;

export type ConsoleRoute = {
  /** Stable identifier, used by the tests and as the React key. */
  readonly id: string;
  /** The path as React Router declares it, without the leading slash. Empty on the index route. */
  readonly path: string;
  readonly index?: true;
  readonly screen: ConsoleScreen;
  readonly capabilities: readonly Capability[];
  readonly admits: Admission;
  /**
   * `true` only when the platform can answer this surface's reads for a `scoped` grant — the list
   * query carries a domain or instance predicate (ADR-BE-44).
   *
   * Absent means the opposite, and the default is absent on purpose: a scoped grant still opens
   * the route (the capability is genuinely held), the screen's first request answers `403`, and the
   * sidebar has already promised a scope the platform cannot honour. That is the exact confusion
   * ADR-FE-01 exists to remove, so an entry must opt in, and `routes.test.ts` walks every claim.
   */
  readonly scopedRead?: true;
  /** Present when the surface has a sidebar entry; absent for detail routes. */
  readonly nav?: {
    readonly group: ConsoleGroup;
    readonly label: string;
    readonly icon: LucideIcon;
  };
};

const OverviewPage = lazyScreen(() => import('./features/overview/OverviewPage'), 'OverviewPage');
const CatalogPage = lazyScreen(() => import('./features/catalog/CatalogPage'), 'CatalogPage');
const EntryDetailPage = lazyScreen(
  () => import('./features/catalog/EntryDetailPage'),
  'EntryDetailPage',
);
const DeployWizardPage = lazyScreen(
  () => import('./features/deploy/DeployWizardPage'),
  'DeployWizardPage',
);
const InstancesPage = lazyScreen(
  () => import('./features/instances/InstancesPage'),
  'InstancesPage',
);
const InstanceDetailPage = lazyScreen(
  () => import('./features/instances/InstanceDetailPage'),
  'InstanceDetailPage',
);
const JobsPage = lazyScreen(() => import('./features/jobs/JobsPage'), 'JobsPage');
const JobDetailPage = lazyScreen(() => import('./features/jobs/JobDetailPage'), 'JobDetailPage');
const WorkflowsPage = lazyScreen(
  () => import('./features/workflows/WorkflowsPage'),
  'WorkflowsPage',
);
const WorkflowWorkspacePage = lazyScreen(
  () => import('./features/workflows/WorkflowWorkspacePage'),
  'WorkflowWorkspacePage',
);
const AuditPage = lazyScreen(() => import('./features/governance/AuditPage'), 'AuditPage');
const LicensesPage = lazyScreen(() => import('./features/governance/LicensesPage'), 'LicensesPage');
const PatchesPage = lazyScreen(() => import('./features/governance/PatchesPage'), 'PatchesPage');
const PosturePage = lazyScreen(() => import('./features/governance/PosturePage'), 'PosturePage');
const AccessRequestsPage = lazyScreen(
  () => import('./features/governance/AccessRequestsPage'),
  'AccessRequestsPage',
);
const BreakGlassPage = lazyScreen(
  () => import('./features/governance/BreakGlassPage'),
  'BreakGlassPage',
);
const MaintenancePage = lazyScreen(
  () => import('./features/governance/MaintenancePage'),
  'MaintenancePage',
);
const PrivacyPage = lazyScreen(() => import('./features/governance/PrivacyPage'), 'PrivacyPage');
const RecoveryPage = lazyScreen(() => import('./features/governance/RecoveryPage'), 'RecoveryPage');
const GroupsPage = lazyScreen(() => import('./features/admin/GroupsPage'), 'GroupsPage');
const EnvironmentProfilesPage = lazyScreen(
  () => import('./features/admin/EnvironmentProfilesPage'),
  'EnvironmentProfilesPage',
);
const IdentitySyncPage = lazyScreen(
  () => import('./features/admin/IdentitySyncPage'),
  'IdentitySyncPage',
);
const SettingsPage = lazyScreen(() => import('./features/admin/SettingsPage'), 'SettingsPage');
const UserDetailPage = lazyScreen(
  () => import('./features/admin/UserDetailPage'),
  'UserDetailPage',
);
const UsersPage = lazyScreen(() => import('./features/admin/UsersPage'), 'UsersPage');
const CapacityPage = lazyScreen(() => import('./features/capacity/CapacityPage'), 'CapacityPage');
const RegistryPage = lazyScreen(() => import('./features/registry/RegistryPage'), 'RegistryPage');

/** The order the sidebar renders its groups in; a group with no admitted entry is dropped. */
export const GROUP_ORDER: readonly ConsoleGroup[] = [
  'Operations',
  'Automation',
  'Governance',
  'Administration',
];

export const CONSOLE_ROUTES: readonly ConsoleRoute[] = [
  {
    /*
     * The index route. `app.tsx` still owns the landing decision (overview, or the first surface the
     * role may read); the screen it lands on is the one declared here.
     */
    id: 'overview',
    path: '',
    index: true,
    screen: OverviewPage,
    capabilities: ['capacity.view'],
    admits: 'any',
    scopedRead: true,
    nav: { group: 'Operations', label: 'Overview', icon: LayoutDashboard },
  },
  {
    id: 'catalog',
    path: 'catalog',
    screen: CatalogPage,
    capabilities: ['catalog.browse'],
    admits: 'any',
    // The catalogue read resolves a `scoped` grant against `self` (SCOPE_RULES), so a narrowed
    // grant is served rather than refused.
    scopedRead: true,
    nav: { group: 'Operations', label: 'Catalog', icon: Boxes },
  },
  {
    id: 'catalog-entry',
    path: 'catalog/:key',
    screen: EntryDetailPage,
    capabilities: ['catalog.read_metadata'],
    admits: 'any',
    scopedRead: true,
  },
  {
    id: 'deploy',
    path: 'deploy/:entryKey',
    screen: DeployWizardPage,
    capabilities: ['instance.deploy'],
    admits: 'any',
  },
  {
    id: 'instances',
    path: 'instances',
    screen: InstancesPage,
    capabilities: ['instance.view_logs'],
    admits: 'any',
    // ADR-BE-44: `GET /instances` decides from the grant and filters the list by domain.
    scopedRead: true,
    nav: { group: 'Operations', label: 'Instances', icon: PackageCheck },
  },
  {
    id: 'instance',
    path: 'instances/:id',
    screen: InstanceDetailPage,
    capabilities: ['instance.view_logs'],
    admits: 'any',
    // An addressed read: `domainOf` joins the instance to its catalogue entry's domain.
    scopedRead: true,
  },
  {
    id: 'jobs',
    path: 'jobs',
    screen: JobsPage,
    capabilities: ['instance.view_logs'],
    admits: 'any',
    // ADR-BE-44: the job list is confined to the caller's instance ids.
    scopedRead: true,
    nav: { group: 'Operations', label: 'Jobs', icon: ListChecks },
  },
  {
    id: 'job',
    path: 'jobs/:id',
    screen: JobDetailPage,
    capabilities: ['instance.view_logs'],
    admits: 'any',
    scopedRead: true,
  },
  {
    id: 'registry',
    path: 'registry',
    screen: RegistryPage,
    capabilities: ['registry.view'],
    admits: 'any',
    nav: { group: 'Operations', label: 'Integration registry', icon: BadgeCheck },
  },
  {
    id: 'capacity',
    path: 'capacity',
    screen: CapacityPage,
    capabilities: ['capacity.view'],
    admits: 'any',
    // ADR-BE-44: the per-instance table is filtered; host totals stay platform-wide.
    scopedRead: true,
    nav: { group: 'Operations', label: 'Capacity', icon: Gauge },
  },
  {
    id: 'workflows',
    path: 'workflows',
    screen: WorkflowsPage,
    capabilities: ['workflow.view_runs'],
    admits: 'any',
    // A workflow resolves the instances it writes to, so a domain grant reaches its definitions.
    scopedRead: true,
    nav: { group: 'Automation', label: 'Workflows', icon: Workflow },
  },
  {
    id: 'workflow',
    path: 'workflows/:id',
    screen: WorkflowWorkspacePage,
    capabilities: ['workflow.view_runs'],
    admits: 'any',
    scopedRead: true,
  },
  {
    id: 'audit',
    path: 'governance/audit',
    screen: AuditPage,
    capabilities: ['audit.view'],
    admits: 'any',
    nav: { group: 'Governance', label: 'Audit trail', icon: ScrollText },
  },
  {
    id: 'licenses',
    path: 'governance/licenses',
    screen: LicensesPage,
    capabilities: ['license.view'],
    admits: 'any',
    nav: { group: 'Governance', label: 'License register', icon: BookLock },
  },
  {
    id: 'patches',
    path: 'governance/patches',
    screen: PatchesPage,
    capabilities: ['patch.view'],
    admits: 'any',
    nav: { group: 'Governance', label: 'Patch register', icon: Wrench },
  },
  {
    id: 'posture',
    path: 'governance/posture',
    screen: PosturePage,
    capabilities: ['posture.view'],
    admits: 'any',
    nav: { group: 'Governance', label: 'Security posture', icon: ShieldCheck },
  },
  {
    id: 'recovery',
    path: 'governance/recovery',
    screen: RecoveryPage,
    capabilities: ['recovery.view'],
    admits: 'any',
    nav: { group: 'Governance', label: 'Recovery', icon: ArchiveRestore },
  },
  {
    id: 'privacy',
    path: 'governance/privacy',
    screen: PrivacyPage,
    capabilities: ['privacy.view'],
    admits: 'any',
    nav: { group: 'Governance', label: 'Privacy requests', icon: FileLock2 },
  },
  {
    id: 'break-glass',
    path: 'governance/break-glass',
    screen: BreakGlassPage,
    capabilities: ['breakglass.request', 'breakglass.approve'],
    admits: 'any',
    /*
     * Both capabilities resolve through the `request` scope rule, which answers "covered" without a
     * resource lookup — the requester reads the register and the approver decides from it.
     */
    scopedRead: true,
    nav: { group: 'Governance', label: 'Break-glass', icon: KeyRound },
  },
  {
    id: 'access-requests',
    path: 'governance/access-requests',
    screen: AccessRequestsPage,
    capabilities: ['entitlement.grant'],
    admits: 'any',
    nav: { group: 'Governance', label: 'Access requests', icon: LifeBuoy },
  },
  {
    /*
     * One entry, two panels, and the two do not share an authority: windows are read with
     * `settings.view` and written with `maintenance.configure`, exceptions with `exception.decide`.
     * Listing `metadata.manage` admitted a role that can do neither and then asked for a list it
     * was refused; each panel now checks its own capability.
     */
    id: 'maintenance',
    path: 'governance/maintenance',
    screen: MaintenancePage,
    capabilities: ['maintenance.configure', 'settings.view', 'exception.decide'],
    admits: 'any',
    nav: { group: 'Governance', label: 'Maintenance & exceptions', icon: FileClock },
  },
  {
    // Read-only directory evidence: R1 and R2 may open it, only R1 may disable a user.
    id: 'users',
    path: 'admin/users',
    screen: UsersPage,
    capabilities: ['identity.view_users'],
    admits: 'any',
    nav: { group: 'Administration', label: 'Users', icon: Users },
  },
  {
    id: 'user',
    path: 'admin/users/:id',
    screen: UserDetailPage,
    capabilities: ['identity.view_users'],
    admits: 'any',
  },
  {
    id: 'groups',
    path: 'admin/groups',
    screen: GroupsPage,
    capabilities: ['identity.manage_groups'],
    admits: 'full',
    nav: { group: 'Administration', label: 'Groups & mappings', icon: UsersRound },
  },
  {
    id: 'identity-sync',
    path: 'admin/identity-sync',
    screen: IdentitySyncPage,
    capabilities: ['identity.manage_users'],
    admits: 'full',
    nav: { group: 'Administration', label: 'Identity sync', icon: Activity },
  },
  {
    // FR-1.26 / AC-51: R1 manages the profiles; R3 reads them and files a change request. Either
    // grant is `full` on its own capability, so an outright grant on one of them admits the screen.
    id: 'environment-profiles',
    path: 'admin/environment-profiles',
    screen: EnvironmentProfilesPage,
    capabilities: ['profile.manage', 'profile.request'],
    admits: 'full',
    nav: { group: 'Administration', label: 'Environment profiles', icon: SlidersHorizontal },
  },
  {
    id: 'settings',
    path: 'admin/settings',
    screen: SettingsPage,
    capabilities: ['settings.view'],
    admits: 'full',
    nav: { group: 'Administration', label: 'Platform settings', icon: Settings },
  },
];

/**
 * Whether a role may open this surface.
 *
 * One function, because the router and the sidebar ask the same question and the answer used to be
 * written twice (ADR-FE-01). `admits: 'full'` is the administration rule; `admits: 'any'` admits a
 * narrowed grant only where `scopedRead` says the platform can serve it — otherwise a `scoped` role
 * is treated exactly like one that does not hold the capability, instead of being shown an entry
 * whose first request answers `403`.
 */
export function admitsRoute(role: PlatformRole, route: ConsoleRoute): boolean {
  const access = entryAccess(role, route.capabilities);
  if (access === 'none') return false;
  if (access === 'full') return true;
  return route.admits === 'any' && route.scopedRead === true;
}

/**
 * The marker's condition: the entry is open, and the grant behind it is the narrower one. Never
 * true for an entry that cannot serve a narrowed grant — the sidebar must not promise a scope the
 * screen would refuse.
 */
export function scopeLimitedRoute(role: PlatformRole, route: ConsoleRoute): boolean {
  return (
    route.admits === 'any' &&
    route.scopedRead === true &&
    entryAccess(role, route.capabilities) === 'scoped'
  );
}

/** The sidebar destination of a route; the index route is `/`. */
export function hrefOf(route: ConsoleRoute): string {
  return route.index === true ? '/' : `/${route.path}`;
}

/** Lookup by the registry key; the ids are what the landing order and the prefetcher name. */
export function routeById(id: string): ConsoleRoute | undefined {
  return CONSOLE_ROUTES.find((route) => route.id === id);
}
