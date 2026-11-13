import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createSessionKit,
  isPlatformRole,
  isScenario,
  readSessionFromUrl,
  type SessionKit,
  type SessionKitOptions,
  type SessionState,
} from '../../src/session';
import { setLocationUrl, stubLocation } from '../location';

/**
 * The session kit is the only module in this package that reads the URL, and it reads it from two
 * places on purpose: a module-scope snapshot before React exists (the transports are built from it)
 * and a live subscription afterwards (a bookmark, a back step, a router push). The cases below
 * pin both, plus the guard that keeps an in-app change from being undone by the URL that produced
 * it.
 */
type OnChangeSpy = Mock<(session: SessionState) => void>;

type KitOptions = Partial<Omit<SessionKitOptions, 'onChange'>> & {
  onChange?: OnChangeSpy;
};

function buildKit(overrides: KitOptions = {}): {
  kit: SessionKit;
  onChange: OnChangeSpy;
} {
  const onChange = overrides.onChange ?? vi.fn<(session: SessionState) => void>();
  return {
    kit: createSessionKit({
      defaultRole: 'R5',
      defaultLatencyMs: 180,
      ...overrides,
      onChange,
    }),
    onChange,
  };
}

function Probe({ kit }: { kit: SessionKit }) {
  const { session, setRole, setScenario, setLatency } = kit.useSession();
  return (
    <div>
      <p data-testid="session">{`${session.role}|${session.scenario}|${session.latencyMs}`}</p>
      <button type="button" onClick={() => setRole('R1')}>
        set role
      </button>
      <button type="button" onClick={() => setScenario('maintenance')}>
        set scenario
      </button>
      <button type="button" onClick={() => setLatency(0)}>
        set latency
      </button>
    </div>
  );
}

function Orphan({ kit }: { kit: SessionKit }) {
  kit.useSession();
  return <p>unreachable</p>;
}

describe('isPlatformRole', () => {
  it('accepts a declared role and refuses everything else', () => {
    expect(isPlatformRole('R1')).toBe(true);
    expect(isPlatformRole('R6')).toBe(true);
    expect(isPlatformRole('R7')).toBe(false);
    expect(isPlatformRole('')).toBe(false);
    expect(isPlatformRole(null)).toBe(false);
  });
});

describe('isScenario', () => {
  it('accepts a declared scenario and refuses everything else', () => {
    expect(isScenario('healthy')).toBe(true);
    expect(isScenario('offline')).toBe(true);
    expect(isScenario('chaos')).toBe(false);
    expect(isScenario(null)).toBe(false);
  });
});

describe('readSessionFromUrl', () => {
  it('falls back to the kit defaults when the URL carries no parameters', () => {
    stubLocation('/dashboard');

    expect(readSessionFromUrl({ defaultRole: 'R3', defaultLatencyMs: 180 })).toEqual({
      role: 'R3',
      scenario: 'degraded',
      latencyMs: 180,
    });
  });

  it('reads role, scenario and latency from the query string', () => {
    stubLocation('/dashboard?role=R2&scenario=empty&latency=750');

    expect(readSessionFromUrl({ defaultRole: 'R5', defaultLatencyMs: 0 })).toEqual({
      role: 'R2',
      scenario: 'empty',
      latencyMs: 750,
    });
  });

  it('ignores an undeclared role and scenario instead of trusting them', () => {
    stubLocation('/?role=R9&scenario=chaos&latency=soon');

    expect(readSessionFromUrl({ defaultRole: 'R5', defaultLatencyMs: 180 })).toEqual({
      role: 'R5',
      scenario: 'degraded',
      latencyMs: 180,
    });
  });

  it('clamps a negative latency to zero and a huge one to two seconds', () => {
    stubLocation('/?latency=-250');
    expect(readSessionFromUrl({ defaultRole: 'R5', defaultLatencyMs: 180 }).latencyMs).toBe(0);

    setLocationUrl('/?latency=99999');
    expect(readSessionFromUrl({ defaultRole: 'R5', defaultLatencyMs: 180 }).latencyMs).toBe(2_000);
  });

  it('lets an asserted role beat the query-string hint', () => {
    stubLocation('/?role=R3');

    expect(
      readSessionFromUrl({
        defaultRole: 'R5',
        defaultLatencyMs: 180,
        assertedRole: () => 'R1',
      }).role,
    ).toBe('R1');
  });

  it('keeps the hint when the server asserted nothing', () => {
    stubLocation('/?role=R3');

    expect(
      readSessionFromUrl({
        defaultRole: 'R5',
        defaultLatencyMs: 180,
        assertedRole: () => null,
      }).role,
    ).toBe('R3');
  });
});

describe('createSessionKit', () => {
  it('starts the provider from the URL and renders its children', () => {
    stubLocation('/?role=R3&scenario=empty&latency=300');
    const { kit } = buildKit();

    render(
      <kit.SessionProvider>
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    expect(screen.getByTestId('session').textContent).toBe('R3|empty|300');
  });

  it('refuses to read the session outside its provider', () => {
    const { kit } = buildKit();

    expect(() => renderToString(<Orphan kit={kit} />)).toThrow(
      'useSession must be used inside SessionProvider',
    );
  });

  it('prefers the router’s search over the platform location', () => {
    stubLocation('/?role=R5');
    const { kit, onChange } = buildKit();

    const { rerender } = render(
      <kit.SessionProvider search="?role=R1&latency=0">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );
    // The first search is already folded into the initial state, so nothing is re-applied.
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <kit.SessionProvider search="?role=R2&scenario=empty&latency=50">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    expect(screen.getByTestId('session').textContent).toBe('R2|empty|50');
    expect(onChange).toHaveBeenCalledWith({ role: 'R2', scenario: 'empty', latencyMs: 50 });
  });

  it('does not re-apply a search string it has already folded in', () => {
    stubLocation('/?role=R2&latency=50');
    const { kit, onChange } = buildKit();
    const { rerender } = render(
      <kit.SessionProvider search="?role=R2&latency=50">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    rerender(
      <kit.SessionProvider search="?role=R2&latency=50">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );
    expect(onChange).not.toHaveBeenCalled();

    // A different search whose parameters all match the current session is a no-op as well.
    rerender(
      <kit.SessionProvider search="?role=R2&scenario=degraded&latency=50">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('session').textContent).toBe('R2|degraded|50');
  });

  it('applies only the parameters a navigation mentions', () => {
    stubLocation('/?role=R1&scenario=empty&latency=400');
    const { kit, onChange } = buildKit();
    const { rerender } = render(
      <kit.SessionProvider search="?role=R1&scenario=empty&latency=400">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    rerender(
      <kit.SessionProvider search="?latency=900">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    expect(screen.getByTestId('session').textContent).toBe('R1|empty|900');
    expect(onChange).toHaveBeenCalledWith({ role: 'R1', scenario: 'empty', latencyMs: 900 });
  });

  it('keeps the asserted role through a URL change', () => {
    stubLocation('/?role=R5&latency=0');
    const { kit, onChange } = buildKit({ assertedRole: () => 'R1' });
    const { rerender } = render(
      <kit.SessionProvider search="?role=R5&latency=0">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );
    expect(screen.getByTestId('session').textContent).toBe('R1|degraded|0');

    rerender(
      <kit.SessionProvider search="?role=R3&scenario=healthy&latency=10">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    // `?role=R3` is a hint from a client that may already be signed in as someone else.
    expect(screen.getByTestId('session').textContent).toBe('R1|healthy|10');
    expect(onChange).toHaveBeenCalledWith({ role: 'R1', scenario: 'healthy', latencyMs: 10 });
  });

  it('works without an onChange callback', () => {
    stubLocation('/');
    const kit = createSessionKit({ defaultRole: 'R5', defaultLatencyMs: 0 });
    const { rerender } = render(
      <kit.SessionProvider search="?role=R1">
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    expect(() =>
      rerender(
        <kit.SessionProvider search="?role=R2">
          <Probe kit={kit} />
        </kit.SessionProvider>,
      ),
    ).not.toThrow();
    expect(screen.getByTestId('session').textContent).toBe('R2|degraded|0');
  });

  it('follows a back/forward step through the platform location', () => {
    stubLocation('/?role=R3&latency=0');
    const { kit } = buildKit();
    render(
      <kit.SessionProvider>
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );
    expect(screen.getByTestId('session').textContent).toBe('R3|degraded|0');

    act(() => {
      setLocationUrl('/?role=R1&scenario=maintenance&latency=250');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(screen.getByTestId('session').textContent).toBe('R1|maintenance|250');
  });

  it('follows a router navigation, which emits no event of its own', async () => {
    stubLocation('/?role=R3&latency=0');
    const { kit } = buildKit();
    render(
      <kit.SessionProvider>
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    await act(async () => {
      setLocationUrl('/?role=R2&latency=0');
      window.history.pushState({}, '', '/?role=R2&latency=0');
      // `pushState` dispatches the kit's event from a microtask; await one turn of the loop.
      await Promise.resolve();
    });

    expect(screen.getByTestId('session').textContent).toBe('R2|degraded|0');
  });

  it('stops listening once the provider unmounts', () => {
    stubLocation('/?role=R3&latency=0');
    const { kit } = buildKit();
    const { unmount } = render(
      <kit.SessionProvider>
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    unmount();

    expect(() => {
      setLocationUrl('/?role=R1');
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new Event('seamnex:locationchange'));
    }).not.toThrow();
  });

  it('sends a role switch through the sign-in screen', () => {
    stubLocation('/dashboard?role=R3&tab=2');
    const { kit } = buildKit();
    render(
      <kit.SessionProvider>
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    act(() => screen.getByRole('button', { name: 'set role' }).click());

    expect(window.location.assign).toHaveBeenCalledWith(
      `/sign-in?role=R1&next=${encodeURIComponent('/dashboard?tab=2')}`,
    );
  });

  it('reloads with the chosen scenario and keeps the rest of the URL', () => {
    stubLocation('/dashboard?role=R3&latency=0');
    const { kit } = buildKit();
    render(
      <kit.SessionProvider>
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    act(() => screen.getByRole('button', { name: 'set scenario' }).click());

    expect(window.location.assign).toHaveBeenCalledWith(
      'http://localhost/dashboard?role=R3&latency=0&scenario=maintenance',
    );
  });

  it('changes the latency in place and reports it before re-rendering', () => {
    stubLocation('/?role=R3&latency=300');
    const { kit, onChange } = buildKit();
    render(
      <kit.SessionProvider>
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    act(() => screen.getByRole('button', { name: 'set latency' }).click());
    expect(onChange).toHaveBeenLastCalledWith({ role: 'R3', scenario: 'degraded', latencyMs: 0 });
    expect(screen.getByTestId('session').textContent).toBe('R3|degraded|0');

    // Setting the value it already holds is a no-op for state but still reaches the transport.
    act(() => screen.getByRole('button', { name: 'set latency' }).click());
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('session').textContent).toBe('R3|degraded|0');
  });

  it('reads the session on the server without touching the platform location', () => {
    stubLocation('/?role=R1&latency=0');
    const { kit } = buildKit();

    const html = renderToString(
      <kit.SessionProvider>
        <Probe kit={kit} />
      </kit.SessionProvider>,
    );

    expect(html).toContain('R1|degraded|0');
  });
});
