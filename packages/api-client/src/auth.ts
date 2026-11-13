import {
  AuthSessionSchema,
  LogoutResponseSchema,
  type AuthProviderConfig,
  type AuthSession,
  type LogoutResponse,
  type PlatformRole,
  type SignInRequest,
} from '@seamnex/domain';
import { ApiError, request } from './http';

/**
 * Session surface helpers (deliverable 3.2).
 *
 * The browser holds no credential: it starts an authorization-code flow with PKCE, the server sets
 * an HttpOnly cookie, and every later call rides on that cookie. The readable `seamnex_csrf` cookie is
 * echoed as `x-seamnex-csrf` by the HTTP pipeline, never stored in application state.
 */
export const authKeys = {
  session: ['auth', 'session'] as const,
};

/** `GET /auth/session` answers 200 with `authenticated:false`; it never throws for a cold start. */
export function fetchSession(): Promise<AuthSession> {
  return request('/auth/session', { schema: AuthSessionSchema });
}

/**
 * Reads the server's session once at boot. A transport failure is `null`, not an exception: the
 * screens already render `NETWORK_ERROR`, and a boot that cannot ask the API must not look like a
 * signed-out user (which would send everyone to the sign-in page during an outage).
 */
export async function readServerSession(): Promise<AuthSession | null> {
  try {
    return await fetchSession();
  } catch {
    return null;
  }
}

export type SessionLocation = { pathname: string; search: string };

export type SessionRouting =
  /** Stay on this page; `role` is the server-asserted role (null when it asserted none). */
  | { kind: 'continue'; role: PlatformRole | null }
  /** Leave this page: no session, or an existing session on the sign-in screen. */
  | { kind: 'redirect'; url: string; reason: 'unauthenticated' | 'already-signed-in' };

/**
 * What the boot should do with the server's answer. Kept pure so both apps share one rule and it
 * can be tested without a browser:
 *
 * - no session outside `/sign-in` → `/sign-in?next=<here>`, so the return path survives;
 * - no session on `/sign-in` → continue, the page owns the exchange;
 * - a session on `/sign-in` → the destination (`next`, same-origin only), never a second sign-in;
 * - a session anywhere → continue with the role the server asserted.
 */
export function sessionRouting(session: AuthSession, location: SessionLocation): SessionRouting {
  const asserted = session.roles[0] ?? null;

  if (!session.authenticated) {
    if (location.pathname === '/sign-in') return { kind: 'continue', role: asserted };
    const here = `${location.pathname}${location.search}`;
    return {
      kind: 'redirect',
      url: `/sign-in?next=${encodeURIComponent(here)}`,
      reason: 'unauthenticated',
    };
  }

  if (location.pathname === '/sign-in') {
    const next = new URLSearchParams(location.search).get('next');
    return { kind: 'redirect', url: safeNextPath(next), reason: 'already-signed-in' };
  }

  return { kind: 'continue', role: asserted };
}

/** Only a same-origin absolute path is a valid return destination. */
export function safeNextPath(next: string | null): string {
  if (next === null || !next.startsWith('/') || next.startsWith('//')) return '/';
  if (next.startsWith('/sign-in')) return '/';
  return next;
}

export function startSession(input: SignInRequest): Promise<AuthSession> {
  return request('/auth/session', { method: 'POST', body: input, schema: AuthSessionSchema });
}

export function endSession(): Promise<LogoutResponse> {
  return request('/me/logout', { method: 'POST', schema: LogoutResponseSchema });
}

/** 32 random bytes as base64url — an RFC 7636 verifier of 43 characters. */
export function createCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** S256: `base64url(sha256(verifier))`, exactly what the provider recomputes. */
export async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The development exchange. The code names the directory user, so this is an affordance rather
 * than a credential — the server refuses the stub outside development (ADR-BE-13).
 */
export async function signInWithStub(username: string, mfaCode?: string): Promise<AuthSession> {
  const codeVerifier = createCodeVerifier();
  const codeChallenge = await codeChallengeFor(codeVerifier);
  return startSession({
    code: `stub:${username}`,
    codeVerifier,
    codeChallenge,
    redirectUri: `${window.location.origin}/sign-in`,
    ...(mfaCode === undefined ? {} : { mfaCode }),
  });
}

// ---------------------------------------------------------------------------------------------
// Authorization-code flow against a live provider (ADR-BE-14)
// ---------------------------------------------------------------------------------------------

/** The correlation state a callback is checked against; it never leaves this origin's storage. */
type PendingSignIn = {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
  readonly next: string;
};

const PENDING_KEY = 'seamnex:signin.pending';

export type CallbackFailure =
  /** The user closed or refused the provider's login page (`error=access_denied`). */
  | 'cancelled'
  /** The callback carried state this browser did not issue: a replay or a cross-site attempt. */
  | 'state-mismatch'
  /** No pending flow: the tab was reloaded after a long wait, or storage was cleared. */
  | 'expired'
  /** The provider authenticated the account without the second factor its role requires. */
  | 'mfa-required'
  /** The provider asserted no platform role for the account. */
  | 'no-role'
  /** The provider could not be reached; the credentials were never evaluated. */
  | 'provider-unavailable'
  | 'provider-error';

export type CallbackOutcome =
  /** The URL carries no callback: an ordinary visit to the sign-in page. */
  | { readonly kind: 'none' }
  | { readonly kind: 'signed-in'; readonly session: AuthSession; readonly next: string }
  | { readonly kind: 'failed'; readonly reason: CallbackFailure; readonly detail: string };

/**
 * Builds the provider's authorization URL and remembers what the callback must match.
 *
 * Returns `null` when the provider needs no round trip (the development stub), so the screen can
 * decide between the identity picker and a redirect without duplicating the provider test.
 *
 * `force` asks the provider to re-authenticate even when it still holds a single-sign-on session —
 * "use a different account" is otherwise impossible to express: the provider would silently return
 * the previous user.
 */
export async function beginSignIn(
  auth: AuthProviderConfig,
  next: string,
  options: { readonly force?: boolean } = {},
): Promise<string | null> {
  if (
    auth.provider !== 'oidc' ||
    auth.authorizeUrl === null ||
    auth.clientId === null ||
    auth.scope === null
  ) {
    return null;
  }

  const verifier = createCodeVerifier();
  const challenge = await codeChallengeFor(verifier);
  const state = randomToken();
  const redirectUri = `${window.location.origin}${auth.redirectPath}`;

  writePending({ verifier, challenge, state, next });

  const url = new URL(auth.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', auth.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', auth.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.force === true) url.searchParams.set('prompt', 'login');
  return url.toString();
}

/**
 * Finishes the flow the provider just redirected back with.
 *
 * `state` is checked before the code is sent anywhere: a callback carrying state this browser did
 * not issue is refused locally, so a cross-site attempt never causes an exchange and never creates
 * a session. The verifier is read from storage rather than the URL, which is what makes the code
 * useless to anyone who only saw the redirect.
 */
export async function completeSignIn(
  auth: AuthProviderConfig,
  search: string,
): Promise<CallbackOutcome> {
  const params = new URLSearchParams(search);
  const providerError = params.get('error');
  if (providerError !== null) {
    clearPending();
    return {
      kind: 'failed',
      reason: providerError === 'access_denied' ? 'cancelled' : 'provider-error',
      detail:
        params.get('error_description') ??
        `The identity provider refused the sign-in (${providerError}).`,
    };
  }

  const code = params.get('code');
  if (code === null) return { kind: 'none' };

  const state = params.get('state') ?? '';
  const pending = readPending();
  if (pending === null) {
    return {
      kind: 'failed',
      reason: 'expired',
      detail: 'This sign-in attempt is no longer valid. Start again from the sign-in page.',
    };
  }
  if (state !== pending.state) {
    // Do not clear: the pending flow may still be the legitimate one, and clearing it would let a
    // forged callback cancel the real sign-in.
    return {
      kind: 'failed',
      reason: 'state-mismatch',
      detail: 'The identity provider returned a response this browser did not request.',
    };
  }

  const redirectUri = `${window.location.origin}${auth.redirectPath}`;
  try {
    const session = await startSession({
      code,
      codeVerifier: pending.verifier,
      codeChallenge: pending.challenge,
      redirectUri,
    });
    clearPending();
    return { kind: 'signed-in', session, next: pending.next };
  } catch (error) {
    clearPending();
    const problem = error instanceof ApiError ? error.problem : null;
    const reason: CallbackFailure =
      problem?.code === 'MFA_REQUIRED' || problem?.code === 'MFA_INVALID'
        ? 'mfa-required'
        : problem?.code === 'FORBIDDEN'
          ? 'no-role'
          : problem?.code === 'UNAVAILABLE'
            ? 'provider-unavailable'
            : 'provider-error';
    return {
      kind: 'failed',
      reason,
      detail: problem?.detail ?? 'The sign-in could not be completed. Start again from this page.',
    };
  }
}

/**
 * The provider's logout URL, so signing out ends the single-sign-on session too.
 *
 * Without it the next sign-in silently re-enters as the previous user: the platform session is
 * gone, but the provider still holds one, and that reads as "sign-out did not work".
 */
export function providerLogoutUrl(
  auth: AuthProviderConfig,
  options: { readonly next?: string } = {},
): string | null {
  if (auth.provider !== 'oidc' || auth.endSessionUrl === null || auth.clientId === null)
    return null;
  const url = new URL(auth.endSessionUrl);
  url.searchParams.set('client_id', auth.clientId);
  const returned = options.next ?? `${auth.redirectPath}?signed-out=1`;
  url.searchParams.set('post_logout_redirect_uri', `${window.location.origin}${returned}`);
  return url.toString();
}

/**
 * The provider logout a completed sign-out still owes, remembered for this tab.
 *
 * `POST /me/logout` ends the platform session; leaving for the provider's `end_session` endpoint
 * happens from the residual-report dialog, and that click is optional. Closing the tab or reloading
 * the page used to skip it, so the provider kept its own single-sign-on session and the next visit
 * silently re-entered as the previous person. Recording the destination makes the completion
 * independent of that click; it is read once, so a provider that bounces back to the sign-in page
 * cannot be sent round again.
 */
const PROVIDER_LOGOUT_KEY = 'seamnex:provider-logout';

export function rememberProviderLogout(url: string): void {
  try {
    storage()?.setItem(PROVIDER_LOGOUT_KEY, url);
  } catch {
    // Without storage the dialog's own navigation is the only path, exactly as before.
  }
}

/** Read-once, so a half-finished sign-out cannot become a redirect loop. */
export function takeProviderLogout(): string | null {
  try {
    const url = storage()?.getItem(PROVIDER_LOGOUT_KEY) ?? null;
    if (url !== null) storage()?.removeItem(PROVIDER_LOGOUT_KEY);
    return url;
  } catch {
    return null;
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Private mode or a hardened browser: the flow still works, it just cannot survive a reload.
    return null;
  }
}

function writePending(pending: PendingSignIn): void {
  try {
    storage()?.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Storage full or unavailable: the callback then reports `expired`, which is honest.
  }
}

function readPending(): PendingSignIn | null {
  try {
    const raw = storage()?.getItem(PENDING_KEY);
    if (raw === null || raw === undefined) return null;
    const parsed = JSON.parse(raw) as Partial<PendingSignIn>;
    const valid =
      typeof parsed.verifier === 'string' &&
      typeof parsed.challenge === 'string' &&
      typeof parsed.state === 'string' &&
      typeof parsed.next === 'string';
    return valid ? (parsed as PendingSignIn) : null;
  } catch {
    return null;
  }
}

function clearPending(): void {
  try {
    storage()?.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
