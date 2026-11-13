import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ApiMode from '../../src/api-mode';

/**
 * A live build has no scenarios and no latency knob: both controls would only pretend. The role
 * switcher survives only for the development stub, which the boot records in session storage
 * (ADR-BE-14). Flipping the build-time flag is the only way to reach those branches from a suite
 * that otherwise always runs against the mock platform.
 */
vi.mock('../../src/api-mode', async () => {
  const actual = await vi.importActual<typeof ApiMode>('../../src/api-mode');
  return {
    ...actual,
    mocksEnabled: false,
    assertedRole: () => 'R5' as const,
  };
});

const PROVIDER_KEY = 'seamnex:auth-provider';

afterEach(() => {
  sessionStorage.removeItem(PROVIDER_KEY);
});

async function renderControls(): Promise<void> {
  const { LatencySwitcher, RoleSwitcher, ScenarioSwitcher, SessionProvider } =
    await import('../../src/session');
  render(
    <MemoryRouter initialEntries={['/?role=R1&scenario=healthy']}>
      <SessionProvider>
        <RoleSwitcher />
        <ScenarioSwitcher />
        <LatencySwitcher />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('portal session controls in a live build', () => {
  it('hides the scenario and latency controls, and the role switcher without the stub', async () => {
    await renderControls();

    expect(screen.queryByRole('combobox', { name: /Scenario:/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Simulated network latency:/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Platform role:/ })).toBeNull();
  });

  it('keeps the role switcher when the development stub is the provider', async () => {
    sessionStorage.setItem(PROVIDER_KEY, 'stub');

    await renderControls();

    // The asserted role wins over the `?role=` hint in live mode.
    const select = screen.getByRole('combobox', { name: /Platform role: End user/i });
    expect((select as HTMLSelectElement).value).toBe('R5');
  });
});
