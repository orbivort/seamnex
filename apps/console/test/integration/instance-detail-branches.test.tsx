import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState, resetState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The instance detail screen has three surfaces the happy-path suite never reaches: the whole-screen
 * gate (when the deployment itself cannot be read), the degraded banner that keeps the last good
 * read on screen behind a failed refetch, and the four overlay dialogs, each of which owns its own
 * dismissal path. A dialog that cannot be dismissed without confirming is a trap, so every one of
 * them is closed here — by its Cancel button and by Escape.
 */
describe('the whole-screen gate', () => {
  it('reports a deployment the platform does not have and re-reads it on retry', async () => {
    // A 404 is a decision, not a blip: the screen must say so instead of an empty shell, and the
    // retry it offers must actually re-issue the read.
    openAs('R1', '/instances/inst-ghost');
    render(<App />);

    expect(await screen.findByText('Instance not found')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Instance not found')).toBeDefined();
    expect(screen.getByText(/No instance matches inst-ghost/)).toBeDefined();
  });

  it('keeps the last good read on screen when the refresh of it fails', async () => {
    // ERR-04: `isError` is also true for a failed *refetch*. Replacing the page with an error panel
    // then would throw away a detail surface that is still the last thing the API said.
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    server.use(http.get('/api/v1/instances/inst-crm', () => HttpResponse.error()));
    fireEvent.click(screen.getByRole('button', { name: /Refresh status/ }));

    expect(await screen.findByText('Showing the last data that loaded')).toBeDefined();
    expect(screen.getByText('Instance facts')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.getByText('Showing the last data that loaded')).toBeDefined(),
    );
  });

  it('flags a deployment that sits inside a maintenance window', async () => {
    // The header carries one badge for maintenance and nothing when the window is closed; the
    // closed case is every other fixture, so only the open window is driven here.
    resetState('maintenance');

    openAs('R1', '/instances/inst-collab', 'maintenance');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Nextcloud Hub' })).toBeDefined();
    expect(screen.getAllByText('maintenance').length).toBeGreaterThan(1);
  });

  it('says a deployment has never been backed up rather than printing an empty date', async () => {
    // A missing `lastSuccessAt` is a fact about the deployment, not a formatting accident: the
    // header facts and the overview both have to name it.
    const crm = getState().instances.find((instance) => instance.id === 'inst-crm');
    expect(crm).toBeDefined();
    if (!crm) throw new Error('the inst-crm fixture is missing');
    crm.backup.lastSuccessAt = null;

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    expect(screen.getAllByText('Never').length).toBeGreaterThan(0);
  });
});

describe('the upgrade dialog', () => {
  it('reports a plan that could not be read and retries it from the panel', async () => {
    // The dialog is the only place the plan is read, so a failed plan must be reported inside it
    // rather than emptying the dialog the operator just opened.
    server.use(http.get('/api/v1/instances/:id/plan', () => HttpResponse.error()));

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('The platform API could not be reached')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(within(dialog).getByText('The platform API could not be reached')).toBeDefined(),
    );
  });

  it('explains a plan that changes no file and would not be admitted', async () => {
    // Both empty-ish plans are real answers: an identical render set, and a target the admission
    // rule refuses. Neither may be rendered as a blank table or a green verdict.
    server.use(
      http.get('/api/v1/instances/:id/plan', () =>
        HttpResponse.json({
          action: 'upgrade',
          instanceId: 'inst-crm',
          from: '9.2.4',
          to: '10.0.11',
          changes: [],
          preUpgradeBackup: true,
          capacityVerdict: {
            admissible: false,
            headline: 'Host capacity would be exceeded',
            detail: 'Shortfall: memoryMb.',
          },
          rollbackAvailable: true,
        }),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText(/No file differences were planned/)).toBeDefined();
    expect(within(dialog).getByText('Host capacity would be exceeded')).toBeDefined();
    expect(
      within(dialog).getByRole('button', { name: 'Run upgrade' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('runs the upgrade and opens the job it was accepted as', async () => {
    // Confirming the dialog is a 202 hand-off, not a local state change: the operator has to land
    // on the job that carries the step-by-step log of the upgrade.
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('pre-upgrade backup');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Run upgrade' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const accepted = getState().jobs.find((job) => job.kind === 'upgrade');
    expect(accepted).toBeDefined();
    if (!accepted) throw new Error('the upgrade job was not queued');
    expect(accepted.instanceId).toBe('inst-crm');
  });

  it('names the current version when the target version is no longer offered', async () => {
    // The dialog can outlive the catalog revision it was opened against: a poll can take the
    // available version away while the plan stays open. The "to" tag must fall back to the version
    // the instance is actually on instead of rendering `undefined`.
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('pre-upgrade backup');
    expect(within(dialog).getByText('10.0.11')).toBeDefined();

    const crmInstance = getState().instances.find((instance) => instance.id === 'inst-crm');
    expect(crmInstance).toBeDefined();
    if (!crmInstance) throw new Error('the inst-crm fixture is missing');
    crmInstance.availableVersion = null;
    // The header sits behind the modal, so the control is aria-hidden: it is still the operator's
    // "Refresh status" and clicking it is what re-reads the instance.
    fireEvent.click(screen.getByRole('button', { name: /Refresh status/, hidden: true }));

    await waitFor(() => expect(within(dialog).getAllByText('9.2.4').length).toBe(2));
  });
});

describe('dialog dismissal', () => {
  it('closes the upgrade dialog from Cancel and from Escape without queueing a job', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });
    const jobsBefore = getState().jobs.length;

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    let dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('pre-upgrade backup');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('pre-upgrade backup');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(getState().jobs.length).toBe(jobsBefore);
  });

  it('closes the delete dialog from Cancel and from Escape without deleting', async () => {
    // Deletion is irreversible, so an accidental click on the header control must be undoable
    // through every dismissal path the overlay offers.
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });
    const jobsBefore = getState().jobs.length;

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(getState().jobs.length).toBe(jobsBefore);
  });

  it('closes a destructive confirmation from Escape without acting', async () => {
    // The confirmation is a `ConfirmDialog`, whose own wrapper forwards the parent's handler: the
    // Escape path has to reach the page or the dialog would be impossible to dismiss.
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });
    const jobsBefore = getState().jobs.length;

    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Roll back?')).toBeDefined();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getState().jobs.length).toBe(jobsBefore);
  });
});

describe('the deployment inventory', () => {
  it('re-reads the fleet from the Refresh control and marks a deployment with no backup', async () => {
    // The Fleet filter bar owns the only manual refresh the list has, and a deployment that has
    // never been backed up says so in the row rather than leaving the column blank.
    const helpdesk = getState().instances.find((instance) => instance.id === 'inst-helpdesk');
    expect(helpdesk).toBeDefined();
    if (!helpdesk) throw new Error('the inst-helpdesk fixture is missing');
    helpdesk.backup.lastSuccessAt = null;

    let reads = 0;
    server.use(
      http.get('/api/v1/instances', () => {
        reads += 1;
        return HttpResponse.json(getState().instances);
      }),
    );

    openAs('R1', '/instances');
    render(<App />);
    await screen.findByRole('heading', { name: 'Instances' });

    const table = await screen.findByRole('table');
    expect(await within(table).findByText('never')).toBeDefined();
    expect(reads).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByText(`${getState().instances.length} deployments`)).toBeDefined();
  });
});
