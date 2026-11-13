import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@seamnex/domain';
import type { SessionState } from '@seamnex/shell';
import type * as ApiClient from '@seamnex/api-client';

/**
 * `api-mode` under a build with the mock platform switched **off**.
 *
 * This file runs in the `portal-live` project, whose Vite `define` sets `__SEAMNEX_MOCKS__` to `false`.
 * The other project cannot reach these branches: in a test build the flag is a literal `true`, so
 * the live transport and the server-session routing are dead code there. The Vite config's
 * `production` alias is *not* applied, so the real `@seamnex/api-client` (and MSW) stay available.
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
    subject: { id: 'usr-sofia', username: 'sofia.almeida', displayName: 'Sofia Almeida' },
    roles: ['R1'],
    groups: ['platform-admins'],
    mfaSatisfied: true,
    mfaMethod: 'webauthn',
    csrfToken: null,
    createdAt: null,
    expiresAt: null,
    idleExpiresAt: null,
    auth: { provider: 'oidc' },
    ...overrides,
  } as AuthSession;
}

async function loadApiMode() {
  return import('../../../src/api-mode');
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  sessionStorage.clear();
  client.configureTransport.mockClear();
  client.createFetchTransport.mockClear();
  client.readServerSession.mockReset();
});

afterEach(() => {
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

  it('keeps a relative base in development', async () => {
    const { apiBaseUrl } = await loadApiMode();

    expect(apiBaseUrl()).toBeUndefined();
  });

  it('uses a configured origin outside development, ignoring an empty value', async () => {
    vi.stubEnv('DEV', false);
    const { apiBaseUrl } = await loadApiMode();

    vi.stubEnv('VITE_API_BASE_URL', 'https://api.seamnex.example');
    expect(apiBaseUrl()).toBe('https://api.seamnex.example');

    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(apiBaseUrl()).toBeUndefined();
  });

  it('points the pipeline at the fetch transport, with the configured base', async () => {
    vi.stubEnv('DEV', false);
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
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_BASE_URL', '');
    const { applySessionTransport } = await loadApiMode();

    applySessionTransport(SESSION);

    expect(client.createFetchTransport).toHaveBeenCalledWith({});
  });
});

describe('bootstrap in a live build', () => {
  it('does not start a mock platform, and reports itself ready immediately', async () => {
    const { mockPlatformReady, prepareMockPlatform } = await import('../../../src/bootstrap');

    await expect(prepareMockPlatform('degraded')).resolves.toBeUndefined();
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
    window.history.replaceState({}, '', '/entitlements?tab=all');
    client.readServerSession.mockResolvedValue(
      serverSession({ authenticated: false, roles: [], subject: null }),
    );
    const { applyServerSession } = await loadApiMode();

    await expect(applyServerSession(SESSION)).resolves.toEqual(SESSION);
  });

  it('keeps a visitor who is already on /sign-in there', async () => {
    window.history.replaceState({}, '', '/sign-in');
    client.readServerSession.mockResolvedValue(
      serverSession({ authenticated: false, roles: [], subject: null }),
    );
    const { applyServerSession } = await loadApiMode();

    await expect(applyServerSession(SESSION)).resolves.toEqual(SESSION);
  });

  it('adopts the role the server asserted and records the provider', async () => {
    window.history.replaceState({}, '', '/');
    client.readServerSession.mockResolvedValue(serverSession({ roles: ['R1'] }));
    const { applyServerSession } = await loadApiMode();

    await expect(applyServerSession(SESSION)).resolves.toEqual({ ...SESSION, role: 'R1' });
    expect(sessionStorage.getItem('seamnex:asserted-role')).toBe('R1');
    expect(sessionStorage.getItem('seamnex:auth-provider')).toBe('oidc');
  });

  it('does not invent a role when the server asserted none', async () => {
    window.history.replaceState({}, '', '/');
    client.readServerSession.mockResolvedValue(serverSession({ roles: [] }));
    const { applyServerSession } = await loadApiMode();

    await expect(applyServerSession(SESSION)).resolves.toEqual(SESSION);
    expect(sessionStorage.getItem('seamnex:asserted-role')).toBeNull();
    expect(sessionStorage.getItem('seamnex:auth-provider')).toBe('oidc');
  });
});
