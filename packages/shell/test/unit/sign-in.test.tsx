import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiClient from '@seamnex/api-client';
import type { CallbackFailure } from '@seamnex/api-client';
import type { AuthProviderConfig, AuthSession } from '@seamnex/domain';
import { SignInPage } from '../../src/sign-in';
import { OIDC_AUTH, STUB_AUTH, signedInSession, signedOutSession } from '../fixtures';
import { stubLocation } from '../location';

/**
 * The sign-in screen is a state machine over four inputs: the session the API reports, an owed
 * provider logout, a callback in the URL, and the actions the person takes. Each case below drives
 * one edge, because every edge has a different honest answer — and the ones that are *not* taken
 * (a stale response after unmount) must stay inert.
 *
 * Only the network edges are mocked: `toProblem`, `safeNextPath` and the stub exchange keep their
 * real behaviour, so the assertions are about this module rather than about a double of it.
 */
const api = vi.hoisted(() => ({
  takeProviderLogout: vi.fn(),
  fetchSession: vi.fn(),
  beginSignIn: vi.fn(),
  completeSignIn: vi.fn(),
  signInWithStub: vi.fn(),
}));

vi.mock('@seamnex/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return { ...actual, ...api };
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** Renders the screen at `/sign-in` with the given query string. */
function renderSignIn(search = ''): void {
  stubLocation(`/sign-in${search}`);
  render(<SignInPage appName="Operator console" />);
}

beforeEach(() => {
  api.takeProviderLogout.mockReturnValue(null);
  api.fetchSession.mockResolvedValue(signedOutSession(STUB_AUTH));
  api.beginSignIn.mockResolvedValue('https://idp.example.test/auth?state=s1');
  api.completeSignIn.mockResolvedValue({ kind: 'none' });
  api.signInWithStub.mockResolvedValue(signedInSession('R5'));
});

describe('SignInPage provider selection', () => {
  it('honours a provider logout that a closed tab still owes', async () => {
    api.takeProviderLogout.mockReturnValue('https://idp.example.test/logout?client_id=seamnex');

    renderSignIn();

    await vi.waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        'https://idp.example.test/logout?client_id=seamnex',
      ),
    );
    // The provider session is ended before the platform is asked who this is.
    expect(api.fetchSession).not.toHaveBeenCalled();
  });

  it('renders the development identity picker the API describes', async () => {
    renderSignIn('?role=R1');

    expect(await screen.findByText('Development sign-in')).toBeDefined();
    expect(screen.getByText('Development identity')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Sign in to continue' })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Platform administrator/ })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('renders one action for a live provider', async () => {
    api.fetchSession.mockResolvedValue(signedOutSession(OIDC_AUTH));

    renderSignIn();

    expect(await screen.findByRole('button', { name: /Continue with Keycloak/ })).toBeDefined();
    expect(screen.getByText('Single sign-on')).toBeDefined();
    expect(screen.queryByText('Development sign-in')).toBeNull();
  });

  it('hands a completed stub sign-in to the destination resolver', async () => {
    api.signInWithStub.mockResolvedValue(signedInSession('R5'));

    renderSignIn('?next=%2Fdomains');

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    await vi.waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith('/domains?role=R5'),
    );
  });

  it('says a completed sign-out out loud', async () => {
    renderSignIn('?signed-out=1');

    expect(await screen.findByText('Signed out')).toBeDefined();
    expect(screen.getByText(/Your platform session has ended/)).toBeDefined();
  });
});

describe('SignInPage for a visitor who already has a session', () => {
  it('forwards a signed-in stub visitor to their destination with the role', async () => {
    api.fetchSession.mockResolvedValue(signedInSession('R3'));

    renderSignIn('?next=%2Fdomains');

    await vi.waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith('/domains?role=R3'),
    );
  });

  it('forwards a live-provider visitor without a role hint', async () => {
    api.fetchSession.mockResolvedValue(signedInSession('R1', OIDC_AUTH));

    renderSignIn('?next=%2Finstances');

    await vi.waitFor(() => expect(window.location.replace).toHaveBeenCalledWith('/instances'));
  });

  it('omits the role when the stub asserted none', async () => {
    api.fetchSession.mockResolvedValue({ ...signedInSession('R1'), roles: [] });

    renderSignIn('');

    await vi.waitFor(() => expect(window.location.replace).toHaveBeenCalledWith('/'));
  });
});

describe('SignInPage callback exchange', () => {
  it('finishes the exchange and forwards the destination the flow remembered', async () => {
    api.fetchSession.mockResolvedValue(signedOutSession(OIDC_AUTH));
    api.completeSignIn.mockResolvedValue({
      kind: 'signed-in',
      session: signedInSession('R1', OIDC_AUTH),
      next: '/instances',
    });

    renderSignIn('?code=abc&state=s1');

    expect(await screen.findByText('Finishing sign-in')).toBeDefined();
    await vi.waitFor(() => expect(window.location.replace).toHaveBeenCalledWith('/instances'));
    expect(api.completeSignIn).toHaveBeenCalledWith(OIDC_AUTH, '?code=abc&state=s1');
  });

  it('shows the picker when a callback turns out to be an ordinary visit', async () => {
    api.fetchSession.mockResolvedValue(signedOutSession(OIDC_AUTH));
    api.completeSignIn.mockResolvedValue({ kind: 'none' });

    renderSignIn('?code=abc&state=s1');

    expect(await screen.findByRole('button', { name: /Continue with Keycloak/ })).toBeDefined();
    // The "signed out" notice belongs to a sign-out, not to a visit that carried a stale code.
    expect(screen.queryByText('Signed out')).toBeNull();
    expect(window.location.replace).not.toHaveBeenCalled();
  });
});

describe('SignInPage callback failures', () => {
  const cases: ReadonlyArray<
    [CallbackFailure, string, 'retry' | 'switch-account', string, AuthProviderConfig]
  > = [
    ['cancelled', 'Sign-in was cancelled', 'retry', 'Nothing changed.', OIDC_AUTH],
    ['state-mismatch', 'That sign-in response is not valid', 'retry', 'did not request', OIDC_AUTH],
    ['expired', 'This sign-in attempt expired', 'retry', 'Start again', OIDC_AUTH],
    [
      'mfa-required',
      'A second factor is required',
      'retry',
      'before a session can be created',
      OIDC_AUTH,
    ],
    ['no-role', 'That account has no platform role', 'switch-account', 'no-role', STUB_AUTH],
    [
      'provider-unavailable',
      'The identity provider is unreachable',
      'retry',
      'credentials were never evaluated',
      OIDC_AUTH,
    ],
    ['provider-error', 'Sign-in could not be completed', 'retry', 'provider-error', OIDC_AUTH],
  ];

  it.each(cases)(
    'explains a %s failure and offers one way out',
    async (reason, title, recovery, detail, auth) => {
      api.fetchSession.mockResolvedValue(signedOutSession(auth));
      api.completeSignIn.mockResolvedValue({ kind: 'failed', reason, detail });

      renderSignIn('?error=access_denied');

      expect(await screen.findByText(title)).toBeDefined();
      expect(screen.getByText(detail, { exact: false })).toBeDefined();

      const label = recovery === 'retry' ? /Try again/ : /Use a different account/;
      const [button] = screen.getAllByRole('button', { name: label });
      if (button === undefined) throw new Error(`no ${recovery} control rendered`);
      fireEvent.click(button);

      await vi.waitFor(() =>
        expect(api.beginSignIn).toHaveBeenCalledWith(auth, '/', {
          force: recovery === 'switch-account',
        }),
      );
    },
  );

  it('moves focus to the failure so a screen-reader user hears it', async () => {
    api.fetchSession.mockResolvedValue(signedOutSession(OIDC_AUTH));
    api.completeSignIn.mockResolvedValue({
      kind: 'failed',
      reason: 'cancelled',
      detail: 'Nothing changed.',
    });

    renderSignIn('?error=access_denied');

    const alert = await screen.findByRole('alert');
    expect(alert.parentElement).toBe(document.activeElement);
  });
});

describe('SignInPage when the API is unreachable', () => {
  it('says nothing can be decided about the provider and offers a reload', async () => {
    api.fetchSession.mockRejectedValue(new Error('connect ECONNREFUSED'));

    renderSignIn();

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.getByText('connect ECONNREFUSED')).toBeDefined();
    // Nothing is known about the provider, so the badge must not claim single sign-on.
    expect(screen.getByText('Development identity')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });
});

describe('SignInPage leaving for the provider', () => {
  it('reports the wait and navigates once the authorization URL exists', async () => {
    api.fetchSession.mockResolvedValue(signedOutSession(OIDC_AUTH));

    renderSignIn();

    fireEvent.click(await screen.findByRole('button', { name: /Continue with Keycloak/ }));

    expect(await screen.findByText('Taking you to your provider')).toBeDefined();
    expect(screen.getByText('Waiting for your identity provider…')).toBeDefined();
    await vi.waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith('https://idp.example.test/auth?state=s1'),
    );
    expect(api.beginSignIn).toHaveBeenCalledWith(OIDC_AUTH, '/', { force: false });
  });

  it('stays put when the provider needs no round trip', async () => {
    api.fetchSession.mockResolvedValue(signedOutSession(OIDC_AUTH));
    api.beginSignIn.mockResolvedValue(null);

    renderSignIn();

    fireEvent.click(await screen.findByRole('button', { name: /Continue with Keycloak/ }));

    await vi.waitFor(() => expect(api.beginSignIn).toHaveBeenCalledTimes(1));
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Continue with Keycloak/ })).toBeDefined();
  });

  it('asks the provider to re-authenticate for a different account', async () => {
    api.fetchSession.mockResolvedValue(signedOutSession(OIDC_AUTH));

    renderSignIn();

    fireEvent.click(await screen.findByRole('button', { name: 'Use a different account' }));

    await vi.waitFor(() =>
      expect(api.beginSignIn).toHaveBeenCalledWith(OIDC_AUTH, '/', { force: true }),
    );
  });
});

describe('SignInPage after unmount', () => {
  it('ignores a session that arrives late', async () => {
    const session = deferred<AuthSession>();
    api.fetchSession.mockReturnValue(session.promise);

    stubLocation('/sign-in');
    const { unmount } = render(<SignInPage appName="Operator console" />);
    unmount();

    session.resolve(signedOutSession(OIDC_AUTH));

    await vi.waitFor(() => expect(api.fetchSession).toHaveBeenCalledTimes(1));
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('ignores a transport failure that arrives late', async () => {
    const session = deferred<AuthSession>();
    api.fetchSession.mockReturnValue(session.promise);

    stubLocation('/sign-in');
    const { unmount } = render(<SignInPage appName="Operator console" />);
    unmount();

    session.reject(new Error('late failure'));

    await vi.waitFor(() => expect(api.fetchSession).toHaveBeenCalledTimes(1));
  });

  it('ignores a callback outcome that arrives late', async () => {
    const outcome = deferred<ApiClient.CallbackOutcome>();
    api.fetchSession.mockResolvedValue(signedOutSession(OIDC_AUTH));
    api.completeSignIn.mockReturnValue(outcome.promise);

    stubLocation('/sign-in?code=abc&state=s1');
    const { unmount } = render(<SignInPage appName="Operator console" />);
    await vi.waitFor(() => expect(api.completeSignIn).toHaveBeenCalledTimes(1));
    unmount();

    outcome.resolve({
      kind: 'signed-in',
      session: signedInSession('R1', OIDC_AUTH),
      next: '/instances',
    });

    await vi.waitFor(() => expect(window.location.replace).not.toHaveBeenCalled());
  });
});
