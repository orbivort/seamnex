import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { resetState } from '@seamnex/mocks';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('portal chrome', () => {
  it('brands the header with the shared lockup and its tagline', async () => {
    openAs('R5');
    const { container } = render(<App />);

    expect(await screen.findByText('Unified access · self-hosted')).toBeDefined();
    // The mark travels with the name: an identity that drops its monogram in the portal header
    // is the drift the shared lockup exists to prevent.
    expect(container.querySelector('header')?.textContent).toContain('SN');
  });

  it('shows the active platform notice and lets the reader dismiss it', async () => {
    openAs('R5');
    render(<App />);

    expect(await screen.findByText('People Operations is degraded')).toBeDefined();
    expect(screen.getByText(/Leave requests and the employee directory may be slow/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss platform notice' }));

    expect(screen.queryByText('People Operations is degraded')).toBeNull();
  });

  it('renders a healthy platform without a notice banner', async () => {
    resetState('healthy');
    openAs('R5', 'healthy');
    render(<App />);

    await screen.findByText('EspoCRM');
    expect(screen.queryByText('People Operations is degraded')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss platform notice' })).toBeNull();
  });

  it('warns that live data is unavailable in the offline scenario', async () => {
    resetState('offline');
    openAs('R5', 'offline');
    render(<App />);

    // The stale notice is part of the shell, not of any single screen.
    expect(await screen.findByText(/Live data unavailable/)).toBeDefined();
  });

  it('names the build that is running in the footer', async () => {
    openAs('R5');
    render(<App />);

    expect(await screen.findByText(/simulated platform data/)).toBeDefined();
    expect(screen.getByText(/Seamnex ·/)).toBeDefined();
  });

  it('prints the product version from the root manifest in the footer', async () => {
    openAs('R5');
    render(<App />);

    // The value is `__SEAMNEX_VERSION__`, injected from `package.json` at build time; the assertion
    // is the shape, not the number, so bumping the manifest does not fail the suite.
    const footer = await screen.findByRole('contentinfo');
    expect(footer.textContent).toMatch(/· v\d+\.\d+\.\d+/);
  });

  it('routes the account chip to the entitlement page', async () => {
    openAs('R5');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open account and entitlements' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'My access' })).toBeDefined();
  });

  it('opens the sign-out confirmation from the footer control', async () => {
    openAs('R5');
    render(<App />);

    const triggers = await screen.findAllByRole('button', { name: 'Sign out' });
    const footer = triggers[triggers.length - 1];
    if (footer === undefined) throw new Error('the footer exposes no sign-out control');
    fireEvent.click(footer);

    expect(await screen.findByRole('dialog')).toBeDefined();
  });

  it('names the second-factor state of the session', async () => {
    openAs('R5');
    render(<App />);

    expect(await screen.findByText('MFA satisfied')).toBeDefined();
  });
});
