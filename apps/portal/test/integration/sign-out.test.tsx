import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * FR-3.8. The dialog is shared with the console (`@seamnex/shell`), so this file asserts the portal
 * contract: nothing is ended before the user confirms, and the result never hides a residual
 * product session or invents one of its own.
 */
describe('global sign-out', () => {
  it('asks before ending the session and reports what survives it', async () => {
    openAs('R5');
    render(<App />);

    const [trigger] = await screen.findAllByRole('button', { name: 'Sign out' });
    if (trigger === undefined) throw new Error('the portal exposes no sign-out control');
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/ends your platform session/i)).toBeDefined();

    // Nothing has happened yet: the confirmation is the only way through.
    expect(within(dialog).getByRole('button', { name: 'Stay signed in' })).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Signed out')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeDefined();
    // Either a residual row with an honest estimate, or the explicit all-clear.
    expect(
      (await screen.findAllByText(/expected|lifetime not verified|No product sessions remain/))
        .length,
    ).toBeGreaterThan(0);
    // NB-4: the platform cannot see a product session, only the lifetime it verified. Printing
    // "up to 8 h remaining" claimed knowledge of a session that may not exist at all.
    expect(screen.queryByText(/remaining/i)).toBeNull();
  });

  it('leaves the session untouched when the confirmation is dismissed', async () => {
    openAs('R5');
    render(<App />);

    const [trigger] = await screen.findAllByRole('button', { name: 'Sign out' });
    if (trigger === undefined) throw new Error('the portal exposes no sign-out control');
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay signed in' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Signed out')).toBeNull();
    // The launcher is still rendered with the same identity; no 401 followed the dismissal.
    expect(await screen.findByRole('heading', { level: 1 })).toBeDefined();
  });
});
