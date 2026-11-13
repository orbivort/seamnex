import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthProviderConfig, AuthSession, ProblemDetail } from '@seamnex/domain';
import {
  beginSignIn,
  codeChallengeFor,
  completeSignIn,
  createCodeVerifier,
  endSession,
  fetchSession,
  providerLogoutUrl,
  readServerSession,
  rememberProviderLogout,
  safeNextPath,
  sessionRouting,
  signInWithStub,
  startSession,
  takeProviderLogout,
} from '../../src/auth';
import { configureTransport, resetTransport } from '../../src/http';
import type { Transport, TransportRequest } from '../../src/transport';

/**
 * The session surface is where a wrong answer is expensive: a boot that treats an outage as
 * "signed out" sends everyone to the sign-in page, and a callback that skips the `state` check
 * turns a cross-site request into a session. Every branch of both is asserted here.
 */
const ORIGIN = 'https://portal.seamnex.local';

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    authenticated: true,
    subject: { idpId: 'idp-1', username: 'lena.hoff', displayName: 'Lena Hoff' },
    roles: ['R5'],
    groups: ['all-staff'],
    mfaSatisfied: true,
    mfaMethod: 'totp',
    csrfToken: null,
    createdAt: null,
    expiresAt: null,
    idleExpiresAt: null,
    auth: {
      provider: 'oidc',
      authorizeUrl: 'https://idp.seamnex.local/authorize',
      endSessionUrl: 'https://idp.seamnex.local/logout',
      clientId: 'portal',
      scope: 'openid profile email',
      redirectPath: '/sign-in/callback',
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Transport {
  return async () => new Response(JSON.stringify(body), { status });
}

function problemResponse(
  status: number,
  code: string,
  detail = 'Refused by the platform.',
  retryAfter?: string,
): Transport {
  const problem: ProblemDetail = {
    type: 'https://platform.seamnex.local/problems/x',
    title: 'Refused',
    status,
    detail,
    code,
    fieldErrors: [],
    remediation: 'Start the sign-in again from the sign-in page.',
  };
  return async () =>
    new Response(JSON.stringify(problem), {
      status,
      headers: {
        'Content-Type': 'application/problem+json',
        ...(retryAfter === undefined ? {} : { 'Retry-After': retryAfter }),
      },
    });
}

function capture(body: unknown = session()): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (input) => {
    calls.push(input);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { transport, calls };
}

beforeEach(() => {
  const storage = memoryStorage();
  vi.stubGlobal('window', {
    location: { origin: ORIGIN },
    sessionStorage: storage,
    dispatchEvent: () => false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('sessionStorage', storage);
});

afterEach(() => {
  resetTransport();
  vi.unstubAllGlobals();
});

describe('session reads', () => {
  it('parses the session document the server returns', async () => {
    configureTransport(jsonResponse(session()));
    await expect(fetchSession()).resolves.toMatchObject({ authenticated: true, roles: ['R5'] });
  });

  it('reports a transport failure as no session instead of throwing at boot', async () => {
    configureTransport(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(readServerSession()).resolves.toBeNull();
  });

  it('passes a session through when the API answered', async () => {
    configureTransport(jsonResponse(session()));
    await expect(readServerSession()).resolves.toMatchObject({ authenticated: true });
  });

  it('posts the exchange and the logout through the declared operations', async () => {
    const exchange = capture();
    configureTransport(exchange.transport);
    await startSession({
      code: 'code-1',
      codeVerifier: 'a'.repeat(43),
      codeChallenge: 'b'.repeat(43),
      redirectUri: `${ORIGIN}/sign-in/callback`,
    });

    expect(exchange.calls[0]).toMatchObject({ path: '/auth/session', method: 'POST' });

    const logout = capture({
      signedOutAt: '2026-11-05T08:00:00.000Z',
      residualSessions: [],
      statement: 'You are signed out everywhere.',
    });
    configureTransport(logout.transport);
    await endSession();
    expect(logout.calls[0]).toMatchObject({ path: '/me/logout', method: 'POST' });
  });
});

describe('sessionRouting', () => {
  const anonymous = session({ authenticated: false, roles: [], subject: null });

  it('sends an unauthenticated visitor to sign-in, preserving the interrupted path', () => {
    expect(sessionRouting(anonymous, { pathname: '/entitlements', search: '?tab=all' })).toEqual({
      kind: 'redirect',
      url: '/sign-in?next=%2Fentitlements%3Ftab%3Dall',
      reason: 'unauthenticated',
    });
  });

  it('lets the sign-in page own the exchange when there is no session yet', () => {
    expect(sessionRouting(anonymous, { pathname: '/sign-in', search: '' })).toEqual({
      kind: 'continue',
      role: null,
    });
  });

  it('does not sign in twice: a session on /sign-in goes to the return path', () => {
    expect(
      sessionRouting(session(), { pathname: '/sign-in', search: '?next=%2Fproduct%2Fcrm' }),
    ).toEqual({ kind: 'redirect', url: '/product/crm', reason: 'already-signed-in' });
  });

  it('continues with the asserted role on any other page', () => {
    expect(sessionRouting(session({ roles: ['R3'] }), { pathname: '/', search: '' })).toEqual({
      kind: 'continue',
      role: 'R3',
    });
    expect(sessionRouting(session({ roles: [] }), { pathname: '/', search: '' })).toEqual({
      kind: 'continue',
      role: null,
    });
  });
});

describe('safeNextPath', () => {
  it('accepts a same-origin absolute path and refuses everything else', () => {
    expect(safeNextPath('/entitlements')).toBe('/entitlements');
    expect(safeNextPath('/product/crm?tab=1')).toBe('/product/crm?tab=1');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('entitlements')).toBe('/');
    expect(safeNextPath('https://evil.example/steal')).toBe('/');
    expect(safeNextPath('//evil.example/steal')).toBe('/');
    expect(safeNextPath('/sign-in')).toBe('/');
    expect(safeNextPath('/sign-in/callback?code=1')).toBe('/');
  });
});

describe('PKCE', () => {
  it('mints a verifier from the unreserved set, at the length RFC 7636 requires', () => {
    const verifier = createCodeVerifier();

    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(createCodeVerifier()).not.toBe(verifier);
  });

  it('computes the S256 challenge the provider recomputes', async () => {
    // SHA-256("abc"), base64url without padding.
    await expect(codeChallengeFor('abc')).resolves.toBe(
      'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
    );
  });
});

describe('development stub sign-in', () => {
  it('sends a verifier, its challenge and this origin as the redirect URI', async () => {
    const { transport, calls } = capture();
    configureTransport(transport);

    await signInWithStub('lena.hoff', '123456');

    const body = calls[0]?.body as Record<string, string>;
    expect(body.code).toBe('stub:lena.hoff');
    expect(body.codeVerifier).toHaveLength(43);
    expect(body.codeChallenge).toHaveLength(43);
    expect(body.redirectUri).toBe(`${ORIGIN}/sign-in`);
    expect(body.mfaCode).toBe('123456');
  });

  it('omits the second factor when the caller has none', async () => {
    const { transport, calls } = capture();
    configureTransport(transport);

    await signInWithStub('lena.hoff');

    expect(calls[0]?.body).not.toHaveProperty('mfaCode');
  });
});

describe('beginSignIn', () => {
  const oidc: AuthProviderConfig = {
    provider: 'oidc',
    authorizeUrl: 'https://idp.seamnex.local/authorize',
    endSessionUrl: 'https://idp.seamnex.local/logout',
    clientId: 'portal',
    scope: 'openid profile email',
    redirectPath: '/sign-in/callback',
  };

  it('needs no round trip for the stub provider', async () => {
    await expect(beginSignIn({ ...oidc, provider: 'stub' }, '/entitlements')).resolves.toBeNull();
  });

  it('refuses to build a URL from an incomplete provider config', async () => {
    await expect(beginSignIn({ ...oidc, authorizeUrl: null }, '/')).resolves.toBeNull();
    await expect(beginSignIn({ ...oidc, clientId: null }, '/')).resolves.toBeNull();
    await expect(beginSignIn({ ...oidc, scope: null }, '/')).resolves.toBeNull();
  });

  it('builds a PKCE authorization URL and remembers what the callback must match', async () => {
    const url = new URL((await beginSignIn(oidc, '/entitlements')) ?? '');

    expect(`${url.origin}${url.pathname}`).toBe('https://idp.seamnex.local/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('portal');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/sign-in/callback`);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect(url.searchParams.get('prompt')).toBeNull();

    const pending = JSON.parse(sessionStorage.getItem('seamnex:signin.pending') ?? '{}') as {
      state: string;
      next: string;
    };
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(pending.next).toBe('/entitlements');
  });

  it('asks the provider to re-authenticate when forced', async () => {
    const url = new URL((await beginSignIn(oidc, '/', { force: true })) ?? '');
    expect(url.searchParams.get('prompt')).toBe('login');
  });
});

describe('completeSignIn', () => {
  const auth: AuthProviderConfig = {
    provider: 'oidc',
    authorizeUrl: 'https://idp.seamnex.local/authorize',
    endSessionUrl: 'https://idp.seamnex.local/logout',
    clientId: 'portal',
    scope: 'openid profile email',
    redirectPath: '/sign-in/callback',
  };

  async function withPending(): Promise<{ verifier: string; state: string }> {
    // `beginSignIn` writes the pending flow; the callback must then match what it wrote.
    await beginSignIn(auth, '/entitlements');
    return JSON.parse(sessionStorage.getItem('seamnex:signin.pending') ?? '{}') as {
      verifier: string;
      state: string;
    };
  }

  it('reports a provider refusal, keeping its own explanation', async () => {
    await expect(
      completeSignIn(auth, '?error=access_denied&error_description=The%20user%20cancelled'),
    ).resolves.toEqual({
      kind: 'failed',
      reason: 'cancelled',
      detail: 'The user cancelled',
    });
    await expect(completeSignIn(auth, '?error=server_error')).resolves.toEqual({
      kind: 'failed',
      reason: 'provider-error',
      detail: 'The identity provider refused the sign-in (server_error).',
    });
  });

  it('treats a URL with no callback as an ordinary page visit', async () => {
    await expect(completeSignIn(auth, '?role=R5')).resolves.toEqual({ kind: 'none' });
  });

  it('reports an expired flow when nothing was remembered', async () => {
    await expect(completeSignIn(auth, '?code=abc&state=xyz')).resolves.toMatchObject({
      kind: 'failed',
      reason: 'expired',
    });
  });

  it('refuses a callback carrying state this browser did not issue', async () => {
    const pending = await withPending();
    await expect(
      completeSignIn(auth, `?code=abc&state=not-${pending.state}`),
    ).resolves.toMatchObject({ kind: 'failed', reason: 'state-mismatch' });
    // The legitimate pending flow must survive a forged callback.
    expect(sessionStorage.getItem('seamnex:signin.pending')).not.toBeNull();
  });

  it('treats unreadable pending state as expired', async () => {
    sessionStorage.setItem('seamnex:signin.pending', 'not-json');
    await expect(completeSignIn(auth, '?code=abc&state=x')).resolves.toMatchObject({
      kind: 'failed',
      reason: 'expired',
    });
  });

  it('exchanges a matching callback and returns the remembered destination', async () => {
    const pending = await withPending();
    const { transport, calls } = capture();
    configureTransport(transport);

    const outcome = await completeSignIn(auth, `?code=abc&state=${pending.state}`);

    expect(outcome).toMatchObject({ kind: 'signed-in', next: '/entitlements' });
    expect((calls[0]?.body as Record<string, string>).codeVerifier).toBe(pending.verifier);
    expect(sessionStorage.getItem('seamnex:signin.pending')).toBeNull();
  });

  it.each([
    ['MFA_REQUIRED', 'mfa-required'],
    ['FORBIDDEN', 'no-role'],
    ['UNAVAILABLE', 'provider-unavailable'],
    ['SOMETHING_ELSE', 'provider-error'],
  ])('maps a %s refusal to %s', async (code, reason) => {
    const pending = await withPending();
    configureTransport(problemResponse(401, code, 'The exchange was refused.'));

    await expect(completeSignIn(auth, `?code=abc&state=${pending.state}`)).resolves.toEqual({
      kind: 'failed',
      reason,
      detail: 'The exchange was refused.',
    });
  });

  it('falls back to a neutral sentence for a failure with no problem document', async () => {
    const pending = await withPending();
    configureTransport(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(completeSignIn(auth, `?code=abc&state=${pending.state}`)).resolves.toMatchObject({
      kind: 'failed',
      reason: 'provider-error',
      detail: 'fetch failed',
    });
  });
});

describe('provider logout', () => {
  const auth: AuthProviderConfig = {
    provider: 'oidc',
    authorizeUrl: 'https://idp.seamnex.local/authorize',
    endSessionUrl: 'https://idp.seamnex.local/logout',
    clientId: 'portal',
    scope: 'openid profile email',
    redirectPath: '/sign-in/callback',
  };

  it('builds the end-session URL with this origin as the return destination', () => {
    const url = new URL(providerLogoutUrl(auth) ?? '');

    expect(`${url.origin}${url.pathname}`).toBe('https://idp.seamnex.local/logout');
    expect(url.searchParams.get('client_id')).toBe('portal');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      `${ORIGIN}/sign-in/callback?signed-out=1`,
    );
  });

  it('honours an explicit return path', () => {
    const url = new URL(providerLogoutUrl(auth, { next: '/signed-out' }) ?? '');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/signed-out`);
  });

  it('has nothing to build for the stub or an incomplete provider', () => {
    expect(providerLogoutUrl({ ...auth, provider: 'stub' })).toBeNull();
    expect(providerLogoutUrl({ ...auth, endSessionUrl: null })).toBeNull();
    expect(providerLogoutUrl({ ...auth, clientId: null })).toBeNull();
  });

  it('remembers the owed logout once, so a bounce cannot loop', () => {
    rememberProviderLogout('https://idp.seamnex.local/logout?x=1');
    expect(takeProviderLogout()).toBe('https://idp.seamnex.local/logout?x=1');
    expect(takeProviderLogout()).toBeNull();
  });

  it('does nothing when storage is unavailable', () => {
    vi.stubGlobal('window', {
      location: { origin: ORIGIN },
      get sessionStorage(): Storage {
        throw new Error('blocked');
      },
    });

    expect(() => rememberProviderLogout('https://idp.seamnex.local/logout')).not.toThrow();
    expect(takeProviderLogout()).toBeNull();
  });

  it('reports no owed logout when the record cannot be read', () => {
    vi.stubGlobal('window', {
      location: { origin: ORIGIN },
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });

    // A read that throws is not a destination; the sign-in page must still be reachable.
    expect(takeProviderLogout()).toBeNull();
  });
});
