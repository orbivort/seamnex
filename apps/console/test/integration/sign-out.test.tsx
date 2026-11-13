import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * An operator holds an administrative session and `/sign-in` refuses to render while one exists
 * (`sessionRouting` → `already-signed-in`), so this control is the only way out of the console.
 * Without it the session is bounded only by the idle/absolute timeouts (NFR-4.9).
 */
describe('console sign-out', () => {
  it('offers sign-out to an operator and ends the session through the shared dialog', async () => {
    openAs('R1', '/');
    render(<App />);

    const [trigger] = await screen.findAllByRole('button', { name: 'Sign out' });
    if (trigger === undefined) throw new Error('the console exposes no sign-out control');
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/ends your platform session/i)).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Signed out')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeDefined();
    // A residual session is reported as an estimate ("≤ 8 h expected, verified …") or, when there
    // is none, the statement says so. The assertion still expected "remaining", which the dialog
    // stopped saying when the copy changed (3feb2f7); it was already failing before this branch.
    expect(
      (await screen.findAllByText(/expected|No product sessions remain/)).length,
    ).toBeGreaterThan(0);
  });

  it('leaves the session intact when the operator changes their mind', async () => {
    openAs('R3', '/');
    render(<App />);

    const [trigger] = await screen.findAllByRole('button', { name: 'Sign out' });
    if (trigger === undefined) throw new Error('the console exposes no sign-out control');
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay signed in' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Signed out')).toBeNull();
    expect(await screen.findByRole('heading', { level: 1 })).toBeDefined();
  });
});
