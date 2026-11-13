import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  LatencySwitcher,
  RoleSwitcher,
  ScenarioSwitcher,
  SessionProvider,
  readSession,
} from '../../src/session';

const ROLE_LABEL = /Platform role:/;
const SCENARIO_LABEL = /Scenario:/;
const LATENCY_LABEL = /Simulated network latency:/;

function renderControls(search = '?role=R5&scenario=degraded&latency=0'): void {
  render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <SessionProvider>
        <RoleSwitcher compact />
        <ScenarioSwitcher />
        <LatencySwitcher />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/**
 * A role or scenario switch *navigates*: jsdom has no navigation to observe, and `location.assign`
 * is not redefinable, so these tests assert the contract that matters on this side of the seam —
 * the control never mutates the rendered session locally, and the invalid values are ignored.
 */
describe('portal session controls', () => {
  it('reads the default session when the URL carries no parameters', () => {
    window.history.replaceState({}, '', '/');

    // The portal defaults: an end user, the degraded scenario, 180 ms of simulated latency.
    expect(readSession()).toEqual({ role: 'R5', scenario: 'degraded', latencyMs: 180 });
  });

  it('renders the role, scenario and latency controls in mock mode', () => {
    renderControls();

    expect(screen.getByRole('combobox', { name: ROLE_LABEL })).toBeDefined();
    expect(screen.getByRole('combobox', { name: SCENARIO_LABEL })).toBeDefined();
    expect(screen.getByRole('combobox', { name: LATENCY_LABEL })).toBeDefined();
    expect(screen.getByRole('option', { name: /R6 · Guest/i })).toBeDefined();
  });

  it('navigates a role switch through the sign-in screen instead of mutating state', () => {
    renderControls();
    const select = screen.getByRole('combobox', { name: ROLE_LABEL }) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'R1' } });

    // The sign-in screen asserts the role; the control does not change the rendered session.
    expect(select.value).toBe('R5');
  });

  it('ignores a role value the platform does not define', () => {
    renderControls();
    const select = screen.getByRole('combobox', { name: ROLE_LABEL }) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'R99' } });

    expect(select.value).toBe('R5');
  });

  it('reloads into the chosen scenario rather than changing it in place', () => {
    renderControls();
    const select = screen.getByRole('combobox', { name: SCENARIO_LABEL }) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'maintenance' } });

    expect(select.value).toBe('degraded');
  });

  it('ignores a scenario value the platform does not define', () => {
    renderControls();
    const select = screen.getByRole('combobox', { name: SCENARIO_LABEL }) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'not-a-scenario' } });

    expect(select.value).toBe('degraded');
  });

  it('applies simulated latency without reloading the page', () => {
    renderControls();

    const select = screen.getByRole('combobox', { name: LATENCY_LABEL }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '500' } });

    expect(select.value).toBe('500');
    expect(screen.getByRole('combobox', { name: /500 milliseconds/ })).toBeDefined();
  });
});
