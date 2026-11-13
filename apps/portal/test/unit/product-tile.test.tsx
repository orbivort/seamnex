import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { LauncherTile } from '@seamnex/domain';
import { TooltipProvider } from '@seamnex/ui';
import { ProductTile } from '../../src/components/ProductTile';

const BASE: LauncherTile = {
  instanceId: 'inst-erp',
  entryKey: 'D06-01',
  domain: 'ERP & Business Operations',
  product: 'ERPNext',
  description: 'One data model for the business.',
  slug: 'erpnext',
  url: 'http://erpnext.localhost:8020',
  version: '16.53.0',
  availableVersion: null,
  plainStatus: 'available',
  guaranteeClass: 'native',
  ssoState: 'sso',
  ssoHealth: {
    checked: true,
    ok: true,
    checkedAt: '2026-11-02T08:00:00.000Z',
    detail: 'stages 1–2 passed',
    reason: 'ok',
  },
  authLabel: 'Native SSO',
  productRole: 'member',
  launchable: true,
  degradedReason: null,
  maintenanceTitle: null,
  lastVerifiedAt: '2026-11-02T08:00:00.000Z',
  badge: null,
};

function renderTile(
  overrides: Partial<LauncherTile>,
  onLaunch: (tile: LauncherTile) => void = () => undefined,
): void {
  // The tile uses a tooltip, and the primitive now relies on the single provider the app mounts
  // at its root instead of creating one per tooltip.
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ProductTile tile={{ ...BASE, ...overrides }} onLaunch={onLaunch} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/**
 * The running version arrives as an image tag (`v16.53.0`) while the catalog records `16.53.0`.
 * The tile used to prepend its own `v`, so the launcher card and the product header read
 * `vv16.53.0`; both shapes now render one prefix.
 */
describe('ProductTile version claim', () => {
  it('prints an already-prefixed version once', () => {
    renderTile({ version: 'v16.53.0' });

    expect(screen.getByText('v16.53.0')).toBeDefined();
    expect(screen.queryByText('vv16.53.0')).toBeNull();
  });

  it('prints a bare version once, with the prefix added at render', () => {
    renderTile({ version: '16.53.0' });

    expect(screen.getByText('v16.53.0')).toBeDefined();
  });

  it('does not advertise an update for the version the deployment runs', () => {
    renderTile({ version: '16.53.0', availableVersion: null });

    expect(screen.getByText('v16.53.0')).toBeDefined();
    // Only the status pill may still say "Available"; no second version may be announced.
    expect(screen.queryByText(/16\.53\.0 available/i)).toBeNull();
  });

  it('shows a genuinely newer catalog version with the same single prefix', () => {
    renderTile({ version: 'v16.53.0', availableVersion: '16.54.1' });

    expect(screen.getByText('v16.53.0')).toBeDefined();
    expect(screen.getByText('v16.54.1 available')).toBeDefined();
  });

  it('says the version is unknown rather than inventing one', () => {
    renderTile({ version: null });

    expect(screen.getByText('version unknown')).toBeDefined();
  });
});

describe('ProductTile sign-in and action claims', () => {
  it('names a proxy gate as an own-credential product', () => {
    renderTile({ guaranteeClass: 'fa_gate', ssoState: null, authLabel: 'Sign-in required' });

    expect(screen.getByText('Credential outside platform')).toBeDefined();
    expect(screen.getByText('Sign-in required')).toBeDefined();
  });

  it('describes a sign-in path that is wired but unproven', () => {
    renderTile({
      guaranteeClass: 'native',
      ssoState: 'sso_unverified',
      authLabel: 'SSO unverified',
      ssoHealth: {
        checked: true,
        ok: false,
        checkedAt: '2026-11-01T08:00:00.000Z',
        detail: 'the product answered 502',
        reason: 'failed',
      },
    });

    expect(screen.getAllByText('SSO unverified').length).toBeGreaterThan(0);
  });

  it('says no end-to-end check has ever proven the sign-in', () => {
    renderTile({
      guaranteeClass: 'native',
      ssoState: 'sso_unverified',
      authLabel: 'SSO unverified',
      ssoHealth: {
        checked: false,
        ok: false,
        checkedAt: null,
        detail: '',
        reason: 'never_checked',
      },
    });

    expect(screen.getAllByText('SSO unverified').length).toBeGreaterThan(0);
  });

  it('blames the product status, not the role, when the deployment is not available', () => {
    renderTile({
      plainStatus: 'unavailable',
      launchable: false,
      degradedReason: 'This service is offline right now. Your data is safe.',
    });

    expect(screen.getByText('This service is offline right now. Your data is safe.')).toBeDefined();
    const action = screen.getByRole('button', { name: /ERPNext is unavailable/i });
    expect((action as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains a role that cannot launch an available product', () => {
    renderTile({ plainStatus: 'available', launchable: false });

    const action = screen.getByRole('button', { name: 'Your role cannot launch ERPNext' });
    expect((action as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for a product credential when SSO is not wired up at all', () => {
    renderTile({
      guaranteeClass: 'fa_header',
      ssoState: 'sign_in_required',
      authLabel: 'Sign-in required',
    });

    expect(screen.getAllByText('Sign-in required').length).toBeGreaterThan(0);
    expect(screen.queryByText('Single sign-on')).toBeNull();
  });

  it('renders the maintenance window next to its status', () => {
    renderTile({ plainStatus: 'maintenance', maintenanceTitle: 'Scheduled database upgrade' });

    expect(screen.getByText('Maintenance: Scheduled database upgrade')).toBeDefined();
    expect(screen.getAllByText('Maintenance').length).toBeGreaterThan(0);
    // A maintenance window does not remove the entitlement, so the product stays launchable.
    expect(screen.getByRole('button', { name: 'Open ERPNext' })).toBeDefined();
  });

  it('hands the tile to the launch handler when the action is usable', () => {
    const onLaunch = vi.fn();
    renderTile({}, onLaunch);

    fireEvent.click(screen.getByRole('button', { name: 'Open ERPNext' }));

    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'inst-erp' }));
  });
});
