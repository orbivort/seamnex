import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiClient from '@seamnex/api-client';
import type { LogoutResponse } from '@seamnex/domain';
import { SignOutDialog } from '../../src/sign-out';
import { OIDC_AUTH, logoutResponse, residualSession, signedOutSession } from '../fixtures';
import { stubLocation } from '../location';

/**
 * Sign-out is the only way out of an authenticated screen, and its two rules are the ones a copy
 * would lose: the platform never claims knowledge of a product session it has not verified
 * (FR-3.8 / NB-4), and a dialog dismissed after the session ended leaves the application instead of
 * stranding the user on a screen that now answers `401`.
 *
 * `useLogout` is the seam: it is a TanStack mutation, and what this module owns is what it does with
 * its four states, not how the mutation is scheduled.
 */
const logout = vi.hoisted(() => {
  const state = {
    isPending: false,
    isError: false,
    error: null as unknown,
    reset: vi.fn(),
    mutate: vi.fn(),
  };
  return { state };
});

const api = vi.hoisted(() => ({
  fetchSession: vi.fn(),
  providerLogoutUrl: vi.fn(),
  rememberProviderLogout: vi.fn(),
}));

vi.mock('@seamnex/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    useLogout: () => logout.state as unknown as ReturnType<typeof ApiClient.useLogout>,
    ...api,
  };
});

/** A mutation that resolves immediately with `response`, the way a successful sign-out does. */
function succeedWith(response: LogoutResponse): void {
  logout.state.mutate.mockImplementation(
    (_variables: unknown, options?: { onSuccess?: (data: LogoutResponse) => void }) => {
      options?.onSuccess?.(response);
    },
  );
}

beforeEach(() => {
  stubLocation('/');
  logout.state.isPending = false;
  logout.state.isError = false;
  logout.state.error = null;
  logout.state.mutate.mockReset();
  logout.state.reset.mockReset();
  api.fetchSession.mockReset();
  api.providerLogoutUrl.mockReset();
  api.rememberProviderLogout.mockReset();

  api.fetchSession.mockResolvedValue(signedOutSession(OIDC_AUTH));
  api.providerLogoutUrl.mockReturnValue(
    'https://idp.example.test/logout?client_id=seamnex-console',
  );
});

describe('SignOutDialog before the request', () => {
  it('asks before it ends anything', () => {
    const onOpenChange = vi.fn();
    render(<SignOutDialog open onOpenChange={onOpenChange} />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Sign out of the platform?')).toBeDefined();
    expect(
      within(dialog).getByText(/Your identity provider will ask you to confirm/),
    ).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Stay signed in' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Sign out' })).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('holds the dialog while the request is in flight', () => {
    logout.state.isPending = true;
    render(<SignOutDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Signing out…' })).toHaveProperty('disabled', true);
    // Three skeleton lines stand in for the report that has not arrived.
    expect(document.querySelectorAll('.h-3')).toHaveLength(3);
  });

  it('keeps the session when the operator changes their mind', () => {
    const onOpenChange = vi.fn();
    render(<SignOutDialog open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(logout.state.reset).toHaveBeenCalledTimes(1);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('shows a compact problem when the sign-out itself fails', () => {
    logout.state.isError = true;
    logout.state.error = new Error('socket closed');
    render(<SignOutDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText('The platform API could not be reached')).toBeDefined();
    expect(screen.getByText('socket closed')).toBeDefined();
  });
});

describe('SignOutDialog after the request', () => {
  it('reports the residual sessions with the lifetime each was verified for', async () => {
    succeedWith(
      logoutResponse({
        statement: 'Signed out everywhere the platform could reach.',
        residualSessions: [
          residualSession({ instanceId: 'inst-1', product: 'Core CRM', maxRemainingMinutes: 480 }),
        ],
      }),
    );
    render(<SignOutDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Signed out')).toBeDefined();
    expect(screen.getByText('Signed out everywhere the platform could reach.')).toBeDefined();
    expect(screen.getByText('Core CRM')).toBeDefined();
    expect(screen.getByText(/≤ 8 h expected, verified .+/)).toBeDefined();
    // The provider's own session is ended on the next visit even if nobody presses the button.
    await vi.waitFor(() =>
      expect(api.rememberProviderLogout).toHaveBeenCalledWith(
        'https://idp.example.test/logout?client_id=seamnex-console',
      ),
    );
  });

  it('says so when no product session remains', async () => {
    succeedWith(logoutResponse());
    render(<SignOutDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText(/No product sessions/)).toBeDefined();
  });

  it('never invents a lifetime the platform has not verified', async () => {
    succeedWith(
      logoutResponse({
        residualSessions: [
          residualSession({ instanceId: 'inst-2', product: 'Projects', maxRemainingMinutes: null }),
        ],
      }),
    );
    render(<SignOutDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Projects')).toBeDefined();
    expect(screen.getByText('lifetime not verified')).toBeDefined();
  });

  it('prints the estimate without a verification stamp when none was recorded', async () => {
    succeedWith(
      logoutResponse({
        residualSessions: [
          residualSession({
            instanceId: 'inst-3',
            product: 'Wiki',
            maxRemainingMinutes: 90,
            verifiedAt: null,
          }),
        ],
      }),
    );
    render(<SignOutDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('≤ 1 h 30 min expected')).toBeDefined();
  });

  it('remembers nothing when the deployment has no provider logout', async () => {
    api.providerLogoutUrl.mockReturnValue(null);
    succeedWith(logoutResponse());
    render(<SignOutDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await vi.waitFor(() => expect(api.fetchSession).toHaveBeenCalled());
    expect(api.rememberProviderLogout).not.toHaveBeenCalled();
  });

  it('remembers nothing when the session cannot be read', async () => {
    api.fetchSession.mockRejectedValue(new Error('offline'));
    succeedWith(logoutResponse());
    render(<SignOutDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await vi.waitFor(() => expect(api.fetchSession).toHaveBeenCalled());
    expect(api.rememberProviderLogout).not.toHaveBeenCalled();
  });
});

describe('SignOutDialog leaving the application', () => {
  it('goes through the provider logout when the report is acknowledged', async () => {
    succeedWith(logoutResponse());
    render(<SignOutDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));

    await vi.waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        'https://idp.example.test/logout?client_id=seamnex-console',
      ),
    );
  });

  it('leaves through the provider when the dialog is closed instead', async () => {
    succeedWith(logoutResponse());
    render(<SignOutDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Close dialog' }));

    // Dismissing cannot keep the user on a screen whose session is gone.
    await vi.waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        'https://idp.example.test/logout?client_id=seamnex-console',
      ),
    );
  });

  it('falls back to the sign-in route when the provider cannot be read', async () => {
    succeedWith(logoutResponse());
    api.fetchSession.mockRejectedValue(new Error('offline'));
    render(<SignOutDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));

    await vi.waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/sign-in'));
  });

  it('uses the destination the screen supplies', async () => {
    succeedWith(logoutResponse());
    api.fetchSession.mockRejectedValue(new Error('offline'));
    render(<SignOutDialog open onOpenChange={vi.fn()} signedOutPath="/goodbye" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));

    await vi.waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/goodbye'));
  });
});
