import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { resetState } from '@seamnex/mocks';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('portal capability and failure behaviour', () => {
  it('tells the auditor that the portal is read-only', async () => {
    openAs('R2');
    render(<App />);

    expect(
      await screen.findByText(/can see availability and entitlement evidence, but cannot launch/i),
    ).toBeDefined();
    const openButtons = screen.getAllByRole('button', { name: /Not launchable|Unavailable/i });
    expect(openButtons.length).toBeGreaterThan(0);
  });

  it('shows the guest surface when a guest opens the entitlement route directly', async () => {
    openAs('R6', 'degraded', '/entitlements');
    render(<App />);

    expect(await screen.findByText('Guest access is scoped to one product')).toBeDefined();
    expect(screen.queryByText(/Product roles/i)).toBeNull();
  });

  it('surfaces an unreachable API instead of an empty screen', async () => {
    resetState('offline');

    openAs('R5', 'offline');
    render(<App />);

    expect(await screen.findByText(/Platform API is unreachable/i)).toBeDefined();
    expect(await screen.findByRole('button', { name: /Retry/i })).toBeDefined();
  });

  it('names the entitlement sync state for an end user', async () => {
    openAs('R5', 'degraded', '/entitlements');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'My access' })).toBeDefined();
    expect((await screen.findAllByText(/synced|pending|stale/i)).length).toBeGreaterThan(0);
  });
});
