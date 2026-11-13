import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { SyncRun } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * AC-48: a membership change must reach the products inside five minutes, p95. The screen's job is
 * evidence: a failed cycle has no samples, so it must not be reported as a green `0 ms / 300 s`.
 */
function failedRun(): SyncRun {
  return {
    id: 'sync-9999',
    startedAt: '2026-11-05T09:00:00.000Z',
    finishedAt: '2026-11-05T09:00:01.000Z',
    users: 0,
    groups: 0,
    changes: 0,
    p95LatencyMs: 0,
    errors: ['The directory could not be read: connection refused'],
    state: 'failed',
  };
}

describe('identity sync evidence', () => {
  it('reports the latest cycle and the p95 target', async () => {
    openAs('R1', '/admin/identity-sync');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Identity sync' })).toBeDefined();
    const runs = getState().syncRuns;
    const latest = present(runs[0], 'a recorded sync cycle');
    expect(screen.getByText('Sync cycles')).toBeDefined();
    expect(
      await screen.findByText(`p95 ${Math.round(latest.p95LatencyMs / 1000)} s / 300 s`),
    ).toBeDefined();
    expect(await screen.findByText(latest.id)).toBeDefined();
  });

  it('runs a cycle and reports what it propagated', async () => {
    openAs('R1', '/admin/identity-sync');
    render(<App />);
    await screen.findByRole('heading', { name: 'Identity sync' });

    fireEvent.click(screen.getByRole('button', { name: 'Run sync now' }));

    expect(await screen.findByText(/Sync sync-\d+ succeeded/)).toBeDefined();
    expect(screen.getByText(/change\(s\) propagated in/)).toBeDefined();
  });

  it('does not paint a failed cycle green', async () => {
    const run = failedRun();
    getState().syncRuns = [run, ...getState().syncRuns];

    openAs('R1', '/admin/identity-sync');
    render(<App />);

    expect(await screen.findByText('p95 0 ms / 300 s')).toBeDefined();
    expect(
      await screen.findByText(present(run.errors[0], 'the error of the failed cycle')),
    ).toBeDefined();
    expect(await screen.findByText('failed')).toBeDefined();
  });

  it('lists the errors of a partial cycle', async () => {
    getState().syncRuns = [
      {
        ...failedRun(),
        id: 'sync-partial',
        state: 'partial',
        p95LatencyMs: 301_000,
        errors: ['D13-01 GLPI: SAML attribute mapping fallback used'],
      },
    ];

    openAs('R1', '/admin/identity-sync');
    render(<App />);

    // Above the 5-minute target is a caution, not a pass.
    expect(await screen.findByText('p95 301 s / 300 s')).toBeDefined();
    expect(await screen.findAllByText(/SAML attribute mapping fallback/)).toHaveLength(1);
  });

  it('offers the first cycle from the empty state', async () => {
    getState().syncRuns = [];

    openAs('R1', '/admin/identity-sync');
    render(<App />);

    expect(await screen.findByText('No sync runs recorded')).toBeDefined();
    expect(screen.getByText('p95 — / 300 s')).toBeDefined();

    const buttons = screen.getAllByRole('button', { name: 'Run sync now' });
    fireEvent.click(present(buttons[buttons.length - 1], 'the header run action'));

    expect(await screen.findByText(/Sync sync-\d+ succeeded/)).toBeDefined();
  });

  it('reports a refused start next to the header action', async () => {
    server.use(
      http.post('/api/v1/admin/identity-sync/run', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Identity sync is not permitted for your role',
            status: 403,
            detail: 'Only the platform administrator may start a directory sync.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the platform administrator.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/admin/identity-sync');
    render(<App />);
    await screen.findByRole('heading', { name: 'Identity sync' });

    fireEvent.click(screen.getByRole('button', { name: 'Run sync now' }));

    expect(await screen.findByText('Identity sync is not permitted for your role')).toBeDefined();
  });

  it('reports unreadable evidence as unavailable', async () => {
    server.use(http.get('/api/v1/admin/identity-sync', () => HttpResponse.error()));

    openAs('R1', '/admin/identity-sync');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No sync runs recorded')).toBeNull();
  });

  it('hides the screen from a role without identity.manage_users', async () => {
    openAs('R3', '/admin/identity-sync');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Identity sync')).toBeNull());
  });
});
