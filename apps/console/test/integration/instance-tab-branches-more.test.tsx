import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/** Radix activates a tab on pointer-down, not on click. */
async function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
  return screen.findByRole('tabpanel');
}

/**
 * The remaining instance tabs. Each one degrades in its own way: a container that reports no start
 * time, a variable that is declared but never observed, a product with no event mechanism at all,
 * and a job history that could not be read. None of these is an error — they are answers the panel
 * has to phrase, and a reader that renders `undefined` is worse than one that says nothing.
 */
describe('container truth', () => {
  it('shows a degraded primary as unhealthy with its restart count', async () => {
    // Health and restarts are the two facts that separate "running" from "working"; a degraded
    // deployment is exactly the case where they disagree with the state pill.
    openAs('R1', '/instances/inst-people');
    render(<App />);
    await screen.findByRole('heading', { name: 'OrangeHRM' });

    const panel = await openTab('Containers');
    expect(await within(panel).findByText('unhealthy')).toBeDefined();
    expect(within(panel).getByText('2')).toBeDefined();
  });

  it('prints a dash where a container has never started', async () => {
    // An exited or freshly created container has no start instant; the column says "—" rather than
    // "Invalid Date" or an empty cell.
    const [container] = getState().containers['inst-crm'] ?? [];
    expect(container).toBeDefined();
    if (!container) throw new Error('the inst-crm container fixture is empty');
    container.startedAt = null;

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Containers');
    await within(panel).findByText('web');
    expect(within(panel).getAllByText('—').length).toBeGreaterThan(1);
  });

  it('re-reads the container list from the panel control', async () => {
    // Container truth is the screen an operator keeps open during a change; the panel owns the only
    // manual refresh it has.
    let reads = 0;
    server.use(
      http.get('/api/v1/instances/inst-crm/containers', () => {
        reads += 1;
        return HttpResponse.json(getState().containers['inst-crm'] ?? []);
      }),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Containers');
    await within(panel).findByText('web');
    expect(reads).toBe(1);

    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(reads).toBe(2));
  });

  it('reports an unreadable log stream inside the drawer that asked for it', async () => {
    // The drawer is opened on demand, so a failed read belongs in the drawer: the container table
    // behind it is still good and must not be replaced.
    server.use(http.get('/api/v1/instances/:id/containers/:cid/logs', () => HttpResponse.error()));

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Containers');
    await within(panel).findByText('web');
    const [logs] = within(panel).getAllByRole<HTMLButtonElement>('button', { name: 'Logs' });
    expect(logs).toBeDefined();
    if (!logs) throw new Error('the container table offers no log control');
    fireEvent.click(logs);

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('The platform API could not be reached')).toBeDefined();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(panel).getByText('web')).toBeDefined();
  });
});

describe('environment drift', () => {
  it('says a declared variable is absent when it was never observed', async () => {
    // A drift record has two sides and either can be empty: declared-but-not-observed is the
    // "missing" direction, and the panel has to name the absence instead of leaving a gap.
    const [drift] = getState().drift['inst-documents'] ?? [];
    expect(drift).toBeDefined();
    if (!drift) throw new Error('the inst-documents drift fixture is empty');
    drift.observed = null;

    openAs('R1', '/instances/inst-documents');
    render(<App />);
    await screen.findByRole('heading', { name: 'Paperless-ngx' });

    const panel = await openTab('Drift');
    await within(panel).findByText('PAPERLESS_OCR_LANGUAGE');
    expect(within(panel).getAllByText('absent').length).toBe(2);
  });
});

describe('job history', () => {
  it('reports an unreadable job history and retries the read', async () => {
    // The job history is evidence, not decoration: a failure says so and offers the retry, rather
    // than claiming the deployment has no jobs.
    server.use(http.get('/api/v1/jobs', () => HttpResponse.error()));

    openAs('R1', '/instances/inst-erp');
    render(<App />);
    await screen.findByRole('heading', { name: 'ERPNext' });

    const panel = await openTab('Jobs');
    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();

    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(within(panel).getByText('The platform API could not be reached')).toBeDefined(),
    );
  });

  it('tones each job by its state', async () => {
    // A live job, a queued one, a failure and a success are four different answers about the same
    // deployment; the badge is the only thing that separates them in the list.
    const [base] = getState().jobs;
    expect(base).toBeDefined();
    if (!base) throw new Error('the job fixture is empty');
    getState().jobs = [
      { ...base, id: 'job-live-1', instanceId: 'inst-crm', state: 'running', label: 'Live job' },
      { ...base, id: 'job-queued-1', instanceId: 'inst-crm', state: 'queued', label: 'Queued job' },
      { ...base, id: 'job-failed-1', instanceId: 'inst-crm', state: 'failed', label: 'Failed job' },
      {
        ...base,
        id: 'job-done-1',
        instanceId: 'inst-crm',
        state: 'succeeded',
        label: 'Finished job',
      },
    ];

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Jobs');
    expect(await within(panel).findByText('running')).toBeDefined();
    expect(within(panel).getByText('queued')).toBeDefined();
    expect(within(panel).getByText('failed')).toBeDefined();
    expect(within(panel).getByText('succeeded')).toBeDefined();
  });
});

describe('integration health', () => {
  it('explains a product that exposes no event mechanism', async () => {
    // Polling is the only option for such a product, and the panel says so instead of drawing an
    // empty row under "Inbound event endpoints".
    const crm = getState().instances.find((instance) => instance.id === 'inst-crm');
    expect(crm).toBeDefined();
    if (!crm) throw new Error('the inst-crm fixture is missing');
    crm.eventModes = [];

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Integration');
    expect(
      await within(panel).findByText(/no event mechanism, so workflows can only poll/),
    ).toBeDefined();
  });
});

describe('the overview facts', () => {
  it('names the internal CA and omits an empty policy-note list', async () => {
    // Every deployment in the demo fleet is ACME-signed and carries at least one policy note, so
    // the two fallbacks — an internal CA and no notes at all — are reached by re-resolving one.
    const instance = getState().instances.find((item) => item.id === 'inst-crm');
    expect(instance).toBeDefined();
    if (!instance) throw new Error('the inst-crm fixture is missing');
    instance.route.tlsMode = 'internal';
    instance.source.policyNotes = [];

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    expect(await screen.findByText('Internal CA')).toBeDefined();
    expect(screen.queryByText('No published ports; override normalises expose.')).toBeNull();
  });
});
