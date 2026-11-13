import { render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('patch register', () => {
  it('orders the register worst first and marks the NFR-4.7 window it breached', async () => {
    openAs('R1', '/governance/patches');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Patch register' })).toBeDefined();
    const table = await screen.findByRole('table');
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '');

    expect(rows.length).toBeGreaterThan(1);
    // Critical → behind → current, so the record that needs patching today is never buried.
    const ranks = rows.map((text) =>
      text.includes('critical')
        ? 0
        : text.includes('behind')
          ? 1
          : text.includes('not checked')
            ? 3
            : 2,
    );
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    // A critical record older than 7 days is past the remediation clock, not merely "aged".
    expect(screen.getAllByText(/past 7-day window/i).length).toBeGreaterThan(0);
  });

  it('reports an unmeasured security age as unmeasured, never as "none pending"', async () => {
    server.use(
      http.get('/api/v1/patch-register', () =>
        HttpResponse.json([
          {
            instanceId: 'inst-erp',
            entryKey: 'D06-01',
            product: 'ERPNext',
            currentVersion: '15.41.2',
            latestVersion: '15.42.0',
            lastUpgradeAt: '2026-09-01T08:00:00.000Z',
            oldestUnappliedSecurityDays: null,
            severity: 'warning',
            checkedAt: '2026-10-30T08:00:00.000Z',
          },
        ]),
      ),
    );

    openAs('R1', '/governance/patches');
    render(<App />);

    expect(await screen.findByText('ERPNext')).toBeDefined();
    expect(screen.getByText('not measured')).toBeDefined();
    expect(screen.queryByText('none pending')).toBeNull();
  });

  it('does not claim "0 critical" when the register cannot be read', async () => {
    server.use(http.get('/api/v1/patch-register', () => HttpResponse.error()));

    openAs('R1', '/governance/patches');
    render(<App />);

    expect(await screen.findByText(/could not be reached|did not answer/i)).toBeDefined();
    expect(screen.queryByText('0 critical')).toBeNull();
    expect(screen.getByText('posture unavailable')).toBeDefined();
  });
});
