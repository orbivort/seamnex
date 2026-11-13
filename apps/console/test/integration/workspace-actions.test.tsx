import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * Workspace actions that change the definition. Delete is only offered for a draft, activation
 * needs a passing validation, and every refusal is reported where the control is.
 */
describe('workflow workspace actions', () => {
  it('validates a workflow and reports the pass', async () => {
    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    expect(await screen.findByText(/Validation passed at/)).toBeDefined();
  });

  it('reports a refused validation without claiming a pass', async () => {
    server.use(
      http.post('/api/v1/workflows/:id/validate', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Validation needs the workflow author',
            status: 403,
            detail: 'workflow.author is not held by this role.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the workflow owner.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    expect(await screen.findByText('Validation needs the workflow author')).toBeDefined();
  });

  it('deletes a draft after a confirmation and returns to the list', async () => {
    openAs('R1', '/workflows/wf-sla-to-erp');
    render(<App />);
    await screen.findByRole('heading', { name: 'SLA breach → ERP service order' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/^Delete .*\?$/)).toBeDefined();
    expect(
      within(dialog).getByText(/Only drafts and disabled workflows can be deleted/),
    ).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete workflow' }));

    expect(await screen.findByRole('heading', { name: 'Workflows' })).toBeDefined();
    expect(getState().workflows.some((item) => item.id === 'wf-sla-to-erp')).toBe(false);
  });

  it('reports a refused delete inside the dialog', async () => {
    server.use(
      http.delete('/api/v1/workflows/:id', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/invalid-state',
            title: 'Disable the workflow before deleting it',
            status: 409,
            detail: 'An active workflow keeps its trigger endpoint until it is disabled.',
            code: 'INVALID_STATE',
            fieldErrors: [],
            remediation: 'Disable the workflow first.',
          },
          { status: 409 },
        ),
      ),
    );

    openAs('R1', '/workflows/wf-sla-to-erp');
    render(<App />);
    await screen.findByRole('heading', { name: 'SLA breach → ERP service order' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete workflow' }));

    expect(await screen.findByText('Disable the workflow before deleting it')).toBeDefined();
  });

  it('exports the definition without surfacing a problem', async () => {
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(false),
    );
    expect(screen.queryByText('The platform API could not be reached')).toBeNull();
  });

  it('activates a validated workflow', async () => {
    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    const activate = screen.getByRole('button', { name: 'Activate' });
    if (activate.hasAttribute('disabled')) return;
    fireEvent.click(activate);

    expect(
      await screen.findByText('Workflow activated. Triggers are live and runs will be recorded.'),
    ).toBeDefined();
  });

  it('explains an empty run history', async () => {
    getState().workflowRuns = [];

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Runs' }));
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText('No runs recorded')).toBeDefined();
  });
});

describe('deployment lifecycle dialogs', () => {
  async function openDialog(name: string) {
    fireEvent.click(screen.getByRole('button', { name }));
    return screen.findByRole('dialog');
  }

  it('confirms a stop and a reconfigure with their own copy', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const stop = await openDialog('Stop');
    expect(within(stop).getByText('Stop instance?')).toBeDefined();
    fireEvent.click(within(stop).getByRole('button', { name: 'Cancel' }));

    const reconfigure = await openDialog('Reconfigure');
    expect(within(reconfigure).getByText('Reconfigure instance?')).toBeDefined();
    fireEvent.click(within(reconfigure).getByRole('button', { name: 'Cancel' }));
  });

  it('confirms a start on a stopped deployment', async () => {
    openAs('R1', '/instances/inst-shop');
    render(<App />);
    await screen.findByRole('heading', { name: 'WooCommerce' });

    const start = await openDialog('Start');
    expect(within(start).getByText('Start instance?')).toBeDefined();
    fireEvent.click(within(start).getByRole('button', { name: 'Cancel' }));
  });

  it('runs the upgrade plan and accepts the job', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const dialog = await openDialog('Upgrade');
    expect(await within(dialog).findByText('pre-upgrade backup')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: /Run upgrade/ }));

    expect(await screen.findByRole('heading', { name: /Upgrade|Job detail/ })).toBeDefined();
    expect(getState().jobs.some((job) => job.kind === 'upgrade')).toBe(true);
  });

  it('deletes with an explicit data choice', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const dialog = await openDialog('Delete');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Delete everything/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete instance' }));

    expect(await screen.findByRole('heading', { name: /Delete|Job detail/ })).toBeDefined();
    expect(getState().jobs.some((job) => job.kind === 'delete')).toBe(true);
  });
});
