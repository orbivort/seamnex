import { Suspense, useState, type ReactNode } from 'react';
import { ApiProvider } from '@seamnex/api-client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import {
  Button,
  EmptyState,
  ErrorBoundary,
  Panel,
  SkeletonLines,
  TooltipProvider,
} from '@seamnex/ui';
import { SignInPage } from '@seamnex/shell';
import { can } from '@seamnex/domain';
import { SessionProvider, readSession, useSession } from './session';
import { SessionGate } from './session-gate';
import { lazyScreen } from './lazy';
import { ConsoleLayout } from './components/ConsoleLayout';
import {
  ForbiddenRoles,
  RequireAnyCapability,
  RequireCapability,
  RequireFullCapability,
} from './components/Guard';
import { defaultRouteFor } from './navigation';

/**
 * Routes are split per screen: the console does not ship every governance and admin screen in
 * the first chunk. `lazyScreen` adds one retry to each import, and every route renders inside
 * `RouteBoundary`, so a render throw or a chunk that a newer deployment replaced keeps the
 * navigation usable instead of blanking the shell.
 */
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

function RouteFallback() {
  return (
    <Panel className="m-4">
      <div className="p-4" role="status" aria-busy="true" aria-label="Loading this screen">
        <SkeletonLines lines={5} />
      </div>
    </Panel>
  );
}

/**
 * Every route renders inside a boundary and a suspense fallback.
 *
 * The boundary is keyed on the path: a screen that threw (a render bug, or a chunk a newer
 * deployment replaced) must not keep the boundary stuck once the operator navigates elsewhere.
 */
function RouteBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <ErrorBoundary resetKeys={[location.pathname]}>
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function screen(node: ReactNode) {
  return <RouteBoundary>{node}</RouteBoundary>;
}

function guard(
  capability: Parameters<typeof RequireCapability>[0]['capability'],
  children: ReactNode,
) {
  return <RequireCapability capability={capability}>{children}</RequireCapability>;
}

function ConsoleHome() {
  const { session } = useSession();
  if (!can(session.role, 'capacity.view') && !can(session.role, 'instance.view_logs')) {
    return <ForbiddenRoles />;
  }
  if (!can(session.role, 'capacity.view')) {
    return <Navigate to={defaultRouteFor(session.role)} replace />;
  }
  return <OverviewPage />;
}

function NotFound() {
  return (
    <Panel className="mx-auto mt-6 max-w-xl">
      <div className="p-6">
        <EmptyState
          title="Console page not found"
          description="The address does not match a console section. Use the sidebar or the command palette to continue."
          action={
            <Button variant="secondary" onClick={() => window.history.back()}>
              Go back
            </Button>
          }
        />
      </div>
    </Panel>
  );
}

function Shell() {
  const { session } = useSession();
  return (
    /**
     * The router sits *above* the cache scope on purpose. A scope change replaces the client, and
     * TanStack binds each observer to the client that existed when it mounted, so the consumers
     * must remount — but that remount must not take the router with it. The scope is role and
     * scenario only: simulated latency re-points the transport and has no bearing on what a role
     * may read, so it must not discard the screen the operator is working on.
     */
    <ApiProvider resetKey={`${session.role}:${session.scenario}`}>
      <Routes>
        <Route element={<ConsoleLayout />}>
          <Route index element={screen(<ConsoleHome />)} />
          <Route path="catalog" element={screen(guard('catalog.browse', <CatalogPage />))} />
          <Route
            path="catalog/:key"
            element={screen(guard('catalog.read_metadata', <EntryDetailPage />))}
          />
          <Route
            path="deploy/:entryKey"
            element={screen(guard('instance.deploy', <DeployWizardPage />))}
          />
          <Route
            path="instances"
            element={screen(guard('instance.view_logs', <InstancesPage />))}
          />
          <Route
            path="instances/:id"
            element={screen(guard('instance.view_logs', <InstanceDetailPage />))}
          />
          <Route path="jobs" element={screen(guard('instance.view_logs', <JobsPage />))} />
          <Route path="jobs/:id" element={screen(guard('instance.view_logs', <JobDetailPage />))} />
          <Route path="registry" element={screen(guard('registry.view', <RegistryPage />))} />
          <Route path="capacity" element={screen(guard('capacity.view', <CapacityPage />))} />
          <Route
            path="workflows"
            element={screen(guard('workflow.view_runs', <WorkflowsPage />))}
          />
          <Route
            path="workflows/:id"
            element={screen(guard('workflow.view_runs', <WorkflowWorkspacePage />))}
          />
          <Route path="governance/audit" element={screen(guard('audit.view', <AuditPage />))} />
          <Route
            path="governance/licenses"
            element={screen(guard('license.view', <LicensesPage />))}
          />
          <Route path="governance/patches" element={screen(guard('patch.view', <PatchesPage />))} />
          <Route
            path="governance/posture"
            element={screen(guard('posture.view', <PosturePage />))}
          />
          <Route
            path="governance/recovery"
            element={screen(guard('recovery.view', <RecoveryPage />))}
          />
          <Route
            path="governance/privacy"
            element={screen(guard('privacy.view', <PrivacyPage />))}
          />
          <Route
            path="governance/break-glass"
            element={screen(
              <RequireAnyCapability capabilities={['breakglass.request', 'breakglass.approve']}>
                <BreakGlassPage />
              </RequireAnyCapability>,
            )}
          />
          <Route
            path="governance/access-requests"
            element={screen(guard('entitlement.grant', <AccessRequestsPage />))}
          />
          <Route
            path="governance/maintenance"
            element={screen(
              // Same set as the navigation entry: the guard can never admit a role the sidebar
              // hides, and the page states the rule for each panel it cannot read.
              <RequireAnyCapability
                capabilities={['maintenance.configure', 'settings.view', 'exception.decide']}
              >
                <MaintenancePage />
              </RequireAnyCapability>,
            )}
          />
          <Route path="admin/users" element={screen(guard('identity.view_users', <UsersPage />))} />
          <Route
            path="admin/users/:id"
            element={screen(guard('identity.view_users', <UserDetailPage />))}
          />
          <Route
            path="admin/groups"
            element={screen(
              <RequireFullCapability capability="identity.manage_groups">
                <GroupsPage />
              </RequireFullCapability>,
            )}
          />
          <Route
            path="admin/identity-sync"
            element={screen(
              <RequireFullCapability capability="identity.manage_users">
                <IdentitySyncPage />
              </RequireFullCapability>,
            )}
          />
          <Route
            path="admin/settings"
            element={screen(
              <RequireFullCapability capability="settings.view">
                <SettingsPage />
              </RequireFullCapability>,
            )}
          />
          <Route path="forbidden" element={<ForbiddenRoles />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        {/* Outside the layout: an unauthenticated visitor never sees console chrome (CL-01). */}
        <Route path="/sign-in" element={<SignInPage appName="Operations console" />} />
      </Routes>
    </ApiProvider>
  );
}

export function App() {
  // Read once, before the gate: the role the URL (or the server, in live mode) asserts decides
  // what the session provider renders, and a re-read on every render would churn its identity.
  const [initialSession] = useState(readSession);
  return (
    <SessionGate initialSession={initialSession} appName="Operator console">
      {/* One tooltip provider for the whole app; the primitive no longer creates one per tooltip. */}
      <TooltipProvider>
        {/*
          The router now sits above the session provider, so the provider reads `?role`/`?scenario`
          through `useSearchParams` instead of subscribing to the platform location. The cache
          scope stays inside the provider, because it depends on the resolved role.
        */}
        <BrowserRouter>
          <SessionProvider>
            <Shell />
          </SessionProvider>
        </BrowserRouter>
      </TooltipProvider>
    </SessionGate>
  );
}
