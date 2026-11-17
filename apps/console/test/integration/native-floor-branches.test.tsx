import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * S-2 — the branches of the native-floor block.
 *
 * The block must never imply a target the platform is not measuring against. Four shapes are
 * asserted: a payload with no `nativeFloor` (the API behind the console), a met floor, a floor
 * lowered by a recorded decision, and the degradation when the registry cannot name the gap. The
 * decision dialog gets its refusals too, because it is the only path that can lower the target.
 */
const NOW = '2026-11-02T15:00:00.000Z';

function posture(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW,
    sso: { native: 2, forwardAuth: 4, signInRequired: 0, totalEntries: 6 },
    missingHealthChecks: [],
    unverifiedRestores: [],
    expiringCertificates: [],
    staleMetadata: [],
    instancesWithoutHealthCheck: 0,
    totalInstances: 6,
    coveragePercent: 100,
    ...overrides,
  };
}

async function floorPanel(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Native floor' });
  const section = heading.closest('section');
  if (section === null) throw new Error('the native-floor block is not in a panel');
  return section;
}

describe('native floor (S-2)', () => {
  it('falls back to the shipped target when the payload does not carry one', async () => {
    server.use(http.get('/api/v1/posture', () => HttpResponse.json(posture())));

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await floorPanel();
    expect(await within(panel).findByText('2 of 6 required')).toBeDefined();
    expect(within(panel).getByText('4 short')).toBeDefined();
    // The gap is named per deployment, not counted: "4 short" alone sends the operator hunting.
    expect(within(panel).getByText(/4 more native deployments are required/)).toBeDefined();
    // The baseline is the fleet S-2 was written against, served with the payload's counts.
    expect(within(panel).getByText(/12 baseline deployments/)).toBeDefined();
  });

  it('states the floor as met against a lowered target, with the decision that lowered it', async () => {
    server.use(
      http.get('/api/v1/posture', () =>
        HttpResponse.json(
          posture({
            sso: {
              native: 2,
              forwardAuth: 4,
              signInRequired: 0,
              totalEntries: 6,
              nativeFloor: { floor: 2, baseline: 12, met: true, shortfall: 0 },
              ownerDecision: {
                floor: 2,
                reason: 'Accepting two native deployments for the ERPNext pilot quarter.',
                recordedBy: 'usr-sofia',
                recordedAt: '2026-10-01T09:00:00.000Z',
              },
            },
          }),
        ),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await floorPanel();
    expect(await within(panel).findByText('2 of 2 required')).toBeDefined();
    expect(within(panel).getByText('met')).toBeDefined();
    expect(within(panel).getByText(/Floor lowered to 2 by recorded decision/)).toBeDefined();
    expect(
      within(panel).getByText(/The floor is met: 2 deployments authenticate natively/),
    ).toBeDefined();
  });

  it('says it cannot name the gap when the registry read fails, rather than showing an empty list', async () => {
    server.use(
      http.get('/api/v1/posture', () => HttpResponse.json(posture())),
      http.get('/api/v1/registry/instances', () =>
        HttpResponse.json({ title: 'Unavailable', status: 503 }, { status: 503 }),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await floorPanel();
    expect(
      await within(panel).findByText(
        /The registry could not be read, so the deployments cannot be named/,
      ),
    ).toBeDefined();
  });

  it('refuses a decision that is not a lowering, and one that does not say what it accepts', async () => {
    server.use(http.get('/api/v1/posture', () => HttpResponse.json(posture())));

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await floorPanel();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Record a decision' }));

    // Six is the floor in force: only a lower target is a decision.
    fireEvent.change(await screen.findByLabelText(/^Floor/), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'later' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record decision' }));

    const alerts = (await screen.findAllByRole('alert'))
      .map((alert) => alert.textContent)
      .join(' ');
    expect(alerts).toContain('Enter a whole number between 0 and 5.');
    expect(alerts).toContain('State what is being accepted in at least 20 characters.');
    // The dialog stays open on a refusal: nothing was sent.
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('posts the decision and closes the dialog, which is what makes the target change', async () => {
    let posted: unknown = null;
    server.use(
      http.get('/api/v1/posture', () => HttpResponse.json(posture())),
      http.post('/api/v1/posture/native-floor/decision', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({
          floor: 4,
          reason: 'Accepting four native deployments while the ERPNext migration runs.',
          recordedBy: 'usr-sofia',
          recordedAt: NOW,
        });
      }),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await floorPanel();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Record a decision' }));
    fireEvent.change(await screen.findByLabelText(/^Floor/), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: 'Accepting four native deployments while the ERPNext migration runs.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record decision' }));

    // The dialog closes only once the API accepted the row and its audit entry.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posted).toEqual({
      floor: 4,
      reason: 'Accepting four native deployments while the ERPNext migration runs.',
    });
  });
});
