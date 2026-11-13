import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberAuthProvider } from '@seamnex/api-client';
import type { PlatformRole } from '@seamnex/domain';
import type { SessionState } from '@seamnex/shell';
import {
  ConsoleLatencySwitcher,
  ConsoleRoleSwitcher,
  ConsoleScenarioSwitcher,
  SessionProvider,
  useSession,
} from '../../src/session';
import { SessionGate } from '../../src/session-gate';

/**
 * The session surface has two shapes that the shipped test suite never reaches, because the mock
 * platform is compiled in: the *live* chrome (a build talking to the real API) and the failure
 * paths of the boot gate. Both are the seams a production build depends on, so they are pinned
 * here rather than left to the demo build's happy path.
 *
 * `../src/api-mode` is mocked with a mutable flag rather than restated: `mocksEnabled` is the one
 * switch the components read, and flipping it is the only way to render the live chrome at all.
 * `assertedRole` stays defined, so the session kit is built in its live configuration too.
 */
const hoisted = vi.hoisted(() => {
  // The kit captures the `assertedRole` *function* when it is constructed, so the seam a test can
  // move is the role it returns, not the function itself.
  const asserted: { role: PlatformRole | null } = { role: null };
  return {
    asserted,
    apiMode: {
      mocksEnabled: false,
      assertedRole: (() => asserted.role) as (() => PlatformRole | null) | undefined,
      applySessionTransport: vi.fn<(session: SessionState) => void>(),
    },
    gate: {
      platformReady: vi.fn<() => Promise<void>>(),
      resolveSession: vi.fn<(session: SessionState) => Promise<SessionState>>(),
    },
  };
});

vi.mock('../../src/api-mode', () => hoisted.apiMode);

vi.mock('../../src/bootstrap', () => ({
  mockPlatformReady: () => hoisted.gate.platformReady(),
  resolveSession: (session: SessionState) => hoisted.gate.resolveSession(session),
}));

const nativeLocation = Object.getOwnPropertyDescriptor(window, 'location');

type LocationStub = {
  href: string;
  pathname: string;
  search: string;
  assign: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
};

/** jsdom's `location` is configurable, so the navigation calls can be observed instead of thrown. */
function stubLocation(href = 'http://localhost/'): LocationStub {
  const url = new URL(href);
  const stub: LocationStub = {
    href: url.toString(),
    pathname: url.pathname,
    search: url.search,
    assign: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
  };
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: stub });
  return stub;
}

const session: SessionState = { role: 'R1', scenario: 'degraded', latencyMs: 0 };

function SessionProbe() {
  const { session: current } = useSession();
  return (
    <p>
      {current.role} · {current.scenario} · {current.latencyMs} ms
    </p>
  );
}

/** Mounts the console's provider the way `app.tsx` does: inside a router, reading its search. */
function renderSession({ path = '/', search = '' } = {}) {
  const location = stubLocation(`http://localhost${path}${search}`);
  window.history.replaceState({}, '', `${path}${search}`);
  render(
    <MemoryRouter initialEntries={[`${path}${search}`]}>
      <SessionProvider>
        <SessionProbe />
        <ConsoleRoleSwitcher />
        <ConsoleScenarioSwitcher />
        <ConsoleLatencySwitcher />
      </SessionProvider>
    </MemoryRouter>,
  );
  return location;
}

beforeEach(() => {
  sessionStorage.removeItem('seamnex:auth-provider');
  hoisted.apiMode.mocksEnabled = false;
  hoisted.asserted.role = null;
  hoisted.apiMode.applySessionTransport.mockClear();
  hoisted.gate.platformReady.mockReset();
  hoisted.gate.resolveSession.mockReset();
  hoisted.gate.platformReady.mockResolvedValue(undefined);
  hoisted.gate.resolveSession.mockImplementation((current: SessionState) =>
    Promise.resolve(current),
  );
});

afterEach(() => {
  if (nativeLocation !== undefined) Object.defineProperty(window, 'location', nativeLocation);
  window.history.replaceState({}, '', '/');
  sessionStorage.removeItem('seamnex:auth-provider');
});

describe('session controls against a live API', () => {
  it('hides the role picker once a real identity provider decides the role', () => {
    // The picker navigates to `/sign-in?role=…`; against OIDC that only starts another login, so a
    // control that cannot do what it says is removed rather than left in place.
    rememberAuthProvider('oidc');
    renderSession({ search: '?role=R2&latency=0' });

    expect(screen.queryByLabelText(/role/i)).toBeNull();
    expect(screen.getByText('R2 · degraded · 0 ms')).toBeDefined();
  });

  it('names the role picker for the development override it has become', () => {
    // With the stub provider the picker keeps working, but it is no longer a prototype control and
    // must not claim to be one.
    rememberAuthProvider('stub');
    renderSession({ search: '?role=R2' });

    const picker = screen.getByLabelText(/Development role override/) as HTMLSelectElement;
    expect(picker.value).toBe('R2');
    expect(screen.queryByLabelText(/^Prototype role/)).toBeNull();
  });

  it('takes the role the server asserted over the one the URL claims', () => {
    // In live mode `?role=` is a client-supplied claim: a hand-edited URL must not render the
    // administrator's navigation for a member.
    rememberAuthProvider('stub');
    hoisted.asserted.role = 'R4';
    renderSession({ search: '?role=R1&latency=0' });

    const picker = screen.getByLabelText(/Development role override/) as HTMLSelectElement;
    expect(picker.value).toBe('R4');
    expect(screen.getByText('R4 · degraded · 0 ms')).toBeDefined();
  });

  it('leaves for the sign-in screen carrying the interrupted path', () => {
    rememberAuthProvider('stub');
    const location = renderSession({ path: '/catalog', search: '?role=R5&scenario=offline' });

    fireEvent.change(screen.getByLabelText(/Development role override/), {
      target: { value: 'R3' },
    });

    // The role claim is dropped from the interrupted path: the sign-in screen asserts the role.
    expect(location.assign).toHaveBeenCalledWith(
      '/sign-in?role=R3&next=%2Fcatalog%3Fscenario%3Doffline',
    );
  });

  it('ignores a role the platform does not define', () => {
    rememberAuthProvider('stub');
    const location = renderSession({ search: '?role=R2' });

    fireEvent.change(screen.getByLabelText(/Development role override/), {
      target: { value: 'not-a-role' },
    });

    expect(location.assign).not.toHaveBeenCalled();
  });

  it('offers no simulated latency against a live backend', () => {
    renderSession();

    expect(screen.queryByLabelText(/Simulated network latency/)).toBeNull();
  });

  it('offers no prototype scenario against a live backend', () => {
    renderSession();

    expect(screen.queryByLabelText(/Prototype scenario/)).toBeNull();
  });
});

describe('session controls against the mock platform', () => {
  beforeEach(() => {
    hoisted.apiMode.mocksEnabled = true;
  });

  it('marks the role picker as a prototype control', () => {
    renderSession({ search: '?role=R3' });

    const picker = screen.getByLabelText(/Prototype role/) as HTMLSelectElement;
    expect(picker.value).toBe('R3');
    expect(screen.queryByLabelText(/Development role override/)).toBeNull();
  });

  it('applies the latency the operator picks to the session and its transport', () => {
    renderSession({ search: '?latency=0' });

    fireEvent.change(screen.getByLabelText(/Simulated network latency/), {
      target: { value: '400' },
    });

    expect(screen.getByText('R1 · degraded · 400 ms')).toBeDefined();
    // The transport is rebuilt before React re-renders, so the next request already waits 400 ms.
    expect(hoisted.apiMode.applySessionTransport).toHaveBeenLastCalledWith({
      role: 'R1',
      scenario: 'degraded',
      latencyMs: 400,
    });
  });

  it('reloads the platform on the scenario the operator picks', () => {
    // A scenario reseeds the mock platform, so there is nothing to re-render: the page is rebuilt.
    const location = renderSession({ path: '/catalog', search: '?latency=0' });

    fireEvent.change(screen.getByLabelText(/Prototype scenario/), {
      target: { value: 'healthy' },
    });

    expect(location.assign).toHaveBeenCalledTimes(1);
    expect(location.assign.mock.calls[0]?.[0]).toContain('scenario=healthy');
  });

  it('ignores a scenario the platform does not define', () => {
    const location = renderSession({ search: '?latency=0' });

    fireEvent.change(screen.getByLabelText(/Prototype scenario/), {
      target: { value: 'not-a-scenario' },
    });

    expect(location.assign).not.toHaveBeenCalled();
  });
});

describe('session gate', () => {
  it('restarts the boot when the operator retries a failed start', async () => {
    // A boot failure has to be recoverable from the screen itself: the splash is gone by then, so
    // the retry is the only way back without editing the address bar.
    const location = stubLocation();
    hoisted.gate.resolveSession.mockRejectedValue(new Error('the session could not be read'));

    render(
      <SessionGate initialSession={session} appName="Operator console">
        <p>console ready</p>
      </SessionGate>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('console ready')).toBeNull();
  });

  it('does not resurrect a gate the operator left while the session was settling', async () => {
    // The effect's `active` flag exists for this: a navigation that replaces the gate mid-boot
    // must not paint the application into a tree that is already gone.
    let settle: (() => void) | undefined;
    hoisted.gate.platformReady.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    stubLocation();

    const view = render(
      <SessionGate initialSession={session} appName="Operator console">
        <p>console ready</p>
      </SessionGate>,
    );
    expect(screen.getByText(/Preparing your session/)).toBeDefined();

    view.unmount();
    settle?.();
    await waitFor(() => expect(hoisted.gate.resolveSession).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(document.body.textContent).toBe('');
  });

  it('does not show a boot failure for a gate the operator already left', async () => {
    // Same guard on the rejection path: a late failure must not mount the error panel.
    let fail: ((error: unknown) => void) | undefined;
    hoisted.gate.platformReady.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    stubLocation();

    const view = render(
      <SessionGate initialSession={session} appName="Operator console">
        <p>console ready</p>
      </SessionGate>,
    );

    view.unmount();
    fail?.(new Error('the platform never started'));
    await waitFor(() => expect(hoisted.gate.resolveSession).not.toHaveBeenCalled());
    await Promise.resolve();

    expect(document.body.textContent).toBe('');
  });
});
