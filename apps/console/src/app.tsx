import { Suspense, createElement, useState, type ReactNode } from 'react';
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
import { ConsoleLayout } from './components/ConsoleLayout';
import {
  Forbidden,
  ForbiddenRoles,
  RequireAnyCapability,
  RequireAnyFullCapability,
  RequireCapability,
  RequireFullCapability,
} from './components/Guard';
import { defaultRouteFor } from './navigation';
import { CONSOLE_ROUTES, type ConsoleRoute } from './routes';

/**
 * The router mounts under the deployment base, not the origin root — see the same constant in the
 * portal, which shares this rule. The trailing slash is dropped because the router adds its own.
 */
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '');

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

/**
 * The gate a registry entry asks for, chosen from its declaration alone.
 *
 * `admits`, `scopedRead` and the number of capabilities are the whole decision: one capability is
 * the single-key gate, several are the any-of gate, and a surface that needs an outright grant —
 * `full`, or `any` where the platform cannot serve a narrowed read — swaps `held` for `mutable`.
 * An entry that declares no capability is admitted for nobody: a declaration error hides rather
 * than opens.
 */
function Admitted({ route, children }: { route: ConsoleRoute; children: ReactNode }) {
  const [first, ...rest] = route.capabilities;
  if (first === undefined) return <Forbidden />;
  if (route.admits === 'full' || route.scopedRead !== true) {
    return rest.length === 0 ? (
      <RequireFullCapability capability={first}>{children}</RequireFullCapability>
    ) : (
      <RequireAnyFullCapability capabilities={[...route.capabilities]}>
        {children}
      </RequireAnyFullCapability>
    );
  }
  return rest.length === 0 ? (
    <RequireCapability capability={first}>{children}</RequireCapability>
  ) : (
    <RequireAnyCapability capabilities={[...route.capabilities]}>{children}</RequireAnyCapability>
  );
}

/**
 * The index route: overview for a role that may read capacity, otherwise the first surface it may
 * read, otherwise the "not an operator surface" panel.
 *
 * The page still comes from the registry — the sidebar entry and the page it opens are one
 * declaration — but the landing decision stays here because it is about this route, not about
 * anything the sidebar renders.
 */
function IndexRoute({ route }: { route: ConsoleRoute }) {
  const { session } = useSession();
  if (!can(session.role, 'capacity.view') && !can(session.role, 'instance.view_logs')) {
    return <ForbiddenRoles />;
  }
  if (!can(session.role, 'capacity.view')) {
    return <Navigate to={defaultRouteFor(session.role)} replace />;
  }
  return <Admitted route={route}>{createElement(route.screen)}</Admitted>;
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
          {/*
            One route per registry entry (ADR-FE-01). The capability a route checks and the
            capability the sidebar advertises are now the same field, so the "same set as the
            navigation entry" comment this block used to need has nothing left to describe.
          */}
          {CONSOLE_ROUTES.map((route) =>
            route.index === true ? (
              <Route key={route.id} index element={screen(<IndexRoute route={route} />)} />
            ) : (
              <Route
                key={route.id}
                path={route.path}
                element={screen(<Admitted route={route}>{createElement(route.screen)}</Admitted>)}
              />
            ),
          )}
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
        <BrowserRouter basename={ROUTER_BASENAME}>
          <SessionProvider>
            <Shell />
          </SessionProvider>
        </BrowserRouter>
      </TooltipProvider>
    </SessionGate>
  );
}
