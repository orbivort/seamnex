import { fireEvent, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { Scenario } from '@seamnex/domain';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';
import { tile } from '../tile-fixture';

function openProduct(slug: string, scenario: Scenario = 'degraded'): void {
  openAs('R5', scenario, `/product/${slug}`);
  render(<App />);
}

describe('product page', () => {
  it('describes an entitled product, its address, version and sign-in path', async () => {
    openProduct('crm');

    expect(await screen.findByRole('heading', { level: 1, name: 'EspoCRM' })).toBeDefined();
    expect(screen.getByText(/crm\.seamnex\.local/)).toBeDefined();
    expect(screen.getByText('All applications')).toBeDefined();
    expect(screen.getByRole('button', { name: /^Open EspoCRM$/ })).toBeDefined();
    expect(screen.getAllByText('Single sign-on').length).toBeGreaterThan(0);
  });

  it('shows the catalog pin only when the deployment is behind it', async () => {
    openProduct('crm');

    expect(await screen.findByText('Catalog pin')).toBeDefined();
    // EspoCRM runs 9.2.4 while the catalog pins 10.0.11.
    expect(screen.getAllByText('v9.2.4').length).toBeGreaterThan(0);
    expect(screen.getByText('v10.0.11 available')).toBeDefined();
  });

  it('explains a degraded deployment in plain language', async () => {
    openProduct('documents');

    expect(await screen.findByText('The application is currently degraded')).toBeDefined();
    expect(screen.getByText(/Some features are temporarily unavailable/)).toBeDefined();
  });

  it('presents a proxy gate as a gated product, not single sign-on', async () => {
    openProduct('projects');

    expect(await screen.findByRole('heading', { level: 1, name: 'OpenProject' })).toBeDefined();
    // The badge says what the class guarantees, never who holds the password: ADR-BE-22 lets the
    // platform hold a per-user account for a gate, so "own credential" would be a false promise.
    expect(screen.getAllByText('Gate credential').length).toBeGreaterThan(0);
    expect(screen.queryByText('Own credential')).toBeNull();
    expect(screen.getByText('This is not single sign-on')).toBeDefined();
    // ADR-BE-22 signs some gates in with a platform-managed account, so neither the class
    // description nor step 4 may assert that the credential was issued outside the platform.
    expect(
      screen.getByText(/signs you in with an account the platform manages for you/i),
    ).toBeDefined();
    expect(screen.getByText(/the sign-in path is shown below/i)).toBeDefined();
    expect(screen.queryByText(/never creates, stores or resets/i)).toBeNull();
  });

  it('refuses to describe a product the role does not hold', async () => {
    openProduct('mautic');

    // No entitlement and no such product answer identically, so the endpoint cannot enumerate.
    expect(await screen.findByText('This product is not available to your role')).toBeDefined();
    expect(screen.queryByRole('heading', { level: 1, name: 'Mautic' })).toBeNull();
  });

  it('reports an unreachable API with a retry', async () => {
    openAs('R5', 'offline', '/product/crm');
    render(<App />);

    expect(await screen.findByText(/Platform API is unreachable/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(await screen.findByText(/Platform API is unreachable/i)).toBeDefined();
  });

  it('warns when the sign-in path is wired but unproven', async () => {
    server.use(
      http.get('/api/v1/portal/products/:slug', () =>
        HttpResponse.json({
          ...tile({ slug: 'crm' }),
          ssoState: 'sso_unverified',
          guaranteeClass: 'fa_header',
          authLabel: 'SSO unverified',
          ssoHealth: {
            checked: true,
            ok: false,
            checkedAt: '2026-11-04T08:00:00.000Z',
            detail: 'the product answered 502',
            reason: 'failed',
          },
        }),
      ),
    );
    openProduct('crm');

    expect(await screen.findByText('End-to-end sign-in check')).toBeDefined();
    expect(screen.getByText(/the product answered 502/)).toBeDefined();
    expect(screen.getByText('SSO unverified')).toBeDefined();
  });

  it('says a deployment is not launchable by this role without blaming the product', async () => {
    server.use(
      http.get('/api/v1/portal/products/:slug', () =>
        HttpResponse.json(tile({ slug: 'crm', launchable: false, plainStatus: 'available' })),
      ),
    );
    openProduct('crm');

    const launch = await screen.findByRole('button', { name: 'Not launchable' });
    expect((launch as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Your role cannot launch this product.')).toBeDefined();
  });

  it('lists a maintenance window and an unknown version honestly', async () => {
    server.use(
      http.get('/api/v1/portal/products/:slug', () =>
        HttpResponse.json(
          tile({
            slug: 'crm',
            plainStatus: 'maintenance',
            maintenanceTitle: 'Scheduled database upgrade',
            version: null,
            availableVersion: '10.0.12',
          }),
        ),
      ),
    );
    openProduct('crm');

    expect(await screen.findByText('Scheduled database upgrade')).toBeDefined();
    expect(screen.getByText('Not known')).toBeDefined();
    expect(screen.getByText('v10.0.12 available')).toBeDefined();
  });

  it('offers the launch dialog from the header action', async () => {
    openProduct('crm');

    const launch = await screen.findByRole('button', { name: /^Open EspoCRM$/ });
    launch.click();

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Launch target')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
