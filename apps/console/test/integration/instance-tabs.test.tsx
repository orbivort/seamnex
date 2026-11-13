import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * The tabs are separate reads over the same deployment. Each one owns its loading, error and
 * empty state, and the actions they expose (container logs, backup verification, a render diff)
 * are the evidence an operator came for.
 */
/**
 * Radix activates a tab on pointer-down rather than on click, so the helper dispatches the event
 * the primitive actually listens for and then waits for the panel it reveals.
 */
async function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
  return screen.findByRole('tabpanel');
}

describe('deployment tabs', () => {
  it('shows container truth and the recent logs of one container', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Containers');
    expect(await within(panel).findByText('Container truth')).toBeDefined();
    await within(panel).findByText('web');

    const logsButtons = within(panel).getAllByRole('button', { name: 'Logs' });
    fireEvent.click(present(logsButtons[0], 'a Logs action'));

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Recent container logs')).toBeDefined();
    expect(await within(drawer).findByText(/masked by the platform/)).toBeDefined();
  });

  it('reports the resolved environment with its ceilings and sources', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Environment');
    expect(await within(panel).findByText('Resolved environment')).toBeDefined();
    expect(await within(panel).findByText('ADMIN_EMAIL')).toBeDefined();
    expect(within(panel).getAllByText('locked').length).toBeGreaterThan(0);
  });

  it('changes an override and reports the render diff it requires', async () => {
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
      target: { value: 'ops@seamnex.local' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save and render diff' }));

    expect(await screen.findByText(/Recreate required|Restart required/)).toBeDefined();
  });

  it('asks before discarding an unapplied override', async () => {
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
      target: { value: 'typed-but-not-saved' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(/Discard the unapplied value for ADMIN_EMAIL\?/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reports environment drift against the declared definition', async () => {
    openAs('R1', '/instances/inst-documents');
    render(<App />);
    await screen.findByRole('heading', { name: 'Paperless-ngx' });

    const panel = await openTab('Drift');
    expect(await within(panel).findByText('Environment drift')).toBeDefined();
    expect(await within(panel).findByText('PAPERLESS_OCR_LANGUAGE')).toBeDefined();
    expect(within(panel).getByText('mismatch')).toBeDefined();
    expect(within(panel).getByText('undeclared')).toBeDefined();
  });

  it('says a clean instance has no drift', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Drift');
    expect(await within(panel).findByText('No drift detected')).toBeDefined();
  });

  it('lists the backup sets and accepts a new backup job', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    expect(await within(panel).findByText('Backup and restore')).toBeDefined();
    await within(panel).findByText('bkp-crm-latest');

    fireEvent.click(within(panel).getByRole('button', { name: 'Back up now' }));
    expect(await within(panel).findByText(/Backup job .* accepted/)).toBeDefined();
  });

  it('verifies and restores a backup set through accepted jobs', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');

    fireEvent.click(
      present(within(panel).getAllByRole('button', { name: 'Verify' })[0], 'a Verify action'),
    );
    expect(await within(panel).findByText(/Verification job .* accepted/)).toBeDefined();

    fireEvent.click(
      present(within(panel).getAllByRole('button', { name: 'Restore' })[0], 'a Restore action'),
    );
    expect(await within(panel).findByText(/Restore job .* accepted/)).toBeDefined();
  });

  it('saves the backup schedule after naming the cadence and zone', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');

    fireEvent.click(within(panel).getByRole('button', { name: 'Schedule' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Scheduled backups')).toBeDefined();

    fireEvent.change(within(drawer).getByLabelText('Cadence'), {
      target: { value: '0 */6 * * *' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a failed verification as not verified rather than green', async () => {
    openAs('R1', '/instances/inst-itsm');
    render(<App />);
    await screen.findByRole('heading', { name: 'GLPI' });

    const panel = await openTab('Backups');
    expect((await within(panel).findAllByText('not verified')).length).toBeGreaterThan(0);
  });

  it('lists the jobs that touched this instance', async () => {
    openAs('R1', '/instances/inst-erp');
    render(<App />);
    await screen.findByRole('heading', { name: 'ERPNext' });

    const panel = await openTab('Jobs');
    expect(await within(panel).findByText('Job history')).toBeDefined();
    const job = present(
      getState().jobs.find((item) => item.instanceId === 'inst-erp'),
      'a job that touched inst-erp',
    );
    expect(await within(panel).findByText(job.label)).toBeDefined();
  });

  it('reports post-deployment integration health check by check', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Integration');
    expect(await within(panel).findByText('Post-deployment integration health')).toBeDefined();
    expect(await within(panel).findByText('Application HTTP readiness')).toBeDefined();
    expect(within(panel).getByText('Stack composition')).toBeDefined();
    expect(within(panel).getByText('Volumes and quota')).toBeDefined();
    expect(within(panel).getByText('Inbound event endpoints')).toBeDefined();
  });

  it('warns that a deployment has no verified restore', async () => {
    openAs('R1', '/instances/inst-itsm');
    render(<App />);
    await screen.findByRole('heading', { name: 'GLPI' });

    expect(await screen.findByText('No verified restore')).toBeDefined();
  });
});
