import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConsoleLatencySwitcher,
  ConsoleRoleSwitcher,
  ConsoleScenarioSwitcher,
  SessionProvider,
  readSession,
  useSession,
} from '../../src/session';

/**
 * The session is URL-derived in the prototype: the role, the scenario and the simulated latency
 * all come from the query string. `readSession` is the single reader; the switchers are navigation
 * controls (a role switch walks the sign-in screen, a scenario switch reloads the platform), which
 * is why they are asserted for what they offer rather than for a state change jsdom cannot perform.
 */
function Probe() {
  const { session } = useSession();
  return (
    <p>
      {session.role} · {session.scenario} · {session.latencyMs} ms
    </p>
  );
}

function renderWithSession(search = '') {
  window.history.replaceState({}, '', `/${search}`);
  return render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <SessionProvider>
        <Probe />
        <ConsoleRoleSwitcher />
        <ConsoleScenarioSwitcher />
        <ConsoleLatencySwitcher />
      </SessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('session reading', () => {
  it('defaults to the platform administrator with no query string', () => {
    window.history.replaceState({}, '', '/');
    expect(readSession().role).toBe('R1');
  });

  it('reads the role, scenario and latency the URL asserts', () => {
    window.history.replaceState({}, '', '/?role=R2&scenario=offline&latency=400');
    const session = readSession();
    expect(session.role).toBe('R2');
    expect(session.scenario).toBe('offline');
    expect(session.latencyMs).toBe(400);
  });

  it('ignores a role the platform does not define', () => {
    window.history.replaceState({}, '', '/?role=R99');
    expect(readSession().role).toBe('R1');
  });

  it('ignores a scenario the platform does not define', () => {
    window.history.replaceState({}, '', '/?scenario=not-a-scenario');
    expect(readSession().scenario).toBe('degraded');
  });

  it('falls back to the documented latency when the value is not a number', () => {
    window.history.replaceState({}, '', '/?latency=fast');
    expect(readSession().latencyMs).toBe(120);
  });
});

describe('session switchers', () => {
  it('renders the session the URL describes', () => {
    renderWithSession('?role=R3&scenario=healthy&latency=120');
    expect(screen.getByText('R3 · healthy · 120 ms')).toBeDefined();
  });

  it('offers every platform role and marks the current one', () => {
    renderWithSession('?role=R3&latency=0');
    const select = screen.getByLabelText(/Prototype role/) as HTMLSelectElement;

    expect([...select.options]).toHaveLength(6);
    expect(select.value).toBe('R3');
    expect(screen.getByLabelText(/Prototype role: .*Domain/)).toBeDefined();
  });

  it('offers every scenario and marks the current one', () => {
    renderWithSession('?scenario=maintenance&latency=0');
    const select = screen.getByLabelText(/Prototype scenario/) as HTMLSelectElement;

    expect(select.value).toBe('maintenance');
    expect([...select.options].length).toBeGreaterThan(1);
  });

  it('offers the documented latency steps and marks the current one', () => {
    renderWithSession('?latency=900');
    const select = screen.getByLabelText(/Simulated network latency/) as HTMLSelectElement;

    expect([...select.options].map((option) => option.value)).toEqual([
      '0',
      '120',
      '400',
      '900',
      '2000',
    ]);
    expect(select.value).toBe('900');
    expect(screen.getByLabelText(/900 milliseconds/)).toBeDefined();
  });

  it('explains what the latency knob simulates', () => {
    renderWithSession('?latency=0');
    expect(screen.getByText('Simulated latency')).toBeDefined();
  });
});
