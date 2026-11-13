import { Suspense, useState, type ReactNode } from 'react';
import { ApiProvider } from '@seamnex/api-client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router';
import { ErrorBoundary, Panel, SkeletonLines, TooltipProvider } from '@seamnex/ui';
import { SignInPage } from '@seamnex/shell';
import { can } from '@seamnex/domain';
import { SessionProvider, readSession, useSession } from './session';
import { SessionGate } from './session-gate';
import { lazyScreen } from './lazy';
import { PortalLayout } from './components/PortalLayout';

/**
 * Routes are split per screen. `lazyScreen` adds one retry to each import, and every route
 * renders inside `RouteBoundary`, so a render throw or a chunk that a newer deployment replaced
 * keeps the shell usable instead of blanking the page.
 */
const LauncherPage = lazyScreen(() => import('./features/launcher/LauncherPage'), 'LauncherPage');
const EntitlementsPage = lazyScreen(
  () => import('./features/entitlements/EntitlementsPage'),
  'EntitlementsPage',
);
const ProductPage = lazyScreen(() => import('./features/product/ProductPage'), 'ProductPage');
const GuestPage = lazyScreen(() => import('./features/guest/GuestPage'), 'GuestPage');
const ForbiddenPage = lazyScreen(() => import('./features/errors/ForbiddenPage'), 'ForbiddenPage');
const NotFoundPage = lazyScreen(() => import('./features/errors/NotFoundPage'), 'NotFoundPage');

function RouteFallback() {
  return (
    <Panel className="m-4">
      <div className="p-4" role="status" aria-busy="true" aria-label="Loading this screen">
        <SkeletonLines lines={5} />
      </div>
    </Panel>
  );
}

/** The boundary is keyed on the path, so a failed screen is cleared by navigating away. */
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

function PortalHome() {
  const { session } = useSession();
  // A guest holds no entitlement surface; everyone else sees the launcher.
  return can(session.role, 'portal.view_entitlements') ? <LauncherPage /> : <GuestPage />;
}

function Shell() {
  const { session } = useSession();
  return (
    /**
     * The router sits above the cache scope: a scope change replaces the query client, and
     * TanStack binds each observer to the client that existed when it mounted, so consumers must
     * remount — but the router must not. Latency is excluded from the scope because it only
     * re-points the transport (see `applySessionTransport`); including it discarded the whole
     * rendered tree whenever the demo control moved.
     */
    <ApiProvider resetKey={`${session.role}:${session.scenario}`}>
      <Routes>
        <Route element={<PortalLayout />}>
          <Route index element={screen(<PortalHome />)} />
          <Route path="entitlements" element={screen(<EntitlementsPage />)} />
          <Route path="product/:slug" element={screen(<ProductPage />)} />
          <Route path="forbidden" element={screen(<ForbiddenPage />)} />
          <Route path="not-found" element={screen(<NotFoundPage />)} />
          <Route path="*" element={screen(<NotFoundPage />)} />
        </Route>
        {/* Outside the layout: an unauthenticated visitor never sees product chrome (CL-01). */}
        <Route path="/sign-in" element={<SignInPage appName="Customer portal" />} />
      </Routes>
    </ApiProvider>
  );
}

export function App() {
  // Read once, before the gate: the role the URL (or the server, in live mode) asserts decides
  // what the session provider renders, and a re-read on every render would churn its identity.
  const [initialSession] = useState(readSession);
  return (
    <SessionGate initialSession={initialSession} appName="Customer portal">
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
