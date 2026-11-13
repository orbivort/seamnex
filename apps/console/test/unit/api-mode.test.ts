import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '@seamnex/shell';
import { apiBaseUrl, apiMode, applySessionTransport, mocksEnabled } from '../../src/api-mode';

/**
 * The mode seam as the test build sees it: the mock platform is compiled in, so `mocksEnabled` is a
 * literal `true` and the transport is the prototype adapter.
 *
 * The other half of the seam cannot be reached from here — `__SEAMNEX_MOCKS__` is a build-time constant,
 * so the live transport and the server-session routing are dead code in this module graph. They are
 * covered where they are reachable: the `console-live` project
 * (`test/integration/live/api-mode.live.test.ts`) with the flag set to `false`.
 */
const session: SessionState = { role: 'R1', scenario: 'degraded', latencyMs: 120 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('api mode', () => {
  it('reports the mock platform while it is compiled in', () => {
    expect(mocksEnabled).toBe(true);
    expect(apiMode).toBe('mock');
  });

  it('keeps a relative base in development so the proxy stays same-origin', () => {
    vi.stubEnv('DEV', true as never);
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
    expect(apiBaseUrl()).toBeUndefined();
  });

  it('points the pipeline at the mock adapter for the current session', () => {
    expect(() => applySessionTransport(session)).not.toThrow();
    expect(() => applySessionTransport({ ...session, role: 'R4', latencyMs: 0 })).not.toThrow();
  });

  it('accepts the session it will transport on every role', () => {
    for (const role of ['R1', 'R2', 'R3', 'R4'] as const) {
      expect(() => applySessionTransport({ ...session, role })).not.toThrow();
    }
  });
});
