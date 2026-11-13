import { PLATFORM_ROLES, type PlatformRole } from '@seamnex/domain';

/**
 * The role the **server** asserted for this tab.
 *
 * In the prototype the role came from `?role=`; against the real API that is a client-supplied
 * claim, and the console's default (`R1`) would render administrator chrome for a member until the
 * first `403`. The boot therefore records what `GET /auth/session` said and the session kit prefers
 * it over the URL. It is a rendering hint only: every request is still authorised by the PDP.
 */
const STORAGE_KEY = 'seamnex:asserted-role';

/**
 * Which provider issued the current session. The prototype role switcher is a *development*
 * affordance: it navigates to `/sign-in?role=…`, which under a real identity provider just starts
 * another login and asserts whatever that provider says. A control that cannot do what it says is
 * worse than no control, so the screens hide it unless the provider is the stub.
 */
const PROVIDER_KEY = 'seamnex:auth-provider';

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Private mode or a blocked storage partition: the URL hint remains as a degraded fallback.
    return null;
  }
}

export function rememberAuthProvider(provider: 'stub' | 'oidc'): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(PROVIDER_KEY, provider);
  } catch {
    // Same reasoning as the role: a full quota must not stop the application from booting.
  }
}

/** True when the server said the development stub is the provider (or said nothing yet). */
export function devSignInAvailable(): boolean {
  const store = storage();
  if (store === null) return false;
  try {
    return store.getItem(PROVIDER_KEY) === 'stub';
  } catch {
    return false;
  }
}

export function rememberAssertedRole(role: PlatformRole | null): void {
  const store = storage();
  if (store === null) return;
  try {
    if (role === null) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, role);
  } catch {
    // A full quota must not stop the application from booting.
  }
}

export function readAssertedRole(): PlatformRole | null {
  const store = storage();
  if (store === null) return null;
  try {
    const value = store.getItem(STORAGE_KEY);
    return value !== null && (PLATFORM_ROLES as readonly string[]).includes(value)
      ? (value as PlatformRole)
      : null;
  } catch {
    return null;
  }
}

/** Called when the platform reports a lapsed session: the tab must not keep a stale role. */
export function clearAssertedRole(): void {
  rememberAssertedRole(null);
}
