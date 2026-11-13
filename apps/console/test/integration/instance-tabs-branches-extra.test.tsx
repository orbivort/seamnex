import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
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

const forbidden = (title: string, detail: string) =>
  HttpResponse.json(
    {
      type: 'https://platform.seamnex.local/problems/forbidden',
      title,
      status: 403,
      detail,
      code: 'FORBIDDEN',
      fieldErrors: [],
      remediation: 'Ask the platform administrator.',
    },
    { status: 403 },
  );

/** The first control called `name` in `scope`; a control that went missing must fail, not pass. */
function firstControl(scope: HTMLElement, name: string): HTMLButtonElement {
  const [control] = within(scope).getAllByRole<HTMLButtonElement>('button', { name });
  expect(control).toBeDefined();
  if (!control) throw new Error(`no "${name}" control was rendered in the panel`);
  return control;
}

/** The table row that carries `element`; `closest` is nullable and a silent miss is a false pass. */
function rowOf(element: HTMLElement): HTMLTableRowElement {
  const row = element.closest('tr');
  expect(row).toBeDefined();
  if (row === null) throw new Error('the variable is not rendered inside a table row');
  return row;
}

/**
 * The backup register and the resolved environment are the two tabs that own a write. Both drive
 * mutations whose *acceptance* is invisible on their own — a verify or a restore only changes a row
 * when the job finishes — and both offer controls that a role may not use at all. These cases cover
 * the refusal, the empty register, the pending state and the terminal-state refresh.
 */
describe('backup register states', () => {
  it('reports a failed capture as a failure and a live one as in progress', async () => {
    // The row state is the only place an operator can tell a broken capture from a fresh one, so
    // both tones have to differ from "succeeded".
    const rows = getState().backups.filter((backup) => backup.instanceId === 'inst-crm');
    const [failed, running] = rows;
    expect(failed).toBeDefined();
    expect(running).toBeDefined();
    if (!failed || !running) throw new Error('the inst-crm backup fixture has fewer than two rows');
    failed.state = 'failed';
    running.state = 'running';

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    expect(await within(panel).findByText('failed')).toBeDefined();
    expect(within(panel).getByText('running')).toBeDefined();
  });

  it('reports an unreadable backup register and retries the read', async () => {
    server.use(http.get('/api/v1/instances/inst-crm/backups', () => HttpResponse.error()));

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();

    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(within(panel).getByText('The platform API could not be reached')).toBeDefined(),
    );
  });

  it('offers no backup control at all to an auditor without instance.backup', async () => {
    // FR-4.2: the affordance follows the capability. An auditor reads the register and nothing else
    // — the schedule is visible but not editable, and no "back up now" is offered anywhere.
    getState().backups = [];

    openAs('R2', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    expect(await within(panel).findByText('No backup set yet')).toBeDefined();
    expect(within(panel).queryByRole('button', { name: 'Back up now' })).toBeNull();
    expect(
      (within(panel).getByRole('button', { name: 'Schedule' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('takes the first backup from the empty register itself', async () => {
    // With no backup set the table is replaced by the empty state, which carries its own action:
    // that button is the only path to a first capture on the panel.
    getState().backups = [];

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    const emptyStateText = await within(panel).findByText('No backup set yet');
    const emptyState = emptyStateText.parentElement;
    expect(emptyState).toBeDefined();
    if (!emptyState) throw new Error('the empty backup state has no container to act in');
    fireEvent.click(within(emptyState).getByRole('button', { name: 'Back up now' }));

    expect(await within(panel).findByText(/Backup job .* accepted/)).toBeDefined();
  });

  it('reports a refused backup request next to the control that caused it', async () => {
    server.use(
      http.post('/api/v1/instances/:id/backups', () =>
        forbidden('Backup is not permitted for your role', 'instance.backup is required.'),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');
    fireEvent.click(within(panel).getByRole('button', { name: 'Back up now' }));

    expect(await within(panel).findByText('Backup is not permitted for your role')).toBeDefined();
  });

  it('reports a refused restore without claiming the data was restored', async () => {
    server.use(
      http.post('/api/v1/backups/:id/restore', () =>
        forbidden('Restore needs the platform administrator', 'instance.restore is required.'),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');
    fireEvent.click(firstControl(panel, 'Restore'));

    expect(
      await within(panel).findByText('Restore needs the platform administrator'),
    ).toBeDefined();
  });
});

describe('backup register follows its jobs', () => {
  it('re-reads the register once the verify job reaches a terminal state', async () => {
    // Verify is a 202 hand-off: the row only changes when the job is done, so the tab has to
    // refresh on the terminal state rather than optimistically (or never).
    let finished = false;
    server.use(
      http.get('/api/v1/instances/inst-crm/backups', () =>
        HttpResponse.json(
          getState()
            .backups.filter((backup) => backup.instanceId === 'inst-crm')
            .map((backup) => ({
              ...backup,
              verifiedAt: finished ? '2026-10-22T08:15:00Z' : null,
              verifyMethod: finished ? 'scratch-stack smoke test' : null,
            })),
        ),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');
    expect(within(panel).getAllByText('not verified').length).toBe(2);

    fireEvent.click(firstControl(panel, 'Verify'));
    await within(panel).findByText(/Verification job .* accepted/);

    // The runner settles the job; the tab polls it and only then re-reads the register.
    finished = true;
    const [job] = getState().jobs;
    expect(job).toBeDefined();
    if (!job) throw new Error('the queued job is missing');
    job.state = 'succeeded';

    await waitFor(() => expect(within(panel).queryAllByText('not verified').length).toBe(0), {
      timeout: 10_000,
    });
  });

  it('re-reads the register once the restore job reaches a terminal state', async () => {
    // A restore rewrites the deployment, and the runner records a pre-restore safety set: it only
    // appears if the tab re-reads after the job finished.
    let finished = false;
    server.use(
      http.get('/api/v1/instances/inst-crm/backups', () => {
        const rows = getState().backups.filter((backup) => backup.instanceId === 'inst-crm');
        const [first] = rows;
        if (!finished || first === undefined) return HttpResponse.json(rows);
        return HttpResponse.json([
          {
            ...first,
            id: 'bkp-crm-pre-restore',
            objectKey: 's3://seamnex-backups/crm/pre-restore.tar.zst.age',
          },
          ...rows,
        ]);
      }),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');

    fireEvent.click(firstControl(panel, 'Restore'));
    await within(panel).findByText(/Restore job .* accepted/);

    finished = true;
    const [job] = getState().jobs;
    expect(job).toBeDefined();
    if (!job) throw new Error('the queued job is missing');
    job.state = 'succeeded';

    expect(await within(panel).findByText('bkp-crm-pre-restore')).toBeDefined();
  });
});

describe('the schedule drawer', () => {
  it('dismisses the drawer from Cancel and from Escape', async () => {
    // The drawer holds an unsaved cadence: both ways out have to close it and neither may submit.
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');

    fireEvent.click(within(panel).getByRole('button', { name: 'Schedule' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Scheduled backups')).toBeDefined();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(panel).getByRole('button', { name: 'Schedule' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('states a switched-off schedule and the absence of any successful run', async () => {
    // A disabled cadence is drawn dimmed on the panel header, and the drawer's note has to name a
    // missing successful backup instead of printing an empty date.
    const instance = getState().instances.find((item) => item.id === 'inst-crm');
    expect(instance).toBeDefined();
    if (!instance) throw new Error('the inst-crm fixture is missing');
    instance.backup.lastSuccessAt = null;
    instance.backup.scheduleEnabled = false;

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');
    expect(within(panel).getByText(/disabled/)).toBeDefined();

    fireEvent.click(within(panel).getByRole('button', { name: 'Schedule' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/never/)).toBeDefined();
    expect(
      (within(drawer).getByRole('checkbox', { name: /Schedule is active/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);

    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('saves a cadence in another zone with the schedule switched off', async () => {
    // The cadence is stored in UTC and expressed in a zone, and switching the schedule off is part
    // of the same write; a slow save has to say what it is doing instead of inviting a second click.
    const received: { schedule: string; timezone: string; enabled: boolean }[] = [];
    server.use(
      http.put('/api/v1/instances/:id/backup-schedule', async ({ request }) => {
        const body = (await request.json()) as {
          schedule: string;
          timezone: string;
          enabled: boolean;
        };
        received.push(body);
        await delay(300);
        const crm = getState().instances.find((item) => item.id === 'inst-crm');
        expect(crm).toBeDefined();
        if (!crm) throw new Error('the inst-crm fixture is missing');
        return HttpResponse.json({
          ...crm.backup,
          schedule: body.schedule,
          scheduleTimezone: body.timezone,
          scheduleEnabled: body.enabled,
        });
      }),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Backups');
    await within(panel).findByText('bkp-crm-latest');

    fireEvent.click(within(panel).getByRole('button', { name: 'Schedule' }));
    const drawer = await screen.findByRole('dialog');

    fireEvent.change(within(drawer).getByLabelText('Cadence'), {
      target: { value: 'Weekly 03:00 Europe/London' },
    });
    fireEvent.change(within(drawer).getByLabelText('Timezone'), {
      target: { value: 'Europe/London' },
    });
    fireEvent.click(within(drawer).getByRole('checkbox', { name: /Schedule is active/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save schedule' }));

    expect(await within(drawer).findByText('Saving…')).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(received).toEqual([
      { schedule: 'Weekly 03:00 Europe/London', timezone: 'Europe/London', enabled: false },
    ]);
  });
});

describe('the resolved environment', () => {
  it('explains an entry that declares no variables at all', async () => {
    // Nothing has to be resolved before the container starts; the panel says so instead of drawing
    // an empty table header.
    getState().envValues['inst-crm'] = [];

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Environment');
    expect(await within(panel).findByText('This entry declares no variables')).toBeDefined();
  });

  it('closes the change drawer without a confirmation when nothing was typed', async () => {
    // The discard confirmation exists for a half-typed override. An untouched drawer has nothing to
    // discard, so it must close on the first dismissal.
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Environment');
    await within(panel).findByText('ADMIN_EMAIL');
    const row = rowOf(within(panel).getByText('ADMIN_EMAIL'));
    fireEvent.click(within(row).getByRole('button', { name: 'Change' }));

    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(/Discard the unapplied value/)).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: 'Change' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps an unapplied override when the operator chooses to keep editing', async () => {
    // The discard confirmation is a two-way door: "Keep editing" has to return to the same draft,
    // with the typed value still there, or the guard would cost the operator their work.
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Environment');
    await within(panel).findByText('ADMIN_EMAIL');
    const row = rowOf(within(panel).getByText('ADMIN_EMAIL'));
    fireEvent.click(within(row).getByRole('button', { name: 'Change' }));

    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('New value'), {
      target: { value: 'still-typing@seamnex.local' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(/Discard the unapplied value for ADMIN_EMAIL/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(screen.queryByText(/Discard the unapplied value/)).toBeNull());
    expect((within(drawer).getByLabelText('New value') as HTMLInputElement).value).toBe(
      'still-typing@seamnex.local',
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reports a change that needs a recreate rather than merely a restart', async () => {
    // FR-1.28: a stored change is only real once it is applied, and a change to a variable that is
    // read at container creation needs a recreate. Rendering it as a restart would be wrong advice.
    const envValues = getState().envValues['inst-crm'];
    expect(envValues).toBeDefined();
    const target = envValues?.find((row) => row.name === 'ADMIN_EMAIL');
    expect(target).toBeDefined();
    if (!target) throw new Error('the inst-crm environment has no ADMIN_EMAIL variable');
    target.requiresRecreate = true;

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Environment');
    await within(panel).findByText('ADMIN_EMAIL');
    const row = rowOf(within(panel).getByText('ADMIN_EMAIL'));
    fireEvent.click(within(row).getByRole('button', { name: 'Change' }));

    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('New value'), {
      target: { value: 'ops@seamnex.local' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save and render diff' }));

    expect(await screen.findByText('Recreate required')).toBeDefined();
    expect(screen.getByText(/Changes apply only after the instance is recreated/)).toBeDefined();
  });
});
