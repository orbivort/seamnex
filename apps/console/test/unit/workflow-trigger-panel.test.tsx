import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@seamnex/api-client';
import type { ProblemDetail, Workflow, WorkflowTriggerUpdate } from '@seamnex/domain';
import { WorkflowTriggerPanel } from '../../src/features/workflows/WorkflowTriggerPanel';

/**
 * FR-5.4 — the trigger editor, driven directly.
 *
 * The page-level suites reach this panel through the mock platform, where only the mode that the
 * fixture happens to hold is rendered. The branches that matter here are the ones a single fixture
 * cannot show: the parameters of each mode, the two ways a save is refused (an empty cron, an
 * interval that is not a whole number of minutes), what a save actually sends, and the three states
 * of the mutation — in flight, answered with a version, answered with a problem.
 *
 * Only `usePutWorkflowTrigger` is replaced. `toProblem` stays real, because the panel's failure
 * alert is built from it and a double of that function would assert nothing about this file.
 */
const save = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}));

vi.mock('@seamnex/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, usePutWorkflowTrigger: () => save };
});

type Trigger = Workflow['trigger'];

function workflow(trigger: Partial<Trigger> = {}): Workflow {
  return {
    id: 'wf-won-to-project',
    name: 'Won opportunity → project kickoff',
    description: null,
    owner: { id: 'usr-mara-vogel', name: 'Mara Vogel' },
    state: 'active',
    version: 4,
    irHash: 'sha256:1f8c4a90d2e7b653a0c81f4d92e36b70c5a1d8e4f92b037c6d51e8a04b7c3f26',
    trigger: {
      type: 'webhook',
      label: 'D01-01 EspoCRM — opportunity.won',
      config: 'token seamnex_trg_7c1a… / HMAC-SHA256',
      timezone: null,
      ...trigger,
    },
    writeTargets: [],
    nodes: [],
    edges: [],
    credentialScopes: [],
    validation: { valid: true, checkedAt: null, issues: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastRunAt: null,
    lastRunState: null,
    enabled: true,
  };
}

function problem(overrides: Partial<ProblemDetail> = {}): ProblemDetail {
  return {
    type: 'https://platform.seamnex.local/problems/version-conflict',
    title: 'The definition changed while you were editing',
    status: 409,
    detail: 'Version 4 was replaced by version 5.',
    code: 'VERSION_CONFLICT',
    fieldErrors: [],
    remediation: 'Reload the workspace and reapply the trigger.',
    ...overrides,
  };
}

/** The update the panel handed to the mutation, as the API would receive it. */
function sentUpdate(): WorkflowTriggerUpdate {
  const [update] = save.mutate.mock.calls[0] ?? [];
  if (update === undefined) throw new Error('the panel did not call the mutation');
  return update as WorkflowTriggerUpdate;
}

function setTriggerType(value: Trigger['type']): void {
  fireEvent.change(screen.getByRole('combobox', { name: /Mode/ }), { target: { value } });
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: /Save trigger|Saving…/ });
}

function renderPanel(options: { definition?: Workflow; canWrite?: boolean } = {}): void {
  render(
    <WorkflowTriggerPanel
      workflow={options.definition ?? workflow()}
      canWrite={options.canWrite ?? true}
    />,
  );
}

beforeEach(() => {
  save.mutate.mockReset();
  save.isPending = false;
  save.isError = false;
  save.error = null;
});

describe('WorkflowTriggerPanel modes', () => {
  it('offers every mode the schema declares and names the one in effect', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Trigger' })).toBeDefined();
    const options = within(screen.getByRole('combobox', { name: /Mode/ })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Webhook',
      'Schedule',
      'Polling',
      'Manual',
    ]);

    // The right-hand column reads the definition the server returned, not the draft.
    expect(screen.getByText(/Webhook ·/)).toBeDefined();
    expect(screen.getByText(/HMAC-SHA256/)).toBeDefined();
    expect(screen.getByText(/starts when a signed event is delivered/)).toBeDefined();
    expect(screen.getByText(/a change creates a new version/)).toBeDefined();
  });

  it('renders no parameter a webhook does not read', () => {
    // Absent, not disabled: a disabled input still reads as a value in effect.
    renderPanel();

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(saveButton().hasAttribute('disabled')).toBe(true);
  });

  it('sends the cron expression, and UTC when the timezone field is left blank', () => {
    renderPanel();
    setTriggerType('schedule');

    const cron = screen.getByRole('textbox', { name: /Cron expression/ });
    const timezone = screen.getByRole('textbox', { name: /Timezone/ });
    expect((timezone as HTMLInputElement).value).toBe('UTC');

    // An empty cron is a refusal, not a save the API has to reject.
    expect(screen.getByText('A scheduled workflow needs a cron expression.')).toBeDefined();
    expect(saveButton().hasAttribute('disabled')).toBe(true);

    fireEvent.change(cron, { target: { value: '  0 2 * * *  ' } });
    fireEvent.change(timezone, { target: { value: '   ' } });
    expect(screen.queryByText('A scheduled workflow needs a cron expression.')).toBeNull();
    expect(saveButton().hasAttribute('disabled')).toBe(false);

    fireEvent.click(saveButton());
    expect(save.mutate).toHaveBeenCalledTimes(1);
    expect(sentUpdate()).toEqual({
      type: 'schedule',
      cron: '0 2 * * *',
      timezone: 'UTC',
    });
  });

  it('refuses an expression the engine cannot compile, and names the field', () => {
    /*
     * The live failure FR-5.4 started from: only an empty cron was refused, so `61 * * * *` saved,
     * validated clean, and activation answered with n8n's bare 400 — reported to the operator as a
     * missing platform adapter, which sent them to inspect a working credential.
     */
    renderPanel();
    setTriggerType('schedule');

    const cron = screen.getByRole('textbox', { name: /Cron expression/ });
    fireEvent.change(cron, { target: { value: '61 * * * *' } });

    expect(screen.getByText(/Minute "61" is not a number from 0 to 59/)).toBeDefined();
    expect(screen.queryByText('A scheduled workflow needs a cron expression.')).toBeNull();
    expect(saveButton().hasAttribute('disabled')).toBe(true);
    expect(save.mutate).not.toHaveBeenCalled();

    fireEvent.change(cron, { target: { value: '0 2 * * *' } });
    expect(screen.queryByText(/Minute "61"/)).toBeNull();
    expect(saveButton().hasAttribute('disabled')).toBe(false);
  });

  it('keeps the timezone the operator typed, without surrounding whitespace', () => {
    renderPanel({ definition: workflow({ type: 'schedule', cron: '0 2 * * *' }) });

    // Seeded from the definition, so nothing is dirty yet.
    expect(saveButton().hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: /Timezone/ }), {
      target: { value: ' Europe/Berlin ' },
    });
    fireEvent.click(saveButton());

    expect(sentUpdate()).toEqual({
      type: 'schedule',
      cron: '0 2 * * *',
      timezone: 'Europe/Berlin',
    });
  });

  it('refuses a polling interval that is not a whole number of minutes', () => {
    renderPanel({ definition: workflow({ type: 'poll', minimumIntervalMinutes: 15 }) });

    const interval = screen.getByRole('spinbutton', { name: /Minimum interval/ });
    expect((interval as HTMLInputElement).value).toBe('15');
    expect(saveButton().hasAttribute('disabled')).toBe(true);

    fireEvent.change(interval, { target: { value: '0' } });
    expect(screen.getByText('State the interval in whole minutes, at least 1.')).toBeDefined();
    expect(saveButton().hasAttribute('disabled')).toBe(true);

    fireEvent.change(interval, { target: { value: '' } });
    expect(saveButton().hasAttribute('disabled')).toBe(true);

    fireEvent.change(interval, { target: { value: '5' } });
    expect(screen.queryByText('State the interval in whole minutes, at least 1.')).toBeNull();
    fireEvent.click(saveButton());

    expect(sentUpdate()).toEqual({ type: 'poll', minimumIntervalMinutes: 5 });
  });

  it('starts a poll trigger whose definition records no interval from an empty field', () => {
    // The contract allows `minimumIntervalMinutes: null`; the panel must not render "null".
    renderPanel({ definition: workflow({ type: 'poll', minimumIntervalMinutes: null }) });

    const interval = screen.getByRole('spinbutton', { name: /Minimum interval/ });
    expect((interval as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/reads the product on the interval above/)).toBeDefined();
    expect(saveButton().hasAttribute('disabled')).toBe(true);
  });

  it('clears cron and interval when the mode starts nothing on its own', () => {
    renderPanel();
    setTriggerType('manual');

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText(/Nothing starts this workflow on its own/)).toBeDefined();

    fireEvent.click(saveButton());
    expect(sentUpdate()).toEqual({ type: 'manual', cron: null, minimumIntervalMinutes: null });
  });
});

describe('WorkflowTriggerPanel save states', () => {
  it('states which version the trigger was saved as', () => {
    // The prompt is the point: a trigger that is not re-activated does not reach the compiler.
    save.mutate.mockImplementation(
      (_update: WorkflowTriggerUpdate, options: { onSuccess?: (saved: Workflow) => void }) => {
        options.onSuccess?.({ ...workflow(), version: 7 });
      },
    );

    renderPanel();
    setTriggerType('manual');
    fireEvent.click(saveButton());

    expect(
      screen.getByText(
        'Trigger saved as version 7. Validate, then re-activate, so the compiled definition carries it.',
      ),
    ).toBeDefined();
  });

  it('renders the API problem when the save is refused', () => {
    const refusal = problem();
    save.isError = true;
    save.error = new ApiError(refusal);

    renderPanel();

    expect(screen.getByText(refusal.title)).toBeDefined();
    expect(screen.getByText(new RegExp(refusal.detail))).toBeDefined();
    expect(screen.getByText(new RegExp(refusal.remediation))).toBeDefined();
  });

  it('falls back to the shared error panel when the failure carries no problem', () => {
    // No branch may end in a screen that renders nothing: `QueryError` synthesises one.
    save.isError = true;
    save.error = null;

    renderPanel();

    expect(screen.getByText('The platform API could not be reached')).toBeDefined();
  });

  it('says it is saving and blocks a second submit while the request is in flight', () => {
    save.isPending = true;

    renderPanel();

    expect(screen.getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('combobox', { name: /Mode/ }).hasAttribute('disabled')).toBe(true);
  });

  it('is read only without workflow.author, and says which role is missing', () => {
    renderPanel({ definition: workflow({ type: 'schedule', cron: '0 2 * * *' }), canWrite: false });

    const button = saveButton();
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toBe('workflow.author is required to change the trigger');
    expect(screen.getByText('Read only: workflow.author is required.')).toBeDefined();
    expect(screen.getByRole('combobox', { name: /Mode/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('textbox', { name: /Cron expression/ }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('textbox', { name: /Timezone/ }).hasAttribute('disabled')).toBe(true);
  });

  it('drops the read-only refusal once the role is granted', () => {
    // The `blocked` expression must not stay true because a previous render was read only.
    const definition = workflow({ type: 'schedule', cron: '0 2 * * *' });
    const { rerender } = render(<WorkflowTriggerPanel workflow={definition} canWrite={false} />);
    expect(saveButton().hasAttribute('disabled')).toBe(true);

    rerender(<WorkflowTriggerPanel workflow={definition} canWrite />);
    expect(screen.queryByText('Read only: workflow.author is required.')).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: /Cron expression/ }), {
      target: { value: '0 3 * * *' },
    });
    expect(saveButton().hasAttribute('disabled')).toBe(false);
  });
});

describe('WorkflowTriggerPanel tone of the saved notice', () => {
  it('uses a polite status region, not an alert', () => {
    // A successful save must not interrupt a screen reader the way a failure does.
    save.mutate.mockImplementation(
      (_update: WorkflowTriggerUpdate, options: { onSuccess?: (saved: Workflow) => void }) => {
        options.onSuccess?.({ ...workflow(), version: 5 });
      },
    );

    renderPanel();
    setTriggerType('manual');
    fireEvent.click(saveButton());

    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
