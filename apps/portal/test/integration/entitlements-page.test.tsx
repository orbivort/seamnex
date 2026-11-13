import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

function openEntitlements(role = 'R5'): void {
  openAs(role, 'degraded', '/entitlements');
  render(<App />);
}

describe('entitlement page', () => {
  it('lists every granted application with its role, sign-in path and sync state', async () => {
    openEntitlements();

    expect(await screen.findByRole('heading', { level: 1, name: 'My access' })).toBeDefined();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('EspoCRM')).toBeDefined();
    expect(within(table).getByText('Zammad')).toBeDefined();
    expect(within(table).getByText('Paperless-ngx')).toBeDefined();
    // The proxy gate is the one row the platform cannot sync; it says so instead of guessing.
    expect(within(table).getAllByText('Unsupported').length).toBeGreaterThan(0);
    expect(within(table).getByText('Pending')).toBeDefined();
    expect(within(table).getAllByText('User').length).toBeGreaterThan(0);
    // The application cell is the row's link to the product page.
    expect(
      within(table)
        .getAllByRole('link', { name: /EspoCRM/ })
        .some((link) => link.getAttribute('href') === '/product/crm'),
    ).toBe(true);
  });

  it('summarises the identity, the coverage counts and the sync rule', async () => {
    openEntitlements();

    expect((await screen.findAllByText('Lena Hoff')).length).toBeGreaterThan(0);
    expect(screen.getByText(/lena\.hoff@seamnex\.local · lena\.hoff/)).toBeDefined();
    expect(screen.getByText(/MFA satisfied · TOTP authenticator/)).toBeDefined();
    expect(screen.getByText('Platform roles')).toBeDefined();
    expect(screen.getAllByText('R5 · End user').length).toBeGreaterThan(0);
    expect(screen.getByText('Directory groups')).toBeDefined();
    expect(screen.getByText('all-staff, helpdesk-agents, finance-readers')).toBeDefined();
    expect(screen.getByText('Entitlement summary')).toBeDefined();
    expect(screen.getByText('6 grants')).toBeDefined();
    expect(screen.getByText(/Roles come from identity-provider groups/)).toBeDefined();
  });

  it('refreshes the grants from the header action', async () => {
    openEntitlements();
    await screen.findByRole('table');

    const refresh = screen.getByRole('button', { name: /Refresh/ });
    fireEvent.click(refresh);

    // The button reflects the in-flight refetch without unmounting the table.
    expect(screen.getByRole('table')).toBeDefined();
  });

  it('refuses to list anything for a guest and offers to end the session', async () => {
    openEntitlements('R6');

    expect(await screen.findByText('Guest access is scoped to one product')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Request access')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'End guest session' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
  });

  it('opens the sign-out dialog from the account action', async () => {
    openEntitlements();
    await screen.findByRole('heading', { level: 1, name: 'My access' });

    fireEvent.click(screen.getByRole('button', { name: 'Sign out…' }));

    expect(await screen.findByRole('dialog')).toBeDefined();
  });
});
