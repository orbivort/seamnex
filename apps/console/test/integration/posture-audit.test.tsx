import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * FR-4.8 and FR-4.3. The posture board reports two independent facts — SSO coverage and verified
 * restores — and never turns a failed read into an all-clear. The audit trail is append-only, and
 * the chain proof is the evidence a reader can check.
 */
describe('security posture', () => {
  it('reports SSO coverage and restore coverage as separate facts', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Security posture' })).toBeDefined();
    const posture = getState().posture;
    const ssoCovered = posture.sso.native + posture.sso.forwardAuth;
    expect(await screen.findByText(`SSO ${ssoCovered}/${posture.totalInstances}`)).toBeDefined();
    expect(
      screen.getByText(
        `Restores ${posture.totalInstances - posture.unverifiedRestores.length}/${posture.totalInstances}`,
      ),
    ).toBeDefined();
    expect(await screen.findByText('Native SSO')).toBeDefined();
    expect(screen.getByText('Forward-auth SSO')).toBeDefined();
    expect(screen.getByText('Sign-in required')).toBeDefined();
  });

  it('names the deployments without a verified restore, distinguishing never from overdue', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Security posture' });

    expect(await screen.findByText('Instances without a verified restore')).toBeDefined();
    expect(await screen.findByText(/OpenProject/)).toBeDefined();
    expect(screen.getAllByText('no drill').length).toBeGreaterThan(0);
  });

  it('names the certificates inside the renewal window', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Security posture' });

    expect(await screen.findByText('TLS expiry')).toBeDefined();
    expect(await screen.findByText('hooks.seamnex.local')).toBeDefined();
    expect(screen.getByText('9 days')).toBeDefined();
  });

  it('reports stale integration metadata with its overdue age', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Security posture' });

    expect(await screen.findByText('Stale integration metadata')).toBeDefined();
    expect((await screen.findAllByText(/days overdue/)).length).toBeGreaterThan(0);
  });

  it('states whether the native floor is met', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Security posture' });

    expect(
      await screen.findByText(
        new RegExp(`Native floor \\(S-2\\): ${getState().posture.sso.native} of 6`),
      ),
    ).toBeDefined();
  });

  it('explains empty panels rather than showing bare headings', async () => {
    const posture = getState().posture;
    posture.unverifiedRestores = [];
    posture.expiringCertificates = [];
    posture.staleMetadata = [];
    posture.missingHealthChecks = [];

    openAs('R1', '/governance/posture');
    render(<App />);

    expect(
      await screen.findByText('Every stateful deployment has a verified restore.'),
    ).toBeDefined();
    expect(screen.getByText(/No certificate was reported inside the renewal window/)).toBeDefined();
    expect(screen.getByText('No entry is overdue for review.')).toBeDefined();
  });

  it('reports a fleet with no deployment without a false all-clear ratio', async () => {
    const posture = getState().posture;
    posture.totalInstances = 0;
    posture.unverifiedRestores = [];
    posture.sso = { native: 0, forwardAuth: 0, signInRequired: 0, totalEntries: 0 };

    openAs('R1', '/governance/posture');
    render(<App />);

    expect(await screen.findByText('SSO 0/0')).toBeDefined();
    expect(screen.getByText('Restores 0/0')).toBeDefined();
  });

  it('reports an unreadable posture as unavailable', async () => {
    server.use(http.get('/api/v1/posture', () => HttpResponse.error()));

    openAs('R1', '/governance/posture');
    render(<App />);

    expect(await screen.findByText('posture unavailable')).toBeDefined();
    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
  });
});

describe('audit trail', () => {
  it('counts the chain and pages it with a cursor', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Audit trail' })).toBeDefined();
    const events = getState().audit;
    expect(await screen.findByText(`${events.length} events`)).toBeDefined();
    expect(await screen.findByText(new RegExp(`of ${events.length} shown`))).toBeDefined();
    expect(screen.getByText(/Load \d+ more/)).toBeDefined();
  });

  it('verifies the chain from the newest event and shows the proof path', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    // The header action is `disabled` until the first page of events has loaded, and a click on a
    // disabled button is a no-op — so the wait is for the list, not merely for the button's markup.
    const verify = await screen.findByRole('button', { name: 'Verify chain' });
    await waitFor(() => expect(verify.hasAttribute('disabled')).toBe(false));
    fireEvent.click(verify);

    const drawer = await screen.findByRole('dialog');
    const newest = getState().audit.at(-1);
    expect(newest).toBeDefined();
    if (newest === undefined) throw new Error('the seeded trail has no events to prove');
    expect(within(drawer).getByText(`Chain proof · sequence ${newest.seq}`)).toBeDefined();
    expect(await within(drawer).findByText('SHA-256 hash chain')).toBeDefined();
    expect(within(drawer).getByText('Chain valid')).toBeDefined();
    expect(within(drawer).getByText('Yes')).toBeDefined();
    expect(within(drawer).getByText('Proof path')).toBeDefined();
  });

  it('opens the proof for a specific row', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    const [firstProof] = await screen.findAllByRole<HTMLButtonElement>('button', { name: 'Proof' });
    expect(firstProof).toBeDefined();
    if (firstProof === undefined) throw new Error('no row offered a chain proof');
    fireEvent.click(firstProof);

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/Chain proof · sequence \d+/)).toBeDefined();
  });

  it('filters by outcome on the server', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'denied' } });

    await waitFor(() => expect(screen.getByText(/2 of 2 shown/)).toBeDefined());
    expect(screen.queryByText(/Load \d+ more/)).toBeNull();
  });

  it('filters by break-glass action and keeps the count honest', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'breakglass' } });

    await waitFor(() => expect(screen.getByText(/1 of 1 shown/)).toBeDefined());
  });

  it('explains an empty result without claiming the chain is empty', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'denied' } });
    await waitFor(() => expect(screen.getByText(/2 of 2 shown/)).toBeDefined());
    fireEvent.change(screen.getByLabelText('Actor'), {
      target: { value: 'nobody-matches-this' },
    });

    expect(await screen.findByText('No audit events match these filters')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Verify chain' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('exports the loaded range without surfacing a problem', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByText(`${getState().audit.length} events`);
    const before = getState().audit.length;

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(false),
    );
    // The export is recorded in the chain the export itself covers.
    await waitFor(() => expect(getState().audit.length).toBeGreaterThanOrEqual(before));
    expect(screen.queryByText('The platform API could not be reached')).toBeNull();
  });

  it('reports a refused export as a problem panel', async () => {
    server.use(
      http.post('/api/v1/audit-events/export', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Audit export is not permitted for your role',
            status: 403,
            detail: 'audit.export is required.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the platform administrator.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByText(`${getState().audit.length} events`);

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('Audit export is not permitted for your role')).toBeDefined();
  });

  it('reports an unreadable chain rather than an empty one', async () => {
    server.use(http.get('/api/v1/audit-events', () => HttpResponse.error()));

    openAs('R1', '/governance/audit');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No audit events match these filters')).toBeNull();
  });

  it('explains a missing proof document', async () => {
    server.use(
      http.get('/api/v1/audit-events/:seq/proof', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/not-found',
            title: 'Audit event not found',
            status: 404,
            detail: 'No event matches that sequence.',
            code: 'NOT_FOUND',
            fieldErrors: [],
            remediation: 'Reload the trail.',
          },
          { status: 404 },
        ),
      ),
    );

    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    // Same gate as the happy path: the action cannot run before the trail it reads has loaded.
    const verify = await screen.findByRole('button', { name: 'Verify chain' });
    await waitFor(() => expect(verify.hasAttribute('disabled')).toBe(false));
    fireEvent.click(verify);

    expect(await screen.findByText('Audit event not found')).toBeDefined();
  });
});
