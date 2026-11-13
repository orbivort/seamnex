import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState, resetState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The overview's edges: an empty portfolio, a fleet or posture read that produced nothing, the
 * preview that hides exactly one item, and a verified restore that carries no date.
 *
 * Why these cases matter: every number on this screen is a claim about the platform, and the
 * screen is read first. "Nothing needs attention" is a conclusion that requires every input
 * behind it, so the empty and failed shapes are asserted on their copy, not only on the counts.
 */

function problemResponse(status: number, title: string, detail: string, code = 'UNAVAILABLE') {
  return HttpResponse.json(
    {
      type: 'https://platform.seamnex.local/problems/unavailable',
      title,
      status,
      detail,
      code,
      fieldErrors: [],
      remediation: 'Retry. If the API stays down, check the control-plane health page.',
    },
    { status },
  );
}

const FLEET_READ_REFUSED = 'The fleet could not be read';

describe('overview with an empty portfolio', () => {
  it('says nothing is deployed instead of painting the empty reads as an all-clear', async () => {
    // The `empty` scenario is a platform with no instance and no job. The posture summary is
    // cleared with it, because a certificate still expiring would be a real attention item and
    // this case is the one in which "nothing needs attention" is a measurement rather than an
    // absent answer. The scenario is applied to the mock platform itself: the console reads the
    // store, not the URL.
    resetState('empty');
    const posture = getState().posture;
    server.use(
      http.get('/api/v1/posture', () =>
        HttpResponse.json({
          ...posture,
          unverifiedRestores: [],
          staleMetadata: [],
          expiringCertificates: [],
          missingHealthChecks: [],
        }),
      ),
    );
    openAs('R1');
    render(<App />);

    expect(await screen.findByText('Nothing is deployed yet')).toBeDefined();
    expect(await screen.findByText('Nothing needs attention')).toBeDefined();
    expect(screen.getByText(/All readiness, restore and metadata checks pass/)).toBeDefined();
    expect(
      screen.getByText('No jobs yet. Deployments and lifecycle actions appear here.'),
    ).toBeDefined();

    // The cards print a real zero: the fleet query answered.
    const deployments = screen.getByText('Deployments').parentElement;
    expect(deployments?.textContent).toContain('0');
    expect(deployments?.textContent).not.toContain('—');
  });
});

describe('overview with failed reads', () => {
  it('reports a fleet read that produced nothing and retries it from either panel', async () => {
    let failing = true;
    server.use(
      http.get('/api/v1/instances', () =>
        failing
          ? problemResponse(503, FLEET_READ_REFUSED, 'The control plane is restarting.')
          : HttpResponse.json(getState().instances),
      ),
    );

    openAs('R1');
    render(<App />);

    expect(await screen.findByText('fleet unavailable')).toBeDefined();
    // Both regions report the same failure: the page-level problem and the queue's own panel.
    expect((await screen.findAllByText(FLEET_READ_REFUSED)).length).toBe(2);

    // Two retries, because two regions own the same read: the page-level problem and the queue.
    failing = false;
    const retries = screen.getAllByRole('button', { name: 'Retry' });
    expect(retries.length).toBeGreaterThanOrEqual(2);
    for (const retry of retries) fireEvent.click(retry);

    await waitFor(() => expect(screen.queryByText('fleet unavailable')).toBeNull());
    expect(await screen.findByText('Container truth versus the portal view')).toBeDefined();
  });

  it('offers a retry for the queue when only the posture read failed', async () => {
    let failing = true;
    server.use(
      http.get('/api/v1/posture', () =>
        failing
          ? problemResponse(503, 'The posture summary could not be read', 'Aggregation is behind.')
          : HttpResponse.json(getState().posture),
      ),
    );

    openAs('R1');
    render(<App />);

    // The fleet loaded, so the gap is the posture half only — and it says so.
    expect(await screen.findByText('Attention status unavailable')).toBeDefined();
    expect(screen.queryByText(/Nothing needs attention/)).toBeNull();

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(/\d+ items need an operator/)).toBeDefined();
  });
});

describe('overview fleet actions', () => {
  it('re-reads the fleet on demand', async () => {
    openAs('R1');
    render(<App />);
    // Wait for the first read to settle: while it is in flight the button reads "Reloading…".
    await screen.findByText('EspoCRM');

    // Re-reading is the only way to see a state change without waiting for the poll.
    fireEvent.click(screen.getByRole('button', { name: 'Reload fleet' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload fleet' })).toBeDefined());
    expect(screen.getByText('EspoCRM')).toBeDefined();
  });

  it('uses the singular when exactly one attention item is out of view', async () => {
    // Seven items is the preview plus one: the disclosure is a number an operator can act on, and
    // the singular is what makes it read as a sentence rather than a template.
    const posture = getState().posture;
    server.use(
      http.get('/api/v1/posture', () =>
        HttpResponse.json({
          ...posture,
          unverifiedRestores: [],
          staleMetadata: [],
          expiringCertificates: [],
          missingHealthChecks: [],
        }),
      ),
      http.get('/api/v1/instances', () =>
        HttpResponse.json(
          getState()
            .instances.slice(0, 7)
            .map((instance) => ({
              ...instance,
              state: 'degraded',
              ready: false,
              stateReason: 'Readiness probe failed after the environment change.',
            })),
        ),
      ),
    );

    openAs('R1');
    render(<App />);

    expect(await screen.findByText('7 items need an operator')).toBeDefined();
    expect(screen.getByText('1 more item not shown')).toBeDefined();
  });
});

describe('overview readiness matrix', () => {
  it('reports a verified restore that carries no date as unknown', async () => {
    const instances = getState().instances.map((instance, index) =>
      index === 0
        ? {
            ...instance,
            backup: { ...instance.backup, verified: true, lastVerifiedRestoreAt: null },
          }
        : instance,
    );
    server.use(http.get('/api/v1/instances', () => HttpResponse.json(instances)));

    openAs('R1');
    render(<App />);

    // A restore marked verified without a date must not print a date-shaped default: the row is
    // the only place an operator can see the restore evidence.
    const row = (await screen.findByText('EspoCRM')).closest('tr');
    expect(within(row as HTMLElement).getByText('unknown')).toBeDefined();
  });
});
