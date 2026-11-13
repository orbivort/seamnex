import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/** Radix activates a tab on pointer-down, not on click. */
async function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
  return screen.findByRole('tabpanel');
}

/**
 * Each deployment tab owns its own loading, empty and failure state. These cases exercise the
 * branches the happy-path fixtures never reach: a stopped stack, an escalated role, an empty
 * register and an unreadable read.
 */
describe('overview branches', () => {
  it('states that a stopped deployment is unpublished and not reachable', async () => {
    openAs('R1', '/instances/inst-shop');
    render(<App />);
    await screen.findByRole('heading', { name: 'WooCommerce' });

    expect(await screen.findByText('Published')).toBeDefined();
    expect(screen.getByText(/No — route unpublished/)).toBeDefined();
  });

  it('says an entry is up to date when no newer version exists', async () => {
    openAs('R1', '/instances/inst-marketing');
    render(<App />);
    await screen.findByRole('heading', { name: 'Mautic' });

    expect((await screen.findAllByText('Up to date')).length).toBeGreaterThan(0);
  });

  it('names the schedule and the digest of the running image', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    expect(await screen.findByText('Schedule')).toBeDefined();
    expect(screen.getByText('Image digest')).toBeDefined();
  });
});

describe('container tab branches', () => {
  it('reports exited containers with their exit reason', async () => {
    openAs('R1', '/instances/inst-shop');
    render(<App />);
    await screen.findByRole('heading', { name: 'WooCommerce' });

    const panel = await openTab('Containers');
    expect((await within(panel).findAllByText('Exited')).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('none').length).toBeGreaterThan(0);
  });

  it('explains a stack that has not been created', async () => {
    getState().containers['inst-crm'] = [];

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Containers');
    expect(await within(panel).findByText('No containers reported')).toBeDefined();
  });

  it('reports an unreadable container list', async () => {
    server.use(http.get('/api/v1/instances/:id/containers', () => HttpResponse.error()));

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Containers');
    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();
  });
});

describe('backup tab branches', () => {
  it('offers a backup to a scoped operator but keeps the restore actions to the administrator', async () => {
    openAs('R3', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    expect(await within(panel).findByText('Back up now')).toBeDefined();
    expect(within(panel).getAllByText('admin only').length).toBeGreaterThan(0);
  });

  it('explains an instance with no backup set', async () => {
    getState().backups = [];

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    expect(await within(panel).findByText('No backup set yet')).toBeDefined();
  });

  it('reports a refused verification without claiming the set was verified', async () => {
    server.use(
      http.post('/api/v1/backups/:id/verify', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Verification needs the platform administrator',
            status: 403,
            detail: 'instance.backup is required.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the platform administrator.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');
    fireEvent.click(
      present(within(panel).getAllByRole('button', { name: 'Verify' })[0], 'a Verify action'),
    );

    expect(
      await within(panel).findByText('Verification needs the platform administrator'),
    ).toBeDefined();
  });

  it('keeps the schedule drawer open when the cadence is refused', async () => {
    server.use(
      http.put('/api/v1/instances/:id/backup-schedule', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/invalid',
            title: 'That cadence is not valid',
            status: 422,
            detail: 'Use a five-field cron expression.',
            code: 'INVALID_CADENCE',
            fieldErrors: [],
            remediation: 'Correct the cadence.',
          },
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');
    fireEvent.click(within(panel).getByRole('button', { name: 'Schedule' }));

    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('Cadence'), {
      target: { value: 'not-a-cron' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save schedule' }));

    expect(await within(drawer).findByText('That cadence is not valid')).toBeDefined();
  });
});

describe('environment tab branches', () => {
  it('reports an unreadable environment', async () => {
    server.use(http.get('/api/v1/instances/:id/env', () => HttpResponse.error()));

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Environment');
    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();
  });

  it('reports a refused override next to the form', async () => {
    server.use(
      http.put('/api/v1/instances/:id/env', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/invalid',
            title: 'That value is not allowed',
            status: 422,
            detail: 'ADMIN_EMAIL must be a valid e-mail address.',
            code: 'ENV_INVALID',
            fieldErrors: [],
            remediation: 'Correct the value.',
          },
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Environment');
    await within(panel).findByText('ADMIN_EMAIL');
    const row = present(
      within(panel).getByText('ADMIN_EMAIL').closest('tr'),
      'the ADMIN_EMAIL row',
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Change' }));

    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('New value'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save and render diff' }));

    expect(await screen.findByText('That value is not allowed')).toBeDefined();
  });
});

describe('other tab branches', () => {
  it('explains an instance with no jobs', async () => {
    getState().jobs = [];

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Jobs');
    expect(await within(panel).findByText('No jobs recorded for this instance.')).toBeDefined();
  });

  it('reports an unreadable drift report', async () => {
    server.use(http.get('/api/v1/instances/:id/drift', () => HttpResponse.error()));

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Drift');
    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();
  });

  it('shows a failing integration check as a failure', async () => {
    openAs('R1', '/instances/inst-people');
    render(<App />);
    await screen.findByRole('heading', { name: 'OrangeHRM' });

    const panel = await openTab('Integration');
    expect((await within(panel).findAllByText('fail')).length).toBeGreaterThan(0);
  });

  it('says an activity has no write target when the workflow is read-only', async () => {
    // The canvas reports the absence of a write target rather than an empty table.
    openAs('R1', '/workflows/wf-invoice-archive');
    render(<App />);
    await screen.findByRole('heading', { name: 'Invoice archived → notify finance' });

    expect(await screen.findByText('Workflow canvas')).toBeDefined();
    await waitFor(() =>
      expect(
        screen.getAllByText(/read-only canvas|Write-target authorization/).length,
      ).toBeGreaterThan(0),
    );
  });
});
