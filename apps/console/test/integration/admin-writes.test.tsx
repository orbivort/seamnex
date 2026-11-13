import { fireEvent, render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The write surfaces of platform configuration. Every field of the settings form has to land in the
 * draft that gets sent, and a sync cycle has to report the errors it collected — a cycle that
 * reconciled everything but one route must not be summarised as a clean run.
 */
describe('platform settings form', () => {
  it('drafts an oversubscription change without saving it', async () => {
    // The CPU factor is the one numeric field whose write path is easy to lose: it edits the draft
    // rather than the query cache, so an untouched input silently saves nothing.
    openAs('R1', '/admin/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });

    fireEvent.change(await screen.findByLabelText(/CPU oversubscription factor/), {
      target: { value: '1.5' },
    });

    expect(await screen.findByText('unsaved changes: oversubscriptionFactor')).toBeDefined();
    expect(getState().settings.oversubscriptionFactor).toBe(1.25);
  });
});

describe('identity sync cycle', () => {
  it('lists the errors of the cycle it just ran', async () => {
    // AC-48 evidence: a partial cycle still propagated changes, so it is a caution, not a success —
    // and the routes it could not reconcile have to be named in the callout.
    server.use(
      http.post('/api/v1/admin/identity-sync/run', () =>
        HttpResponse.json(
          {
            id: 'sync-7750',
            startedAt: '2026-11-05T09:00:00.000Z',
            finishedAt: '2026-11-05T09:00:02.000Z',
            users: 24,
            groups: 8,
            changes: 2,
            p95LatencyMs: 91_000,
            errors: ['D09-01 OpenProject: group mapping cache miss'],
            state: 'partial',
          },
          { status: 201 },
        ),
      ),
    );

    openAs('R1', '/admin/identity-sync');
    render(<App />);
    await screen.findByRole('heading', { name: 'Identity sync' });

    fireEvent.click(screen.getByRole('button', { name: 'Run sync now' }));

    expect(await screen.findByText('Sync sync-7750 partial')).toBeDefined();
    expect(screen.getByText(/group mapping cache miss/)).toBeDefined();
    expect(screen.getByText(/2 change\(s\) propagated in 91 s/)).toBeDefined();
  });
});
