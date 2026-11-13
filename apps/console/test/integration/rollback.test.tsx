import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * FR-1.7 / AC-06: a failed upgrade must *surface* its one-step rollback where the failure is
 * reported. The instance page carried the control; the job page, which is where the operator lands
 * after an upgrade, offered only "Open instance" — so the recovery path existed but was not
 * surfaced by the failure.
 */
describe('surfaced rollback after a failed upgrade', () => {
  it('offers the rollback on the failed job itself', async () => {
    openAs('R1', '/jobs/job-1054');
    render(<App />);

    expect(await screen.findByText(/previous version can be restored/i)).toBeDefined();
    const button = await screen.findByRole('button', { name: /Roll back/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('explains itself instead of queueing a rollback with no predecessor', async () => {
    server.use(
      http.get('/api/v1/instances/:id/plan', () =>
        HttpResponse.json({
          action: 'rollback',
          instanceId: 'inst-people',
          from: 'aaaaaaaaaaaa',
          to: 'bbbbbbbbbbbb',
          changes: [],
          preUpgradeBackup: false,
          capacityVerdict: {
            admissible: true,
            headline: 'Within host capacity',
            detail: 'No additional reservation required.',
          },
          rollbackAvailable: false,
        }),
      ),
    );

    openAs('R1', '/jobs/job-1054');
    render(<App />);

    expect(await screen.findByText(/No previous render set is retained/i)).toBeDefined();
    const button = await screen.findByRole('button', { name: /Roll back/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the control off a job that did not fail', async () => {
    openAs('R1', '/jobs/job-1048');
    render(<App />);

    expect(
      (await screen.findAllByText(/Upgrade completed after a verified pre-upgrade backup/i)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/previous version can be restored/i)).toBeNull();
  });
});
