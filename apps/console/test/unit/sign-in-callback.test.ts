import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginSignIn, completeSignIn, providerLogoutUrl } from '@seamnex/api-client';
import type { AuthProviderConfig } from '@seamnex/domain';

/**
 * The front half of the relying party: the SPA decides what to send the browser to, and refuses a
 * callback it did not ask for. `state` is checked *before* the code is posted anywhere, so a forged
 * callback never reaches the API — which is why this half deserves its own cases.
 */
const OIDC: AuthProviderConfig = {
  provider: 'oidc',
  authorizeUrl: 'http://localhost:8082/realms/seamnex/protocol/openid-connect/auth',
  endSessionUrl: 'http://localhost:8082/realms/seamnex/protocol/openid-connect/logout',
  clientId: 'seamnex-platform-ui',
  scope: 'openid profile email groups',
  redirectPath: '/sign-in',
};

const STUB: AuthProviderConfig = {
  provider: 'stub',
  authorizeUrl: null,
  endSessionUrl: null,
  clientId: null,
  scope: null,
  redirectPath: '/sign-in',
};

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value),
  };
}

beforeEach(() => {
  const storage = memoryStorage();
  vi.stubGlobal('window', {
    location: { origin: 'http://localhost:5174' },
    sessionStorage: storage,
  });
  vi.stubGlobal('sessionStorage', storage);
});

describe('sign-in hand-off', () => {
  it('builds an authorization URL with PKCE, state and the origin-scoped redirect', async () => {
    const url = new URL((await beginSignIn(OIDC, '/instances?state=ready')) ?? '');
    expect(url.origin + url.pathname).toBe(OIDC.authorizeUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('seamnex-platform-ui');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5174/sign-in');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')?.length).toBeGreaterThan(20);
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  it('asks the provider to re-authenticate when the user wants a different account', async () => {
    const url = new URL((await beginSignIn(OIDC, '/', { force: true })) ?? '');
    expect(url.searchParams.get('prompt')).toBe('login');
  });

  it('offers no redirect for the development stub', async () => {
    expect(await beginSignIn(STUB, '/')).toBeNull();
  });

  it('ignores a callback this browser did not initiate', async () => {
    const outcome = await completeSignIn(OIDC, '?code=abc&state=forged');
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'expired' });
  });

  it('refuses a callback whose state does not match the pending request, without an exchange', async () => {
    await beginSignIn(OIDC, '/catalog');
    const outcome = await completeSignIn(OIDC, '?code=abc&state=forged');
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'state-mismatch' });
  });

  it('reports a cancelled login as cancellation, not as a failure', async () => {
    const outcome = await completeSignIn(
      OIDC,
      '?error=access_denied&error_description=User+refused',
    );
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'cancelled' });
  });

  it('treats an ordinary visit as no callback at all', async () => {
    expect(await completeSignIn(OIDC, '?next=%2Fcatalog')).toEqual({ kind: 'none' });
  });

  it('sends the browser to the provider logout endpoint, with a registered return URI', () => {
    const url = new URL(providerLogoutUrl(OIDC) ?? '');
    expect(url.origin + url.pathname).toBe(OIDC.endSessionUrl);
    expect(url.searchParams.get('client_id')).toBe('seamnex-platform-ui');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://localhost:5174/sign-in?signed-out=1',
    );
  });

  it('has nowhere to send the browser for the stub, which owns no session at the provider', () => {
    expect(providerLogoutUrl(STUB)).toBeNull();
  });
});
