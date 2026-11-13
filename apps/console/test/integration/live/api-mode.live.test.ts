import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@seamnex/domain';
import type { SessionState } from '@seamnex/shell';
import type * as ApiClient from '@seamnex/api-client';

/**
 * `api-mode` and `bootstrap` under a build with the mock platform switched **off**.
 *
 * This file runs in the `console-live` project, whose Vite `define` sets `__SEAMNEX_MOCKS__` to `false`.
 * The other project cannot reach these branches: in a test build the flag is a literal `true`, so
 * the live transport, the server-session routing and the early return in `prepareMockPlatform` are
 * dead code there — unreachable, not merely untested.
 *
 * The live code still talks to the real `@seamnex/api-client`, so the boundary is mocked here rather
 * than the module under test: that keeps every statement inside `api-mode.ts` real.
 */
const client = vi.hoisted(() => ({
  configureTransport: vi.fn(),
  createFetchTransport: vi.fn((options: { baseUrl?: string } = {}) => ({
    kind: 'fetch',
    options,
  })),
  readServerSession: vi.fn(),
}));

vi.mock('@seamnex/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    configureTransport: client.configureTransport,
    createFetchTransport: client.createFetchTransport,
    readServerSession: client.readServerSession,
  };
});

const SESSION: SessionState = { role: 'R5', scenario: 'degraded', latencyMs: 0 };

function serverSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    authenticated: true,
    subject: { idpId: 'usr-sofia', username: 'sofia.almeida', displayName: 'Sofia Almeida' },
    roles: ['R1'],
    groups: ['platform-admins'],
    mfaSatisfied: true,
    mfaMethod: 'webauthn',
    csrfToken: null,
    createdAt: null,
    expiresAt: null,
    idleExpiresAt: null,
    auth: {
      provider: 'oidc',
      authorizeUrl: 'https://idp.seamnex.example/authorize',
      endSessionUrl: 'https://idp.seamnex.example/logout',
      clientId: 'console',
      scope: 'openid profile',
      redirectPath: '/sign-in/callback',
    },
    ...overrides,
  };
}

type LocationStub = {
  href: string;
  pathname: string;
  search: string;
  assign: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
};

const nativeLocation = Object.getOwnPropertyDescriptor(window, 'location');

/**
 * jsdom refuses a real navigation, so the address bar is replaced with a record of the same shape.
 * `applyServerSession` reads `pathname`/`search` from it and writes through `replace`.
 */
function stubLocation(pathAndSearch = '/'): LocationStub {
  const url = new URL(`http://localhost${pathAndSearch}`);
  const stub: LocationStub = {
    href: url.toString(),
    pathname: url.pathname,
    search: url.search,
    assign: vi.fn(),
    replace: vi.fn(),
  };
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: stub });
  return stub;
}

async function loadApiMode() {
  return import('../../../src/api-mode');
}

beforeEach(() => {
  sessionStorage.clear();
  stubLocation();
  client.configureTransport.mockClear();
  client.createFetchTransport.mockClear();
  client.readServerSession.mockReset();
});

afterEach(() => {
  if (nativeLocation !== undefined) Object.defineProperty(window, 'location', nativeLocation);
  sessionStorage.clear();
  vi.unstubAllEnvs();
});

describe('api-mode in a live build', () => {
  it('reports the live mode and leaves the role to the server', async () => {
    const { apiMode, assertedRole, mocksEnabled } = await loadApiMode();

    expect(mocksEnabled).toBe(false);
    expect(apiMode).toBe('live');
    // In live mode the URL hint is replaced by `GET /auth/session`; the reader is still exported.
    expect(typeof assertedRole).toBe('function');
  });

  it('keeps a relative base in development so the proxy stays same-origin', async () => {
    vi.stubEnv('DEV', true as never);
    const { apiBaseUrl } = await loadApiMode();

    expect(apiBaseUrl()).toBeUndefined();
  });

  it('uses a configured origin outside development and ignores an empty one', async () => {
    vi.stubEnv('DEV', false as never);
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.seamnex.example');
    const { apiBaseUrl } = await loadApiMode();

    expect(apiBaseUrl()).toBe('https://api.seamnex.example');

    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(apiBaseUrl()).toBeUndefined();

    vi.stubEnv('VITE_API_BASE_URL', undefined as never);
    expect(apiBaseUrl()).toBeUndefined();
  });

  it('points the pipeline at the fetch transport, with the configured base', async () => {
    vi.stubEnv('DEV', false as never);
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.seamnex.example');
    const { applySessionTransport } = await loadApiMode();

    applySessionTransport(SESSION);

    expect(client.createFetchTransport).toHaveBeenCalledWith({
      baseUrl: 'https://api.seamnex.example',
    });
    expect(client.configureTransport).toHaveBeenCalledWith({
      kind: 'fetch',
      options: { baseUrl: 'https://api.seamnex.example' },
    });
  });

  it('passes no options when the origin is same-origin', async () => {
    vi.stubEnv('DEV', false as never);
    vi.stubEnv('VITE_API_BASE_URL', '');
    const { applySessionTransport } = await loadApiMode();

    applySessionTransport(SESSION);

    expect(client.createFetchTransport).toHaveBeenCalledWith({});
    expect(client.configureTransport).toHaveBeenCalledWith({ kind: 'fetch', options: {} });
  });
});

describe('bootstrap in a live build', () => {
  it('does not start a mock platform, and reports itself ready immediately', async () => {
    const { mockPlatformReady, prepareMockPlatform } = await import('../../../src/bootstrap');

    await expect(prepareMockPlatform('degraded')).resolves.toBeUndefined();
    // No platform was started, so readiness is the no-op branch rather than a pending install.
    await expect(mockPlatformReady()).resolves.toBeUndefined();
  });
});

describe('applyServerSession', () => {
  it('keeps the URL session when the server answers with no session', async () => {
    client.readServerSession.mockResolvedValue(null);
    const { applyServerSession } = await loadApiMode();

    await expect(applyServerSession(SESSION)).resolves.toEqual(SESSION);
  });

  it('sends an unauthenticated visitor to sign-in with the interrupted path', async () => {
    const location = stubLocation('/catalog?tab=all');
    client.readServerSession.mockResolvedValue(
      serverSession({ authenticated: false, roles: [], subject: null }),
    );
    const { applyServerSession } = await loadApiMode();

    await expect(applyServerSession(SESSION)).resolves.toEqual(SESSION);
    expect(location.replace).toHaveBeenCalledWith('/sign-in?next=%2Fcatalog%3Ftab%3Dall');
  });

  it('keeps a visitor who is already on /sign-in there', async () => {
    const location = stubLocation('/sign-in');
    client.readServerSession.mockResolvedValue(
      serverSession({ authenticated: false, roles: [], subject: null }),
    );
    const { applyServerSession } = await loadApiMode();

    await expect(applyServerSession(SESSION)).resolves.toEqual(SESSION);
    // Redirecting a visitor to the page they are on would be a reload loop.
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('moves a signed-in visitor off /sign-in to the same-origin path they asked for', async () => {
    const location = stubLocation('/sign-in?next=%2Fworkflows');
    client.readServerSession.mockResolvedValue(serverSession());
    const { applyServerSession } = await loadApiMode();

    await applyServerSession(SESSION);

    expect(location.replace).toHaveBeenCalledWith('/workflows');
  });

  it('adopts the role the server asserted and records the provider', async () => {
    stubLocation('/');
    client.readServerSession.mockResolvedValue(serverSession({ roles: ['R1'] }));
    const { applyServerSession } = await loadApiMode();

    await expect(applyServerSession(SESSION)).resolves.toEqual({ ...SESSION, role: 'R1' });
    expect(sessionStorage.getItem('seamnex:asserted-role')).toBe('R1');
    expect(sessionStorage.getItem('seamnex:auth-provider')).toBe('oidc');
  });

  it('does not invent a role when the server asserted none', async () => {
    stubLocation('/');
    client.readServerSession.mockResolvedValue(serverSession({ roles: [] }));
    const { applyServerSession } = await loadApiMode();

    await expect(applyServerSession(SESSION)).resolves.toEqual(SESSION);
    expect(sessionStorage.getItem('seamnex:asserted-role')).toBeNull();
    // The provider is still remembered: the sign-in screen decides what to offer from it.
    expect(sessionStorage.getItem('seamnex:auth-provider')).toBe('oidc');
  });
});
