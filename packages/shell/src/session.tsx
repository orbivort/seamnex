import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { PlatformRole, Scenario } from '@seamnex/domain';
import { PLATFORM_ROLES, SCENARIOS } from '@seamnex/domain';

/**
 * Role, scenario and latency are prototype controls, but the plumbing is shared:
 * both apps read them from the URL, rebuild the transport when they change and expose
 * the same context. Only the defaults and the switcher chrome differ per app.
 */

export type SessionState = { role: PlatformRole; scenario: Scenario; latencyMs: number };

export type SessionDefaults = {
  defaultRole: PlatformRole;
  defaultLatencyMs: number;
  /**
   * The role the server asserted for this tab (live mode only). When present it wins over the
   * `?role=` hint: a client-supplied claim must not decide which navigation a user sees.
   */
  assertedRole?: () => PlatformRole | null;
};

export type SessionKitOptions = SessionDefaults & {
  /** Called before React re-renders, so the next request already uses the new session. */
  onChange?: (session: SessionState) => void;
};

export function isPlatformRole(value: string | null): value is PlatformRole {
  return value !== null && (PLATFORM_ROLES as readonly string[]).includes(value);
}

export function isScenario(value: string | null): value is Scenario {
  return value !== null && (SCENARIOS as readonly string[]).includes(value);
}

/**
 * The session-shaped fields a query string actually carries. Absent or invalid params are omitted
 * rather than defaulted, because the two readers need different fallbacks: the pre-render bootstrap
 * fills gaps with the kit defaults, while the in-React sync must leave the current value alone when
 * a navigation simply does not mention the parameter.
 */
function parseSessionParams(search: string): Partial<SessionState> {
  const params = new URLSearchParams(search);
  const role = params.get('role');
  const scenario = params.get('scenario');
  const latency = Number.parseInt(params.get('latency') ?? '', 10);
  return {
    ...(isPlatformRole(role) ? { role } : {}),
    ...(isScenario(scenario) ? { scenario } : {}),
    ...(Number.isFinite(latency) ? { latencyMs: Math.max(0, Math.min(latency, 2_000)) } : {}),
  };
}

/**
 * Overlay the params a query string carries onto a session.
 *
 * `asserted` wins over `?role=`, exactly as it does in `readSessionFromUrl`: in live mode the
 * server's answer is the only claim allowed to decide which navigation renders, and the URL sync
 * below must not become a hole in that rule merely because it does not reload the page.
 */
function applySessionParams(
  current: SessionState,
  search: string,
  asserted: PlatformRole | null,
): SessionState {
  return {
    ...current,
    ...parseSessionParams(search),
    ...(asserted === null ? {} : { role: asserted }),
  };
}

/**
 * Module-scope on purpose: each app's `main.tsx` calls this before `createRoot`, and `bootstrap.ts`
 * and `api-mode.ts` read the same values before React owns the document. It is the only read that
 * may happen outside React, so it stays a pure function of `window.location`.
 */
export function readSessionFromUrl({
  defaultRole,
  defaultLatencyMs,
  assertedRole,
}: SessionDefaults): SessionState {
  const fromUrl = parseSessionParams(window.location.search);
  const asserted = assertedRole?.() ?? null;
  return {
    // An asserted role beats the hint; the hint beats the kit default.
    role: asserted ?? fromUrl.role ?? defaultRole,
    scenario: fromUrl.scenario ?? 'degraded',
    latencyMs: fromUrl.latencyMs ?? defaultLatencyMs,
  };
}

function reloadWithParam(name: string, value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.location.assign(url.toString());
}

/**
 * The in-React read of the session params.
 *
 * `readSession()` above deliberately stays a module-scope read for the pre-render bootstrap, but
 * once React is running the URL has to be a *live* input: a bookmark, a hand-edited query string or
 * a back/forward step must reach the context without a reload.
 *
 * `@seamnex/shell` has no router dependency and must not acquire one just for this, so the subscription
 * is to the platform location: `popstate` is the only event the History API emits for a URL change.
 * Router-owned navigations that *set* a session param can be wired through `useSearchParams` at the
 * call site (each app's `session.tsx`) without touching this file — the seam is the snapshot below.
 */
const LOCATION_SEARCH_EVENT = 'seamnex:locationchange';
let historyPatched = false;

/**
 * `pushState`/`replaceState` emit no event, so a router navigation would be invisible to the
 * snapshot. Patching the two methods once — idempotent, never unpatched, and reference-free — is
 * cheaper than teaching a design-system-adjacent package about a router it does not depend on.
 */
function patchHistoryOnce(): void {
  if (historyPatched || typeof window === 'undefined') return;
  historyPatched = true;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method];
    window.history[method] = function patched(data, unused, url) {
      original.call(this, data, unused, url);
      // Deferred: a listener must not run in the middle of the caller's history call.
      queueMicrotask(() => window.dispatchEvent(new Event(LOCATION_SEARCH_EVENT)));
    };
  }
}

function subscribeToLocation(onChange: () => void): () => void {
  patchHistoryOnce();
  window.addEventListener('popstate', onChange);
  window.addEventListener(LOCATION_SEARCH_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(LOCATION_SEARCH_EVENT, onChange);
  };
}

function getLocationSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}

/** The session params are client-only, so hydration would see the same empty string the server did. */
function getServerLocationSearch(): string {
  return '';
}

function useLocationSearch(): string {
  // A string snapshot is compared by value, so no cached object is needed to avoid render loops.
  return useSyncExternalStore(subscribeToLocation, getLocationSearch, getServerLocationSearch);
}

export type SessionContextValue = {
  session: SessionState;
  setRole: (role: PlatformRole) => void;
  setScenario: (scenario: Scenario) => void;
  setLatency: (latencyMs: number) => void;
};

export type SessionKit = {
  readSession: () => SessionState;
  /**
   * `search` lets the app supply the query string from its router instead of the platform
   * location. It is optional so a consumer without a router (a component test, the portal's
   * standalone surfaces) keeps the subscription-based behaviour.
   */
  SessionProvider: (props: { children: ReactNode; search?: string }) => ReactNode;
  useSession: () => SessionContextValue;
};

export function createSessionKit(options: SessionKitOptions): SessionKit {
  const { defaultRole, defaultLatencyMs, onChange, assertedRole } = options;
  const readSession = (): SessionState =>
    readSessionFromUrl({
      defaultRole,
      defaultLatencyMs,
      ...(assertedRole === undefined ? {} : { assertedRole }),
    });

  const SessionContext = createContext<SessionContextValue | null>(null);

  function SessionProvider({
    children,
    search: routerSearch,
  }: {
    children: ReactNode;
    search?: string;
  }) {
    // Initial state still comes from `readSession`, so the first render agrees with the transport
    // `main.tsx` already built from the same URL.
    const [session, setSession] = useState<SessionState>(readSession);
    /**
     * The router's view of the query string wins when the app provides one: it is the value React
     * re-renders from, so a back/forward step arrives as a render instead of as a subscription
     * notification. The platform subscription stays as the fallback for consumers without a
     * router, and both paths parse with the same function, so they cannot disagree.
     */
    const platformSearch = useLocationSearch();
    const search = routerSearch ?? platformSearch;

    /**
     * The newest session for callbacks that must keep their identity. Written in an effect, never
     * during render: a render-phase ref write is a side effect React may replay.
     */
    const sessionRef = useRef(session);
    useEffect(() => {
      sessionRef.current = session;
    }, [session]);

    /** The search string already folded into `session`; see the sync effect below. */
    const appliedSearchRef = useRef(search);

    /**
     * Keep state in step with the URL.
     *
     * Guarded by the last search string that was applied: the URL is an *input*, not the source of
     * truth, so re-applying it on every render would undo an in-app change. Without the guard, a
     * session that arrived as `?latency=900` would snap back to 900 the moment the knob was set to
     * 0 ms. The initial value is the first `search`, which `readSession` has already applied.
     *
     * Only parameters that are present are applied, so a navigation that does not mention
     * `scenario` keeps the current scenario — these are session controls, not route state.
     */
    useEffect(() => {
      if (appliedSearchRef.current === search) return;
      appliedSearchRef.current = search;
      const next = applySessionParams(session, search, assertedRole?.() ?? null);
      if (
        next.role === session.role &&
        next.scenario === session.scenario &&
        next.latencyMs === session.latencyMs
      ) {
        return;
      }
      // Transport first, then React: the next request must not race the re-render.
      onChange?.(next);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL is the external system this effect synchronises with; the ref above is the guard, and the alternative (URL as state) would re-apply a stale scenario on every render
      setSession(next);
      // `onChange` is a kit-construction argument, not a prop, so it cannot change between renders.
    }, [search, session]);

    /**
     * Phase 3: the role is asserted by the identity provider, not by a query parameter or a header.
     * The prototype switcher therefore becomes a shortcut into the sign-in screen for that
     * identity; the session that comes back is what the screens run under.
     */
    const setRole = useCallback((role: PlatformRole) => {
      const url = new URL(window.location.href);
      url.searchParams.delete('role');
      const next = `${url.pathname}${url.search}`;
      window.location.assign(`/sign-in?role=${role}&next=${encodeURIComponent(next)}`);
    }, []);

    const setScenario = useCallback((scenario: Scenario) => {
      // A scenario reloads a fresh mock platform, so the page must be rebuilt.
      reloadWithParam('scenario', scenario);
    }, []);

    /**
     * `sessionRef` instead of `session`: closing over the state value would give this callback a new
     * identity on every session change, which in turn would rebuild the memoised context value and
     * re-render every consumer for a control that only the transport cares about.
     */
    const setLatency = useCallback((latencyMs: number) => {
      const next = { ...sessionRef.current, latencyMs };
      onChange?.(next);
      // Functional form, so a URL-driven update that lands in the same batch is not clobbered.
      setSession((current) =>
        current.latencyMs === latencyMs ? current : { ...current, latencyMs },
      );
    }, []);

    const value = useMemo(
      () => ({ session, setRole, setScenario, setLatency }),
      [session, setRole, setScenario, setLatency],
    );

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
  }

  function useSession(): SessionContextValue {
    const context = useContext(SessionContext);
    if (!context) throw new Error('useSession must be used inside SessionProvider');
    return context;
  }

  return { readSession, SessionProvider, useSession };
}
