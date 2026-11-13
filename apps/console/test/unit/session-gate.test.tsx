import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '@seamnex/shell';

/**
 * The gate is what keeps "no request is issued before the platform it talks to is ready" true
 * without blocking first paint: the splash paints immediately, the children mount only once the
 * session has settled, and a boot failure is shown as a problem rather than a blank page.
 */
const mockPlatformReady = vi.fn(() => Promise.resolve());
const resolveSession = vi.fn((session: SessionState) => Promise.resolve(session));

vi.mock('../../src/bootstrap', () => ({
  mockPlatformReady: () => mockPlatformReady(),
  resolveSession: (session: SessionState) => resolveSession(session),
}));

const { SessionGate } = await import('../../src/session-gate');

const session = { role: 'R1', scenario: 'degraded', latencyMs: 0 } as SessionState;

beforeEach(() => {
  mockPlatformReady.mockClear();
  resolveSession.mockClear();
});

describe('session gate', () => {
  it('paints the splash before the platform is ready', () => {
    render(
      <SessionGate initialSession={session} appName="Operator console">
        <p>console ready</p>
      </SessionGate>,
    );

    expect(screen.getByText(/Preparing your session/)).toBeDefined();
    expect(screen.queryByText('console ready')).toBeNull();
  });

  it('renders the application once the session has settled', async () => {
    render(
      <SessionGate initialSession={session} appName="Operator console">
        <p>console ready</p>
      </SessionGate>,
    );

    expect(await screen.findByText('console ready')).toBeDefined();
    expect(mockPlatformReady).toHaveBeenCalledTimes(1);
    expect(resolveSession).toHaveBeenCalledWith(session);
  });

  it('reports a boot failure instead of a blank page', async () => {
    resolveSession.mockRejectedValueOnce(new Error('the session could not be read'));

    render(
      <SessionGate initialSession={session} appName="Operator console">
        <p>console ready</p>
      </SessionGate>,
    );

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('console ready')).toBeNull();
  });
});
