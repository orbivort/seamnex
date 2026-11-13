import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The branches of the workflow inventory and the workspace that the happy path never reaches: the
 * eligibility fallbacks in the pickers, every way a create, an import, a rename, an export or a
 * delete can end, and the notices that replace a bare success message when a response is not what
 * the screen expected.
 *
 * The registry, the definitions and their validation results all live in the mock platform's store,
 * so a case shapes the data the screen has to explain and then mounts the app.
 */

/** RFC 9457 body the client normalises as-is; `remediation` is required by the contract. */
function problem(
  status: number,
  code: string,
  title: string,
  remediation = 'Retry from the workflow list.',
) {
  return {
    type: `https://platform.seamnex.local/problems/${code.toLowerCase()}`,
    title,
    status,
    detail: `${title}. The platform refused the request.`,
    code,
    fieldErrors: [],
    remediation,
  };
}

function workflowById(id: string) {
  const workflow = getState().workflows.find((item) => item.id === id);
  if (!workflow) throw new Error(`fixture workflow ${id} is missing`);
  return workflow;
}

/** The first real option of a picker (index 0 is the "choose a product" placeholder). */
function firstChoice(select: HTMLSelectElement): string {
  const option = select.options[1];
  if (!option) throw new Error('the picker offered nothing to choose');
  return option.value;
}

describe('workflow inventory', () => {
  it('offers a product the registry has not reported yet', async () => {
    // `writeEligible`/`workflowEligible` come from the registry. A missing answer must not read as
    // "nothing is eligible", so the deployed instance stays selectable and the API still judges it.
    getState().registry = getState().registry.filter((entry) => entry.instanceId !== 'inst-crm');

    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = await screen.findByRole('dialog');
    const source = within(dialog).getByLabelText(/^Source/) as HTMLSelectElement;
    const target = within(dialog).getByLabelText(/^Write target/) as HTMLSelectElement;

    const options = (select: HTMLSelectElement) =>
      Array.from(select.options).map((option) => option.textContent ?? '');
    expect(options(source).some((label) => label.includes('EspoCRM'))).toBe(true);
    expect(options(target).some((label) => label.includes('EspoCRM'))).toBe(true);
  });

  it('sends the description and trigger the operator chose', async () => {
    // FR-5.1: the trigger type is part of the draft. Sending it silently as the default would
    // create a scheduled workflow for an operator who asked for a webhook.
    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(within(dialog).getByLabelText(/^Name/), {
      target: { value: 'Invoice export to ledger' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Description/), {
      target: { value: 'Nightly export of issued invoices.' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Trigger/), { target: { value: 'webhook' } });
    const source = within(dialog).getByLabelText(/^Source/) as HTMLSelectElement;
    const target = within(dialog).getByLabelText(/^Write target/) as HTMLSelectElement;
    fireEvent.change(source, { target: { value: firstChoice(source) } });
    fireEvent.change(target, { target: { value: firstChoice(target) } });

    const submit = within(dialog).getByRole('button', { name: 'Create draft' });
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false));
    fireEvent.click(submit);

    expect(
      (await screen.findAllByRole('heading', { name: 'Invoice export to ledger' })).length,
    ).toBeGreaterThan(0);
    const created = getState().workflows.find((item) => item.name === 'Invoice export to ledger');
    expect(created?.trigger.type).toBe('webhook');
    expect(created?.description).toBe('Nightly export of issued invoices.');
  });

  it('reports a refused draft on the fields the API named', async () => {
    // A 422 used to appear as a single banner while the three fields looked fine, so the operator
    // had no idea which control to change.
    server.use(
      http.post('/api/v1/workflows', async () => {
        // A refusal that answers instantly would never show the in-flight label the dialog owes
        // the operator while the definition is being written.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return HttpResponse.json(
          {
            ...problem(422, 'WORKFLOW_INVALID', 'The workflow needs a name'),
            fieldErrors: [
              { field: 'name', code: 'minLength', message: 'At least 3 characters.' },
              { field: 'sourceInstanceId', code: 'required', message: 'Choose a source instance.' },
              { field: 'targetInstanceId', code: 'required', message: 'Choose a write target.' },
            ],
            remediation: 'Correct the highlighted fields and retry.',
          },
          { status: 422 },
        );
      }),
    );

    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Too short' } });
    const source = within(dialog).getByLabelText(/^Source/) as HTMLSelectElement;
    const target = within(dialog).getByLabelText(/^Write target/) as HTMLSelectElement;
    fireEvent.change(source, { target: { value: firstChoice(source) } });
    fireEvent.change(target, { target: { value: firstChoice(target) } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));

    expect(await screen.findByText('Drafting…')).toBeDefined();
    expect(await within(dialog).findByText('At least 3 characters.')).toBeDefined();
    expect(within(dialog).getByText('Choose a source instance.')).toBeDefined();
    expect(within(dialog).getByText('Choose a write target.')).toBeDefined();
    expect(within(dialog).getByText(/Correct the highlighted fields and retry/)).toBeDefined();
  });

  it('closes the draft dialog without creating anything', async () => {
    // Cancel is the only way out that must leave the inventory untouched.
    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    const before = getState().workflows.length;
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getState().workflows.length).toBe(before);
  });

  it('imports a document and opens the draft it created', async () => {
    // FR-5.11: an import lands as a disabled draft, and the operator is taken to it rather than
    // left staring at the list wondering whether anything happened.
    const source = workflowById('wf-won-to-project');
    const document = {
      apiVersion: 'seamnex.workflow/v1',
      exportedAt: new Date().toISOString(),
      irHash: source.irHash,
      workflow: source,
    };

    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Export document/), {
      target: { value: JSON.stringify(document) },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import draft' }));

    expect(
      (
        await screen.findAllByRole('heading', {
          name: `${source.name} (imported)`,
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(getState().workflows.some((item) => item.id.startsWith('wf-import-'))).toBe(true);
  });

  it('forgets a pasted document when the import dialog is dismissed', async () => {
    // A cancelled import must not leave the rejected text in the box for the next attempt.
    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Export document/), {
      target: { value: 'not json' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import draft' }));
    expect(await within(dialog).findByText('The document could not be read')).toBeDefined();

    // Dismissing with the close control is what resets the form; the state is dropped with it.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(/Export document/) as HTMLTextAreaElement).value).toBe(
      '',
    );
    expect(within(dialog).queryByText('The document could not be read')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getState().workflows.some((item) => item.id.startsWith('wf-import-'))).toBe(false);
  });

  it('uses the last update when a failed workflow has never run', async () => {
    // The failed-run queue orders by last run; a workflow that failed before its first run has no
    // timestamp there, and "last run Invalid Date" is worse than naming the update it did have.
    const workflow = workflowById('wf-lead-capture');
    workflow.lastRunAt = null;
    workflow.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    openAs('R1', '/workflows');
    render(<App />);

    expect(await screen.findByText(/last run just now/)).toBeDefined();
  });

  it('says a definition without a description has none', async () => {
    // `null` is "no description was written"; an invented sentence would read as authored copy and
    // an empty line would read as a rendering defect.
    workflowById('wf-won-to-project').description = null;

    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    expect(await screen.findByText('No description')).toBeDefined();
  });

  it('counts a single validation error without a plural', async () => {
    // "1 errors" is the kind of copy defect that makes an operator distrust the count.
    const workflow = workflowById('wf-sla-to-erp');
    workflow.validation.issues = workflow.validation.issues.slice(0, 1);

    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    expect(await screen.findByText('1 error')).toBeDefined();
  });

  it('tones a last run that is neither a success nor a failure as neutral', async () => {
    // A run that is still going is not a failure, and colouring it red would send the operator
    // looking for a problem that has not happened.
    const workflow = workflowById('wf-invoice-archive');
    workflow.lastRunAt = new Date().toISOString();
    workflow.lastRunState = 'running';

    openAs('R1', '/workflows');
    render(<App />);
    await screen.findByText('Workflow inventory');

    expect(await screen.findByText('running')).toBeDefined();
  });
});

describe('workflow workspace branches', () => {
  it('reloads a workflow whose first read failed', async () => {
    // The retry on the problem panel is the operator's only way back from a refused read.
    let calls = 0;
    server.use(
      http.get('/api/v1/workflows/:id', () => {
        calls += 1;
        if (calls === 1) {
          // 404 rather than a network error: a 4xx is a decision, so the client does not retry it
          // and the panel settles on the error instead of healing itself.
          return HttpResponse.json(problem(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found'), {
            status: 404,
          });
        }
        return HttpResponse.json(workflowById('wf-won-to-project'));
      }),
    );

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);

    expect(await screen.findByText('Workflow not found')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(
      await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' }),
    ).toBeDefined();
  });

  it('reports a validation answer it cannot read instead of claiming a pass', async () => {
    // `POST /workflows/:id/validate` answers a union of three shapes. A shape without the
    // validation fields means the call did not validate anything, and saying it did would enable
    // Activate on a definition nothing checked.
    server.use(
      http.post('/api/v1/workflows/:id/validate', () =>
        HttpResponse.json(workflowById('wf-lead-capture')),
      ),
    );

    openAs('R1', '/workflows/wf-lead-capture');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    expect(await screen.findByText('The validation response was not understood.')).toBeDefined();
  });

  it('says "1 blocking issue" when only one field is unbound', async () => {
    // The count is what tells the operator how much work is left; a wrong plural undermines it.
    const workflow = workflowById('wf-sla-to-erp');
    workflow.validation.issues = [
      {
        id: 'vi-1',
        nodeId: 'sla-order',
        severity: 'error',
        code: 'MAPPING_REQUIRED',
        message: 'Required field `customer` is unbound.',
        remediation: 'Add a lookup that resolves the ticket organisation.',
      },
    ];

    openAs('R1', '/workflows/wf-sla-to-erp');
    render(<App />);
    await screen.findByText('Activation blocked: 1 node-level error');

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    expect(await screen.findByText(/Validation found 1 blocking issue\./)).toBeDefined();
  });

  it('reports an export that failed without pretending a file was written', async () => {
    // The success path downloads a file; a refusal must say so where the button is.
    server.use(
      http.get('/api/v1/workflows/:id/export', () =>
        HttpResponse.json(problem(500, 'EXPORT_FAILED', 'The definition could not be exported'), {
          status: 500,
        }),
      ),
    );

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('The definition could not be exported')).toBeDefined();
  });

  it('shows the delete in flight before it returns to the list', async () => {
    // A delete of a definition with a trigger endpoint is not instant; the confirm has to say it is
    // working rather than looking inert and inviting a second click.
    server.use(
      http.delete('/api/v1/workflows/:id', async ({ params }) => {
        getState().workflows = getState().workflows.filter((item) => item.id !== String(params.id));
        await new Promise((resolve) => setTimeout(resolve, 150));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    openAs('R1', '/workflows/wf-sla-to-erp');
    render(<App />);
    await screen.findByRole('heading', { name: 'SLA breach → ERP service order' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete workflow' }));

    expect(await screen.findByRole('button', { name: 'Deleting…' })).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Workflows' })).toBeDefined();
  });

  it('cancels the delete confirmation without deleting', async () => {
    // Delete is offered on the workspace header; a mis-click must be survivable.
    openAs('R1', '/workflows/wf-sla-to-erp');
    render(<App />);
    await screen.findByRole('heading', { name: 'SLA breach → ERP service order' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getState().workflows.some((item) => item.id === 'wf-sla-to-erp')).toBe(true);
  });

  it('clears the description when the rename field is emptied', async () => {
    // The contract refuses `''`; clearing the field is `null`, which is "no description". The
    // handler is held open for a moment so the in-flight label can be observed too.
    const sent: { description?: string | null }[] = [];
    server.use(
      http.patch('/api/v1/workflows/:id', async ({ params, request }) => {
        const body = (await request.json()) as { name?: string; description?: string | null };
        sent.push(body);
        const workflow = workflowById(String(params.id));
        if (typeof body.name === 'string') workflow.name = body.name;
        workflow.description = body.description ?? null;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json(workflow);
      }),
    );
    const workflow = workflowById('wf-won-to-project');
    workflow.description = null;

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    const description = within(dialog).getByLabelText(/^Description/) as HTMLInputElement;
    expect(description.value).toBe('');

    fireEvent.change(within(dialog).getByLabelText(/^Name/), {
      target: { value: 'Kickoff automation' },
    });
    // Whitespace is not a description either: it trims to nothing and is sent as `null`.
    fireEvent.change(description, { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saving…')).toBeDefined();
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]?.description).toBeNull();
    await waitFor(() =>
      expect(getState().workflows.find((item) => item.id === 'wf-won-to-project')?.name).toBe(
        'Kickoff automation',
      ),
    );
    expect(
      getState().workflows.find((item) => item.id === 'wf-won-to-project')?.description,
    ).toBeNull();
  });

  it('reports a refused rename inside the dialog that asked for it', async () => {
    // The dialog stays open on a refusal; the problem belongs next to the fields it was about.
    server.use(
      http.patch('/api/v1/workflows/:id', () =>
        HttpResponse.json(problem(403, 'FORBIDDEN', 'Rename needs the workflow author'), {
          status: 403,
        }),
      ),
    );

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Rename needs the workflow author')).toBeDefined();
  });

  it('cancels the rename dialog without saving', async () => {
    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Discarded' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(workflowById('wf-won-to-project').name).toBe('Won opportunity → project kickoff');
  });

  it('calls out a workflow that writes nowhere', async () => {
    // A read-only workflow needs no write-target authority (FR-5.9); the governance panel says so
    // rather than showing an empty list.
    workflowById('wf-won-to-project').writeTargets = [];

    openAs('R1', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });

    expect(await screen.findByText(/No write target: this workflow is read-only/)).toBeDefined();
  });
});
