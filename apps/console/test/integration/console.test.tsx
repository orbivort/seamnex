import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('operator console', () => {
  it('surfaces the attention queue and capacity verdict on the overview', async () => {
    openAs('R1');
    render(<App />);

    expect(await screen.findByText('Portfolio overview')).toBeDefined();
    expect(
      await screen.findByText(/items need an operator|Nothing needs attention/i),
    ).toBeDefined();
    expect(await screen.findByText(/D07-01 OrangeHRM is degraded/i)).toBeDefined();
    expect(await screen.findByText(/vCPU and .* GB memory headroom/i)).toBeDefined();
  });

  it('lists all thirteen catalog entries with their guarantee class', async () => {
    openAs('R1', '/catalog');
    render(<App />);

    expect(await screen.findByText('Domain catalog')).toBeDefined();
    expect(await screen.findByText('EspoCRM')).toBeDefined();
    expect(await screen.findByText('WooCommerce')).toBeDefined();
    expect((await screen.findAllByText(/13 entries/i)).length).toBeGreaterThan(0);
  });

  it('shows container truth and the failure reason on an instance', async () => {
    openAs('R1', '/instances/inst-people');
    render(<App />);

    // The product name is on the page twice by design: the heading, and the topbar breadcrumb that
    // replaced the instance's UUID. The heading is the assertion.
    expect(await screen.findByRole('heading', { name: 'OrangeHRM' })).toBeDefined();
    expect(await screen.findByText(/Readiness probe returned HTTP 503/i)).toBeDefined();
    expect(await screen.findByText(/not ready/i)).toBeDefined();
  });

  it('redirects a product administrator away from the overview', async () => {
    openAs('R4');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Instances' })).toBeDefined();
  });
});
