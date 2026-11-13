import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('portal launcher', () => {
  it('renders only the entitled applications for an end user', async () => {
    openAs('R5');
    render(<App />);

    expect(await screen.findByText(/Welcome back, Lena/i)).toBeDefined();
    expect(await screen.findByText('Zammad')).toBeDefined();
    expect(await screen.findByText('EspoCRM')).toBeDefined();
    expect(screen.queryByText('Mautic')).toBeNull();
    expect(screen.getAllByText('Available').length).toBeGreaterThan(0);
  });

  it('shows the maintenance and degraded states without infrastructure detail', async () => {
    openAs('R5');
    render(<App />);

    const degraded = await screen.findAllByText('Degraded');
    expect(degraded.length).toBeGreaterThan(0);
    expect(await screen.findByText(/People Operations is degraded/i)).toBeDefined();
    expect(screen.queryByText(/HTTP 503/i)).toBeNull();
  });

  it('names the environment the listing describes, not the browser host', async () => {
    openAs('R5');
    render(<App />);

    const environment = await screen.findByText('sbx-frankfurt-01');
    expect(environment.closest('p')?.textContent).not.toContain(window.location.host);
  });

  it('shows each deployment’s own version and its catalog pin', async () => {
    openAs('R5');
    render(<App />);

    // Instances of one product are told apart by address and version, not by the product name.
    expect(await screen.findByText('v9.2.4')).toBeDefined();
    expect(await screen.findByText(/10\.0\.11 available/i)).toBeDefined();
    expect(screen.getByText('crm')).toBeDefined();
  });

  it('lists applications in catalog-code order, not alphabetical product order', async () => {
    openAs('R5');
    render(<App />);
    await screen.findByText('EspoCRM');

    // The code badge is the catalog key, one per card, so its DOM order is the grid order.
    const codes = screen.getAllByText(/^D\d{2}-\d{2}$/).map((node) => node.textContent);

    expect(codes).toEqual(['D01-01', 'D03-01', 'D08-01', 'D09-01', 'D10-01', 'D11-01']);
    // Product order would have put Metabase (D11-01) before Zammad (D03-01).
    const products = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(products.indexOf('Zammad')).toBeLessThan(products.indexOf('Metabase'));
  });

  it('gives the guest a single scoped surface and no entitlement navigation', async () => {
    openAs('R6');
    render(<App />);

    expect(await screen.findByText(/Hello, Jonas/i)).toBeDefined();
    expect(await screen.findByText(/Guest access · scoped invitation/i)).toBeDefined();
    expect(screen.queryByText('My access')).toBeNull();
  });
});
