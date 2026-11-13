import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '@seamnex/shell';
import { SessionGate } from '../../src/session-gate';

/**
 * The gate is the one screen that runs before the app: it decides between the splash, the boot
 * failure and the tree. The two boot steps are replaced so each outcome can be produced without a
 * real worker or a server session.
 */
const bootstrap = vi.hoisted(() => ({
  mockPlatformReady: vi.fn(async (): Promise<void> => undefined),
  resolveSession: vi.fn(async (session: SessionState): Promise<SessionState> => session),
}));

vi.mock('../../src/bootstrap', () => bootstrap);

const SESSION: SessionState = { role: 'R5', scenario: 'degraded', latencyMs: 0 };

async function renderGate(): Promise<void> {
  render(
    <SessionGate initialSession={SESSION} appName="Customer portal">
      <p>application mounted</p>
    </SessionGate>,
  );
}

describe('SessionGate', () => {
  it('paints the splash first and mounts the app once both boot steps settle', async () => {
    bootstrap.mockPlatformReady.mockResolvedValue(undefined);
    bootstrap.resolveSession.mockResolvedValue(SESSION);

    await renderGate();

    expect(screen.getByText(/Preparing your session/)).toBeDefined();
    expect(await screen.findByText('application mounted')).toBeDefined();
    expect(bootstrap.mockPlatformReady).toHaveBeenCalledTimes(1);
    expect(bootstrap.resolveSession).toHaveBeenCalledWith(SESSION);
  });

  it('shows the problem surface when a boot step rejects', async () => {
    bootstrap.mockPlatformReady.mockResolvedValue(undefined);
    bootstrap.resolveSession.mockRejectedValue(new Error('the session endpoint is offline'));

    await renderGate();

    expect(await screen.findByText(/could not be reached/i)).toBeDefined();
    expect(screen.getByText(/the session endpoint is offline/)).toBeDefined();
    expect(screen.queryByText('application mounted')).toBeNull();

    // Retry reloads the document: the boot work is not repeatable inside a broken React tree.
    // jsdom logs the navigation it cannot perform, which is enough to prove the handler ran.
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(bootstrap.resolveSession).toHaveBeenCalledTimes(1);
  });

  it('does not update state after the gate has been unmounted', async () => {
    let settle: (session: SessionState) => void = () => undefined;
    bootstrap.mockPlatformReady.mockResolvedValue(undefined);
    bootstrap.resolveSession.mockImplementation(
      () =>
        new Promise<SessionState>((resolve) => {
          settle = resolve;
        }),
    );

    const { unmount } = render(
      <SessionGate initialSession={SESSION} appName="Customer portal">
        <p>application mounted</p>
      </SessionGate>,
    );
    await waitFor(() => expect(bootstrap.resolveSession).toHaveBeenCalledTimes(1));

    unmount();
    settle(SESSION);
    // The cleanup set `active` to false, so neither branch of the try/catch may write state.
    await Promise.resolve();
    expect(screen.queryByText('application mounted')).toBeNull();
  });

  it('swallows a rejection that arrives after unmount', async () => {
    let fail: (error: Error) => void = () => undefined;
    bootstrap.mockPlatformReady.mockResolvedValue(undefined);
    bootstrap.resolveSession.mockImplementation(
      () =>
        new Promise<SessionState>((_resolve, reject) => {
          fail = reject;
        }),
    );

    const { unmount } = render(
      <SessionGate initialSession={SESSION} appName="Customer portal">
        <p>application mounted</p>
      </SessionGate>,
    );
    await waitFor(() => expect(bootstrap.resolveSession).toHaveBeenCalledTimes(1));

    unmount();
    fail(new Error('too late'));
    await Promise.resolve();
    expect(screen.queryByText(/too late/)).toBeNull();
  });

  it('does not mount the app when the mock platform itself fails to start', async () => {
    bootstrap.mockPlatformReady.mockRejectedValue(new Error('service worker refused'));
    bootstrap.resolveSession.mockResolvedValue(SESSION);

    await renderGate();

    expect(await screen.findByText(/service worker refused/)).toBeDefined();
    // The session read is ordered after the platform, so it never ran.
    expect(bootstrap.resolveSession).not.toHaveBeenCalled();
  });
});
