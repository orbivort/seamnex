import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Domain from '@seamnex/domain';
import type { Capability, PlatformRole } from '@seamnex/domain';
import { apiBaseUrl } from '../../src/api-mode';
import { defaultRouteFor } from '../../src/navigation';

/**
 * Boot-time wiring: the pieces that run before React owns the document and the pure decisions the
 * shell takes from them.
 *
 * Three behaviours here are unreachable from the demo build's happy path, so they are pinned
 * explicitly: readiness before any platform was started, the API origin a production build
 * configures, and the last step of the landing-route fallback chain — no shipped role holds
 * `workflow.view_runs` without an earlier surface, so the ordering is exercised through the policy
 * seam (`can`) rather than through the capability matrix.
 */
const hoisted = vi.hoisted(() => ({
  platform: {
    resetState: vi.fn<(scenario: string) => void>(),
    startMockWorker: vi.fn<() => Promise<void>>(),
  },
  policy: {
    grant: null as null | ((role: PlatformRole, capability: Capability) => boolean),
  },
}));

vi.mock('@seamnex/mocks', () => ({ resetState: hoisted.platform.resetState }));

vi.mock('@seamnex/mocks/browser', () => ({ startMockWorker: hoisted.platform.startMockWorker }));

vi.mock('@seamnex/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof Domain>();
  return {
    ...actual,
    // Delegates to the real matrix unless a test substitutes a policy to walk one branch of
    // `defaultRouteFor` that no shipped role can reach.
    can: (role: PlatformRole, capability: Capability) =>
      hoisted.policy.grant === null
        ? actual.can(role, capability)
        : hoisted.policy.grant(role, capability),
  };
});

beforeEach(() => {
  hoisted.platform.resetState.mockClear();
  hoisted.platform.startMockWorker.mockClear();
  hoisted.platform.startMockWorker.mockResolvedValue(undefined);
});

afterEach(() => {
  hoisted.policy.grant = null;
  vi.unstubAllEnvs();
});

describe('mock platform bootstrap', () => {
  it('reports readiness without installing anything when the entry never started a platform', async () => {
    // A live build ships no mock platform at all, and the gate still awaits readiness: the answer
    // has to be "already ready" rather than a promise that never settles.
    const { mockPlatformReady } = await import('../../src/bootstrap');

    await expect(mockPlatformReady()).resolves.toBeUndefined();
    expect(hoisted.platform.startMockWorker).not.toHaveBeenCalled();
  });

  it('installs the platform once per document even when the effect runs twice', async () => {
    // StrictMode mounts effects twice in development and a second `startMockWorker()` rejects
    // because the worker is already active, so the boot promise is memoised, not the work.
    const { mockPlatformReady, prepareMockPlatform } = await import('../../src/bootstrap');

    const first = prepareMockPlatform('degraded');
    const second = prepareMockPlatform('healthy');
    expect(second).toBe(first);

    await Promise.all([first, second]);

    expect(hoisted.platform.resetState).toHaveBeenCalledTimes(1);
    expect(hoisted.platform.resetState).toHaveBeenCalledWith('degraded');
    expect(hoisted.platform.startMockWorker).toHaveBeenCalledTimes(1);
    await expect(mockPlatformReady()).resolves.toBeUndefined();
  });
});

describe('API origin configuration', () => {
  it('uses the origin a production build configures', () => {
    // A production bundle may point at an absolute origin; the client must pass it through
    // unchanged rather than rewriting it against the document.
    vi.stubEnv('DEV', false as never);
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');

    expect(apiBaseUrl()).toBe('https://api.example.test');
  });

  it('keeps the relative base when the configured origin is empty', () => {
    // An empty value is how the edge deployment says "same origin", so it must not become `''`,
    // which the transport would read as a base URL of nothing.
    vi.stubEnv('DEV', false as never);
    vi.stubEnv('VITE_API_BASE_URL', '');

    expect(apiBaseUrl()).toBeUndefined();
  });

  it('keeps the relative base when no origin is configured at all', () => {
    vi.stubEnv('DEV', false as never);
    vi.stubEnv('VITE_API_BASE_URL', undefined as never);

    expect(apiBaseUrl()).toBeUndefined();
  });

  it('keeps the dev proxy same-origin, where an absolute base would be cross-origin', () => {
    vi.stubEnv('DEV', true as never);
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');

    expect(apiBaseUrl()).toBeUndefined();
  });
});

describe('landing route fallback chain', () => {
  it('lands a role whose only readable surface is the workflow list on workflows', () => {
    // The third step of the chain. No shipped role reaches it (the repository admins and the domain
    // operators all read capacity or instances), so it is pinned through the policy seam: if the
    // matrix ever grants `workflow.view_runs` without an earlier surface, this is the landing route.
    hoisted.policy.grant = (_role, capability) => capability === 'workflow.view_runs';

    expect(defaultRouteFor('R6')).toBe('/workflows');
  });

  it('prefers the capacity board and then the instance list over the workflow list', () => {
    // Order matters as much as reachability: the workflow list must never outrank a surface the
    // role can also read, or the sidebar and the landing route disagree about "first screen".
    hoisted.policy.grant = (_role, capability) => capability !== 'workflow.view_runs';
    expect(defaultRouteFor('R6')).toBe('/');

    hoisted.policy.grant = (_role, capability) => capability === 'instance.view_logs';
    expect(defaultRouteFor('R6')).toBe('/instances');
  });
});
