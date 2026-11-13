import { render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The overview is the one screen an operator reads first, so every number on it has to be true:
 * a count must match the rows under it, a label must be the label the other screens use, and a
 * failed read must not be rendered as an empty fleet.
 */
describe('portfolio overview', () => {
  it('never drops an attention item without disclosing how many are left out', async () => {
    openAs('R1');
    render(<App />);

    const heading = await screen.findByText(/(\d+) items need an operator/);
    const total = Number(/(\d+)/.exec(heading.textContent ?? '')?.[1] ?? 0);
    expect(total).toBeGreaterThan(0);

    const panel = heading.closest('section');
    expect(panel).not.toBeNull();
    const rows = within(panel as HTMLElement).getAllByRole('listitem');
    const disclosure = within(panel as HTMLElement).queryByText(/(\d+) more items? not shown/);
    const omitted = disclosure ? Number(/(\d+)/.exec(disclosure.textContent ?? '')?.[1] ?? 0) : 0;

    // The rows on screen plus the disclosed remainder must add up to the number in the heading.
    expect(rows.length - (disclosure ? 1 : 0) + omitted).toBe(total);
  });

  it('uses the portal label, not the internal identifier, in the portal-view column', async () => {
    openAs('R1');
    render(<App />);

    expect((await screen.findAllByText('Available')).length).toBeGreaterThan(0);
    expect(screen.queryByText('available')).toBeNull();
  });

  it('reports an unreadable fleet instead of zeros and an all-clear', async () => {
    server.use(
      http.get('/api/v1/instances', () => HttpResponse.error()),
      http.get('/api/v1/posture', () => HttpResponse.error()),
    );

    openAs('R1');
    render(<App />);

    expect(await screen.findByText('fleet unavailable')).toBeDefined();
    expect(await screen.findByText('Attention status unavailable')).toBeDefined();
    expect(screen.queryByText(/Nothing needs attention/i)).toBeNull();

    const deployments = screen.getByText('Deployments').parentElement;
    expect(deployments?.textContent).toContain('—');
    expect(deployments?.textContent).not.toMatch(/\b0\b/);
  });

  it('keeps the capacity rulers on the admission limits the verdict was computed with', async () => {
    openAs('R1');
    render(<App />);

    // 14.5 vCPU allocated plus the 4 vCPU reserve, against 16 vCPU × 1.25 oversubscription.
    expect(await screen.findByText('18.5 / 20.0 vCPU')).toBeDefined();
    // The allocation-only reading used to print more used than the host can allocate.
    expect(screen.queryByText('14.5 / 12.0 vCPU')).toBeNull();
  });
});
