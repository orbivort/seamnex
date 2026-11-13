import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The canvas inspector and the run-history panel: the parts of a workflow workspace that are only
 * meaningful once something is unusual — a node with no operation, a validation issue on the node
 * the operator selected, an edge whose target was deleted, a run still in flight, a replay, and the
 * two ways either panel can fail to load.
 *
 * Everything is driven from the mock platform's store so the cases stay deterministic: the run
 * history is data, not a simulated clock.
 */

function workflowById(id: string) {
  const workflow = getState().workflows.find((item) => item.id === id);
  if (!workflow) throw new Error(`fixture workflow ${id} is missing`);
  return workflow;
}

function problem(status: number, code: string, title: string) {
  return {
    type: `https://platform.seamnex.local/problems/${code.toLowerCase()}`,
    title,
    status,
    detail: `${title}. The platform refused the request.`,
    code,
    fieldErrors: [],
    remediation: 'Open the workflow and retry.',
  };
}

async function openRunsTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Runs' }));
  return screen.findByRole('tabpanel');
}

/** The first `Inspect`/`Replay` control of a row, once the table has rows. */
async function firstRowAction(scope: HTMLElement, name: string): Promise<HTMLElement> {
  const [control] = await within(scope).findAllByRole('button', { name });
  if (!control) throw new Error(`no "${name}" control was rendered`);
  return control;
}

describe('workflow canvas', () => {
  it('describes a node that has neither an entry key nor an operation', async () => {
    // Condition and approval nodes are platform steps: they come from no product and call no
    // operation, and the card and the inspector have to say that rather than printing `null`.
    const workflow = workflowById('wf-won-to-project');
    const condition = workflow.nodes.find((node) => node.id === 'node-condition');
    if (!condition) throw new Error('fixture node node-condition is missing');
    condition.operation = null;

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    const card = await screen.findByRole('button', { name: /Deal value ≥ €25,000/ });
    expect(within(card).getByText('platform · no operation')).toBeDefined();

    fireEvent.click(card);

    // The inspector falls back for both fields, and says the node maps nothing.
    expect(await screen.findByText('Platform · Platform')).toBeDefined();
    expect(screen.getByText(/No field mapping yet/)).toBeDefined();
    expect(screen.getByText('no issues on this node')).toBeDefined();
  });

  it('opens the mapper for an unbound node and says why the field list is missing', async () => {
    // A condition node runs no product operation, so discovery has nothing to answer. The panel used
    // to sit on "reading schema…" for ever — a request that was never sent. It has to say manual
    // entry is in use instead, and name the control for what it changes.
    const workflow = workflowById('wf-won-to-project');
    const condition = workflow.nodes.find((node) => node.id === 'node-condition');
    if (!condition) throw new Error('fixture node node-condition is missing');
    condition.operation = null;

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(await screen.findByRole('button', { name: /Deal value ≥ €25,000/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Map fields' }));
    const drawer = await screen.findByRole('dialog');

    expect(within(drawer).getByLabelText('Read operation')).toBeDefined();
    expect(await within(drawer).findByText('manual entry')).toBeDefined();
    expect(
      within(drawer).getByText('Bind an operation to this node before its fields can be read.'),
    ).toBeDefined();
    expect(within(drawer).queryByText('reading schema…')).toBeNull();
  });

  it('lists the issues of the selected node with their severity and remediation', async () => {
    // The canvas counts issues per node; the operator has to be able to read them without leaving
    // the canvas, and a warning must not read as an error.
    const workflow = workflowById('wf-won-to-project');
    workflow.validation.issues = [
      {
        id: 'vi-canvas-1',
        nodeId: 'node-project',
        severity: 'error',
        code: 'MAPPING_REQUIRED',
        message: 'Required field `budget` is unbound.',
        remediation: 'Map opportunity.amount onto budget.',
      },
      {
        id: 'vi-canvas-2',
        nodeId: 'node-project',
        severity: 'warning',
        code: 'OWNER_ACK',
        message: 'A write workflow needs an owner acknowledgement.',
        remediation: 'Confirm the owner on the workspace header.',
      },
    ];

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    const card = await screen.findByRole('button', { name: /Create work package/ });
    expect(within(card).getByText('2')).toBeDefined();
    fireEvent.click(card);

    // The issuance is repeated in the "Activation blocked" list, so both copies are expected.
    expect((await screen.findAllByText('Required field `budget` is unbound.')).length).toBe(2);
    expect(screen.getAllByText('Map opportunity.amount onto budget.').length).toBe(2);
    expect(
      screen.getAllByText('A write workflow needs an owner acknowledgement.').length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('warning').length).toBeGreaterThan(0);
    expect(screen.getAllByText('error').length).toBeGreaterThan(0);
  });

  it('opens the workbench with the existing mappings already in the ledger', async () => {
    // A mapping with `transform: null` is a plain copy and has no editor: the ledger shows the two
    // names it maps, and no third column invites the author to invent a transform.
    openAs('R1', '/workflows/wf-sla-to-erp');
    render(<App />);
    await screen.findByRole('heading', { name: 'SLA breach → ERP service order' });

    fireEvent.click(await screen.findByRole('button', { name: /Create service order/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Map fields' }));

    const drawer = await screen.findByRole('dialog');
    const sources = within(drawer)
      .getAllByLabelText(/^Source path \d+$/)
      .map((element) => (element as HTMLInputElement).value);
    const targets = within(drawer)
      .getAllByLabelText(/^Target field \d+$/)
      .map((element) => (element as HTMLInputElement).value);
    expect(sources).toEqual(['ticket.customer', 'ticket.id']);
    expect(targets).toEqual(['customer', 'po_no']);
    expect(within(drawer).queryAllByLabelText(/transform/i).length).toBe(0);
  });

  it('draws no connector for an edge whose target no longer exists', async () => {
    // A stale edge is a data defect, not a reason to blank the canvas: the remaining connectors are
    // drawn and the header still reports the definition it was given.
    const workflow = workflowById('wf-won-to-project');
    workflow.edges = [
      ...workflow.edges,
      { id: 'e-stale', source: 'node-notify', target: 'node-deleted', mappings: [] },
    ];

    openAs('R1', '/workflows/wf-won-to-project');
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    expect(await screen.findByText('5 nodes · 5 connections')).toBeDefined();
    expect(container.querySelectorAll('path[marker-end]').length).toBe(4);
  });
});

describe('workflow run history', () => {
  it('reloads the run history on demand', async () => {
    // The list is a snapshot; Refresh is how an operator asks for the runs recorded since.
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    const panel = await openRunsTab();
    expect((await within(panel).findAllByText(/^run-\d+/)).length).toBeGreaterThan(0);

    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh runs' }));

    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Refresh runs' })).toBeDefined(),
    );
    expect(within(panel).queryByText('No runs recorded')).toBeNull();
  });

  it('reports a run history that could not be read', async () => {
    // An unreadable history must not look like an empty one: "No runs recorded" would tell the
    // operator the workflow never ran.
    server.use(http.get('/api/v1/workflows/:id/runs', () => HttpResponse.error()));

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    const panel = await openRunsTab();
    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();
    expect(within(panel).queryByText('No runs recorded')).toBeNull();
  });

  it('reports a run whose detail could not be read, inside the drawer', async () => {
    // The row is still visible after the drawer fails, so the problem has to be reported in the
    // drawer that asked for the detail.
    server.use(
      http.get('/api/v1/workflow-runs/:runId', () =>
        HttpResponse.json(problem(404, 'RUN_NOT_FOUND', 'Run not found'), { status: 404 }),
      ),
    );

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    const panel = await openRunsTab();
    fireEvent.click(await firstRowAction(panel, 'Inspect'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Run not found')).toBeDefined();
  });

  it('closes the run drawer and keeps the history behind it', async () => {
    // Inspecting a run is a selection, not a navigation, so dismissing it must return to the list
    // rather than to an empty tab.
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    const panel = await openRunsTab();
    fireEvent.click(await firstRowAction(panel, 'Inspect'));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close panel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(panel).getAllByRole('button', { name: 'Inspect' }).length).toBeGreaterThan(0);
  });

  it('shows a run still in flight without claiming a finish time', async () => {
    // A running run has no `finishedAt`; printing a date for it, or colouring its unfinished nodes
    // red, would invent information the platform does not have.
    const run = getState().workflowRuns.find((item) => item.id === 'run-8801');
    if (!run) throw new Error('fixture run run-8801 is missing');
    run.state = 'running';
    run.finishedAt = null;
    run.nodes = [
      {
        nodeId: 'node-trigger',
        label: 'Opportunity won',
        state: 'succeeded',
        attempt: 1,
        durationMs: 320,
        records: 1,
        error: null,
      },
      {
        nodeId: 'node-project',
        label: 'Create work package',
        state: 'failed',
        attempt: 2,
        durationMs: 510,
        records: 0,
        error: 'HTTP 502 from OpenProject.',
      },
      {
        nodeId: 'node-notify',
        label: 'Post to #delivery',
        state: 'running',
        attempt: 1,
        durationMs: 40,
        records: 0,
        error: null,
      },
    ];

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    const panel = await openRunsTab();
    fireEvent.click(await firstRowAction(panel, 'Inspect'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Per-node outcome')).toBeDefined();
    expect(within(drawer).getByText('—')).toBeDefined();
    expect(within(drawer).getByText('HTTP 502 from OpenProject.')).toBeDefined();
    expect(within(drawer).getAllByText('running').length).toBeGreaterThan(0);
    expect(within(drawer).getByText('succeeded')).toBeDefined();
    expect(within(drawer).getByText('failed')).toBeDefined();
  });

  it('shows the failure that stopped a run', async () => {
    // The failed-run queue sends the operator here; the drawer is where the cause and the failing
    // node are read.
    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    const panel = await openRunsTab();
    fireEvent.click(await firstRowAction(panel, 'Inspect'));

    const drawer = await screen.findByRole('dialog');
    expect(
      await within(drawer).findByText(
        'Contact creation failed for 3 leads; idempotency keys retained for replay.',
      ),
    ).toBeDefined();
    expect(
      within(drawer).getByText(
        'HTTP 429 from EspoCRM after 3 bounded retries; rate limit is 60 requests/minute.',
      ),
    ).toBeDefined();
  });

  it('marks a replayed run as a replay of the run it came from', async () => {
    // A replay preserves the idempotency key, so the drawer has to name the original run: two rows
    // with the same key and no provenance read as a duplicate execution.
    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    const panel = await openRunsTab();
    const rows = (await within(panel).findAllByRole('button', { name: 'Inspect' })).length;
    fireEvent.click(await firstRowAction(panel, 'Replay'));

    // The replay is recorded as a new run and lands at the top of the history.
    await waitFor(() =>
      expect(within(panel).getAllByRole('button', { name: 'Inspect' }).length).toBe(rows + 1),
    );
    expect(getState().workflowRuns.some((run) => run.replayOf === 'run-8799')).toBe(true);

    fireEvent.click(await firstRowAction(panel, 'Inspect'));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(/^replay of run-8799$/)).toBeDefined();
  });
});

describe('field mapping workbench', () => {
  it('maps a field picked from a pasted sample and saves the whole list', async () => {
    // The workbench is what turns a definition that can only fail into one that sends a body; the
    // run history proved the failure, so the assertion is on the request the platform receives.
    let received: { nodeId: unknown; body: unknown } | null = null;
    const saved = structuredClone(workflowById('wf-lead-capture'));
    server.use(
      http.put('/api/v1/workflows/:id/nodes/:nodeId/mappings', async ({ request, params }) => {
        received = { nodeId: params.nodeId, body: await request.json() };
        return HttpResponse.json(saved);
      }),
    );

    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    fireEvent.click(await screen.findByRole('button', { name: /Create contact/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Map fields' }));

    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('Sample item JSON'), {
      target: {
        value: JSON.stringify({
          lead: { email: 'ops@northwind.example', consentSource: 'webinar' },
        }),
      },
    });

    // Picking a field is one click: the source path no longer has to be recalled as JSON path syntax.
    fireEvent.click(await within(drawer).findByRole('checkbox', { name: /lead\.email/ }));
    fireEvent.change(within(drawer).getByLabelText('Target field 2'), {
      target: { value: 'emailAddress' },
    });

    fireEvent.click(within(drawer).getByRole('button', { name: 'Save mapping' }));

    await waitFor(() => expect(received).not.toBeNull());
    expect(received).toEqual({
      nodeId: 'lead-create',
      body: {
        mappings: [
          { from: 'lead.consentSource', to: 'consentSource', transform: null },
          { from: 'lead.email', to: 'emailAddress', transform: null },
        ],
      },
    });
    // Announced twice on purpose: once to assistive technology, once on screen.
    expect((await within(drawer).findAllByText('2 mappings saved.')).length).toBe(2);
  });

  it('offers manual entry when the product publishes no schema', async () => {
    // A product without a schema endpoint is a warning, not a dead end: the drawer says why the
    // list is missing and leaves the target editable, and nothing blocks saving on that basis.
    server.use(
      http.get('/api/v1/workflows/:id/nodes/:nodeId/fields', () =>
        HttpResponse.json({
          nodeId: 'lead-create',
          entryKey: 'D01-01',
          operation: 'contacts.write',
          status: 'unsupported',
          fields: [],
          fetchedAt: new Date().toISOString(),
          detail: 'OrangeHRM publishes no schema for the fields an operation accepts.',
        }),
      ),
    );

    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });
    fireEvent.click(await screen.findByRole('button', { name: /Create contact/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Map fields' }));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(/publishes no schema/i)).toBeDefined();
    expect(within(drawer).getByLabelText('Target field 1')).toBeDefined();
  });

  it('shows the mapping read-only to a role without workflow.author', async () => {
    // A reviewer is accountable for the definition, so the ledger and the compiled body are
    // readable to them — with no editor, no save, and no author-only field/sample read.
    openAs('R2', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    fireEvent.click(await screen.findByRole('button', { name: /Create contact/ }));

    expect(await screen.findByText(/editing needs the workflow author/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Map fields' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'View mapping' }));
    const drawer = await screen.findByRole('dialog');

    // The rows are there, as text rather than inputs.
    expect(await within(drawer).findByText('lead.consentSource')).toBeDefined();
    expect(within(drawer).getByText('consentSource')).toBeDefined();
    expect(within(drawer).queryByRole('button', { name: 'Save mapping' })).toBeNull();
    expect(within(drawer).queryByLabelText('Sample item JSON')).toBeNull();
    expect(within(drawer).getByText('Request body preview')).toBeDefined();
  });
});

describe('workspace validation summary', () => {
  it('shows a warning that does not block activation', async () => {
    // An unmapped write node compiles to a request with no body: activation succeeds and the first
    // run fails at the product. The screen used to render issues only when one was an *error*, so
    // this was invisible until the run came back failed.
    const workflow = workflowById('wf-lead-capture');
    workflow.validation = {
      valid: true,
      checkedAt: new Date().toISOString(),
      issues: [
        {
          id: 'vi-empty-body',
          nodeId: workflow.nodes[1]?.id ?? null,
          severity: 'warning',
          code: 'EMPTY_MAPPINGS',
          message: 'Node "Create contact" maps no fields, so it posts an empty body to D01-01.',
          remediation: 'Map at least one field before running.',
        },
      ],
    };

    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    expect(await screen.findByText('Activation is available, with 1 warning')).toBeDefined();
    expect(screen.getByText(/posts an empty body to D01-01/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Activate' }).hasAttribute('disabled')).toBe(false);
  });

  it('keeps the blocking heading when an error is present', async () => {
    openAs('R1', '/workflows/wf-sla-to-erp');
    render(<App />);
    await screen.findByRole('heading', { name: 'SLA breach → ERP service order' });

    expect(await screen.findByText('Activation blocked: 2 node-level errors')).toBeDefined();
    expect(screen.queryByText(/Activation is available, with/)).toBeNull();
  });
});
