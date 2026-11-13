import {
  configureTransport,
  createFetchTransport,
  createPrototypeTransport,
  readAssertedRole,
  readServerSession,
  rememberAssertedRole,
  rememberAuthProvider,
  sessionRouting,
} from '@seamnex/api-client';
import type { SessionState } from '@seamnex/shell';

/**
 * Mocks are on in development, in tests and in the demo build (`--mode demo`), and off in a
 * production build or when `VITE_API_MODE=live` is set. `__SEAMNEX_MOCKS__` is a build-time constant,
 * so the mock bootstrap is dead code in production; the Vite guard fails the build if it survives.
 */
export const mocksEnabled = __SEAMNEX_MOCKS__;

/** Which platform the browser is talking to. `live` means the real API behind `/api/v1`. */
export const apiMode: 'live' | 'mock' = mocksEnabled ? 'mock' : 'live';

/**
 * The API origin is configuration, not code. A development server proxies `/api/v1` to the API
 * (`vite.config.ts`), so the client keeps a relative base there — an absolute base would make every
 * call cross-origin in development. A production build may point at an absolute origin; an empty
 * value keeps the same-origin prefix the edge exposes.
 */
export function apiBaseUrl(): string | undefined {
  if (import.meta.env.DEV) return undefined;
  const configured = import.meta.env.VITE_API_BASE_URL;
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}

/**
 * In live mode the role comes from `GET /auth/session`, never from `?role=`. The session kit reads
 * this function, so a hand-edited URL cannot change which navigation renders.
 */
export const assertedRole = mocksEnabled ? undefined : readAssertedRole;

/** Points the shared request pipeline at either the mock adapter or the real API. */
export function applySessionTransport(session: SessionState): void {
  if (!mocksEnabled) {
    const baseUrl = apiBaseUrl();
    configureTransport(createFetchTransport(baseUrl === undefined ? {} : { baseUrl }));
    return;
  }
  configureTransport(
    createPrototypeTransport({
      role: session.role,
      scenario: session.scenario,
      latencyMs: session.latencyMs,
    }),
  );
}

/**
 * Boot-time session resolution against the real API.
 *
 * Three outcomes, all decided by `sessionRouting`:
 *  - no session and not on `/sign-in` → go there, carrying the interrupted path as `next`;
 *  - a session on `/sign-in` → go to `next` (same-origin paths only);
 *  - a session anywhere → remember the asserted role and continue.
 *
 * A transport failure is not a signed-out user: the app boots and the screens show the network
 * problem, because redirecting the whole platform to sign-in during an API outage would hide it.
 */
export async function applyServerSession(session: SessionState): Promise<SessionState> {
  if (mocksEnabled) return session;

  const current = await readServerSession();
  if (current === null) return session;

  const routing = sessionRouting(current, {
    pathname: window.location.pathname,
    search: window.location.search,
  });

  if (routing.kind === 'redirect') {
    window.location.replace(routing.url);
    return session;
  }

  rememberAssertedRole(routing.role);
  // The sign-in screens need to know whether the development picker is meaningful here.
  rememberAuthProvider(current.auth.provider);
  return routing.role === null ? session : { ...session, role: routing.role };
}
