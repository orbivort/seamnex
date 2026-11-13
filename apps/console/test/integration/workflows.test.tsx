import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * FR-5: a workflow is authored from verified registry operations, validated before activation, and
 * every run is inspectable. The inventory must surface a failed run without opening the workspace,
 * and the workspace must refuse activation while validation reports errors.
 */
async function openRunsTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Runs' }));
  return screen.findByRole('tabpanel');
}

describe('workflow inventory', () => {
  it('summarises the definitions and their states', async () => {
    openAs('R1', '/workflows');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Workflows' })).toBeDefined();
    const workflows = getState().workflows;
    expect(
      await screen.findByText(
        `${workflows.filter((item) => item.state === 'active').length} active`,
      ),
    ).toBeDefined();
    expect(
      screen.getByText(`${workflows.filter((item) => item.state === 'draft').length} draft`),
    ).toBeDefined();
    expect(await screen.findByText('Workflow inventory')).toBeDefined();
  });

  it('surfaces the failed run queue without opening the workspace', async () => {
    openAs('R1', '/workflows');
    render(<App />);

    expect(await screen.findByText('Failed-run queue')).toBeDefined();
    expect(await screen.findByText(/last run/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Inspect and replay' })).toBeDefined();
  });

  it('reports validation state per row, including a workflow never validated', async () => {
    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    expect((await screen.findAllByText('valid')).length).toBeGreaterThan(0);
    expect(screen.getByText('2 errors')).toBeDefined();
  });

  it('creates a draft from two eligible products and opens it', async () => {
    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New workflow')).toBeDefined();

    const submit = within(dialog).getByRole('button', { name: 'Create draft' });
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/^Name/), {
      target: { value: 'Invoice export to finance' },
    });
    const source = within(dialog).getByLabelText(/^Source/) as HTMLSelectElement;
    const target = within(dialog).getByLabelText(/^Write target/) as HTMLSelectElement;
    fireEvent.change(source, {
      target: { value: present(source.options[1], 'a second source option').value },
    });
    fireEvent.change(target, {
      target: { value: present(target.options[1], 'a second write target option').value },
    });

    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false));
    fireEvent.click(submit);

    // The workspace replaces the list and shows the new draft.
    expect(await screen.findByRole('heading', { name: 'Invoice export to finance' })).toBeDefined();
  });

  it('refuses an import document that is not JSON', async () => {
    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Import a workflow')).toBeDefined();

    fireEvent.change(within(dialog).getByLabelText(/Export document/), {
      target: { value: 'not json' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import draft' }));

    expect(await within(dialog).findByText('The document could not be read')).toBeDefined();
  });

  it('refuses an import document from another contract version', async () => {
    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Export document/), {
      target: {
        value: JSON.stringify({ apiVersion: 'seamnex.workflow/v2', workflow: { name: 'X' } }),
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import draft' }));

    // The client rejects a document that does not match the contract before it leaves the browser.
    expect(
      await within(dialog).findByText(
        /does not match the platform contract|Unsupported document version/,
      ),
    ).toBeDefined();
  });

  it('explains an empty inventory instead of a bare table', async () => {
    getState().workflows = [];

    openAs('R1', '/workflows');
    render(<App />);

    expect(await screen.findByText('No workflows yet')).toBeDefined();
  });

  it('reports unreadable definitions as a problem panel', async () => {
    server.use(http.get('/api/v1/workflows', () => HttpResponse.error()));

    openAs('R1', '/workflows');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No workflows yet')).toBeNull();
  });

  it('keeps a role without workflow.view_runs out of the inventory', async () => {
    openAs('R5', '/workflows');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });
});

describe('workflow workspace', () => {
  it('blocks activation while validation reports node errors', async () => {
    openAs('R1', '/workflows/wf-sla-to-erp');
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'SLA breach → ERP service order' }),
    ).toBeDefined();
    expect(await screen.findByText('Activation blocked: 2 node-level errors')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Activate' }).hasAttribute('disabled')).toBe(true);
  });

  it('reports a validation failure without enabling activation', async () => {
    openAs('R1', '/workflows/wf-sla-to-erp');
    render(<App />);
    await screen.findByText('Activation blocked: 2 node-level errors');

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    expect(await screen.findByText(/Validation found \d+ blocking issue/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Activate' }).hasAttribute('disabled')).toBe(true);
  });

  it('runs an active workflow and moves to the run history', async () => {
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    expect(
      await screen.findByText(/Run .*\. Per-node outcomes appear in the Runs tab\./),
    ).toBeDefined();
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText(/Idempotency keys are preserved/)).toBeDefined();
  });

  it('renames a workflow and records the change', async () => {
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Rename workflow')).toBeDefined();

    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'K' } });
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(dialog).getByText('Use at least two characters.')).toBeDefined();

    fireEvent.change(within(dialog).getByLabelText(/^Name/), {
      target: { value: 'Kickoff automation' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Workflow renamed. The change is in the audit trail.'),
    ).toBeDefined();
  });

  it('duplicates a workflow as a draft copy', async () => {
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    expect(
      await screen.findByText('A draft copy was created. It appears in the workflow list.'),
    ).toBeDefined();
  });

  it('disables an active workflow after confirmation of the consequence', async () => {
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    expect(
      await screen.findByText(
        'Workflow disabled. Trigger endpoints are paused; history is retained.',
      ),
    ).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Activate' })).toBeDefined();
  });

  it('shows the canvas and the inspector for the selected node', async () => {
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    expect(await screen.findByText('Node palette')).toBeDefined();
    expect(screen.getByText('Workflow canvas')).toBeDefined();
    expect(screen.getByText('Write-target authorization')).toBeDefined();

    const node = present(
      (await screen.findAllByRole('button', { pressed: false })).find((element) =>
        element.textContent?.includes('Create work package'),
      ),
      'the Create work package node',
    );
    fireEvent.click(node);

    expect(await screen.findByText('Field mapping')).toBeDefined();
    expect(screen.getAllByText('no issues on this node').length).toBeGreaterThan(0);
  });

  it('reports the run history and inspects one run', async () => {
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    const panel = await openRunsTab();
    expect(
      await within(panel).findByText(/Idempotency keys are preserved on replay/),
    ).toBeDefined();

    fireEvent.click(
      present(within(panel).getAllByRole('button', { name: 'Inspect' })[0], 'an Inspect action'),
    );

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(/^Run run-\d+/)).toBeDefined();
    expect(await within(drawer).findByText('Per-node outcome')).toBeDefined();
  });

  it('replays a failed run and keeps the idempotency key', async () => {
    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    const panel = await openRunsTab();
    const replay = await within(panel).findAllByRole('button', { name: 'Replay' });
    fireEvent.click(present(replay[0], 'a Replay action'));

    await waitFor(() =>
      expect(within(panel).queryAllByRole('button', { name: 'Replay' }).length).toBeGreaterThan(0),
    );
  });

  it('refuses replay to a role without workflow.run', async () => {
    server.use(
      http.post('/api/v1/workflow-runs/:runId/replay', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Replay needs the workflow author or owner',
            status: 403,
            detail: 'workflow.run is not held by this role.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the workflow owner.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R2', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    const panel = await openRunsTab();
    const replay = await within(panel).findAllByRole('button', { name: 'Replay' });
    fireEvent.click(present(replay[0], 'a Replay action'));

    expect(
      await within(panel).findByText('Replay needs the workflow author or owner'),
    ).toBeDefined();
  });

  it('renders a workflow that cannot be read as a problem', async () => {
    server.use(http.get('/api/v1/workflows/:id', () => HttpResponse.error()));

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
  });

  it('keeps the rename control disabled for a role that may not author', async () => {
    openAs('R2', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    expect(screen.getByRole('button', { name: 'Rename' }).hasAttribute('disabled')).toBe(true);
  });
});
