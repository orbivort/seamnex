import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { MaintenanceWindow, PolicyException } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * Branch completeness for the maintenance and policy-exception screen.
 *
 * `maintenance.test.tsx` pins the decisions: an active window suppresses alerts, a late decision on
 * an expired exception is refused, a role that may not read settings is told so. What it never
 * reaches is the state the screen is in *while* the platform is deciding (a schedule or a
 * cancellation in flight), the feedback a rejected write produces on the field that caused it, and
 * the two records whose shape the fixture keeps away from the page — a rejected exception with a
 * named approver and a platform-wide window whose scope label is its own title.
 *
 * Two guards in `MaintenancePage` are deliberately left uncovered, because no interaction can reach
 * them: the submit handler's `if (startIso === null || endIso === null) return;` sits behind a
 * button that `canSubmit` disables on exactly that condition, and `onConfirm`'s `if (target ===
 * null) return;` sits behind a dialog that only exists while a target is selected. Covering them
 * would need a mocked app module, and a mock there would assert the mock rather than the screen.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** A resolver that never answers, so `isPending` is observable for the length of an assertion. */
const hang = () => new Promise<Response>(() => {});

function windowRow(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: 'mw-501',
    scope: 'instance',
    scopeLabel: 'D06-01 ERPNext — inst-erp',
    title: 'ERP upgrade',
    startsAt: iso(-HOUR),
    endsAt: iso(HOUR),
    createdBy: 'Sofia Almeida',
    state: 'scheduled',
    suppressAlerts: true,
    ...overrides,
  };
}

function exceptionRow(overrides: Partial<PolicyException> = {}): PolicyException {
  return {
    id: 'pe-105',
    rule: 'Published port',
    scope: 'D04-01 WooCommerce — inst-shop',
    justification: 'The payment provider sandbox calls back on a fixed host port.',
    requester: 'Priya Raman',
    approver: null,
    state: 'requested',
    requestedAt: iso(-260 * MINUTE),
    expiresAt: iso(14 * DAY),
    patchDiff: '+ ports: ["8080:80"]',
    ...overrides,
  };
}

/** Opens the schedule dialog on a loaded page. */
async function openScheduleDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Schedule window' }));
  return screen.findByRole('dialog');
}

/** The register entry that carries `element`; `closest` is nullable and a silent miss is a pass. */
function listItemOf(element: HTMLElement): HTMLLIElement {
  const item = element.closest('li');
  expect(item).toBeDefined();
  if (item === null) throw new Error('the register entry is not rendered inside a list item');
  return item;
}

describe('scheduling a window: rejected writes and in-flight ones', () => {
  it('puts each field the API rejected on the input that caused it', async () => {
    server.use(
      http.post('/api/v1/admin/maintenance-windows', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/validation-failed',
            title: 'The window cannot be scheduled',
            status: 422,
            detail: 'The submitted window was rejected.',
            code: 'VALIDATION_FAILED',
            fieldErrors: [
              { field: 'scope', code: 'minLength', message: 'At least one character.' },
              { field: 'instanceId', code: 'unknown', message: 'Instance does not exist.' },
              { field: 'startsAt', code: 'invalid', message: 'Send an ISO-8601 UTC timestamp.' },
              { field: 'endsAt', code: 'invalid', message: 'Send an ISO-8601 UTC timestamp.' },
            ],
            remediation: 'Correct the highlighted fields.',
          },
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByRole('heading', { name: 'Maintenance and policy exceptions' });

    const dialog = await openScheduleDialog();
    fireEvent.change(within(dialog).getByLabelText(/^Scope/), {
      target: { value: 'Quarterly database maintenance' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule window' }));

    // A 422 is not a network failure: every message the API attributed to a field belongs on that
    // field, and the dialog keeps the operator's input so the fix is an edit, not a retype.
    expect(await screen.findByText('The window cannot be scheduled')).toBeDefined();
    expect(within(dialog).getByText('At least one character.')).toBeDefined();
    expect(within(dialog).getByText('Instance does not exist.')).toBeDefined();
    expect(within(dialog).getAllByText('Send an ISO-8601 UTC timestamp.').length).toBe(2);
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('sends the instance an operator chose instead of a platform-wide window', async () => {
    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByRole('heading', { name: 'Maintenance and policy exceptions' });

    const dialog = await openScheduleDialog();
    fireEvent.change(within(dialog).getByLabelText(/^Scope/), {
      target: { value: 'ERPNext maintenance' },
    });
    // The list is only read once the dialog opens, so wait for the option before choosing it.
    await within(dialog).findByRole('option', { name: /ERPNext/ });
    fireEvent.change(within(dialog).getByLabelText(/^Instance/), { target: { value: 'inst-erp' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule window' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // A window that names an instance must carry it: a platform-wide window would suppress alerts
    // for the whole fleet, which is a far larger act than the operator asked for.
    expect(getState().maintenance[0]?.instanceId).toBe('inst-erp');
  });

  it('explains that both ends are required before the window can be scheduled', async () => {
    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByRole('heading', { name: 'Maintenance and policy exceptions' });

    const dialog = await openScheduleDialog();
    fireEvent.change(within(dialog).getByLabelText(/^Scope/), {
      target: { value: 'Quarterly database maintenance' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Starts/), { target: { value: '' } });

    const submit = within(dialog).getByRole('button', { name: 'Schedule window' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    // The disabled button states the missing fact, not a generic "cannot submit".
    expect(submit.getAttribute('title')).toBe('Both ends of the window are required.');
  });

  it('throws the draft away when the dialog is dismissed from its own close control', async () => {
    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByRole('heading', { name: 'Maintenance and policy exceptions' });

    const dialog = await openScheduleDialog();
    fireEvent.change(within(dialog).getByLabelText(/^Scope/), { target: { value: 'Abandoned' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const reopened = await openScheduleDialog();
    // Reopening starts from a clean form: a scope left over from an abandoned draft would be
    // scheduled by the next operator who only meant to look.
    expect((within(reopened).getByLabelText(/^Scope/) as HTMLInputElement).value).toBe('');
  });

  it('says the instance list is unavailable instead of silently offering a platform-wide window', async () => {
    server.use(http.get('/api/v1/instances', () => HttpResponse.error()));

    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByRole('heading', { name: 'Maintenance and policy exceptions' });

    const dialog = await openScheduleDialog();
    expect(await within(dialog).findByText('Instance list unavailable')).toBeDefined();
    // Scoping is impossible without the list, so the control cannot pretend the default is a choice.
    const select = within(dialog).getByLabelText(/^Instance/) as HTMLSelectElement;
    await waitFor(() => expect(select.hasAttribute('disabled')).toBe(true));
  });

  it('keeps the submit control busy while the API is creating the window', async () => {
    server.use(http.post('/api/v1/admin/maintenance-windows', hang));

    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByRole('heading', { name: 'Maintenance and policy exceptions' });

    const dialog = await openScheduleDialog();
    fireEvent.change(within(dialog).getByLabelText(/^Scope/), {
      target: { value: 'Quarterly database maintenance' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule window' }));

    expect(await screen.findByText('Scheduling…')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});

describe('cancelling a window: in-flight and refused', () => {
  it('busies only the row being cancelled while the suppression is still claimed', async () => {
    getState().maintenance = [
      windowRow({ id: 'mw-601', state: 'active' }),
      windowRow({
        id: 'mw-602',
        title: 'Zammad upgrade',
        scopeLabel: 'D03-01 Zammad — inst-helpdesk',
        state: 'scheduled',
      }),
    ];
    server.use(http.delete('/api/v1/admin/maintenance-windows/:id', hang));

    openAs('R1', '/governance/maintenance');
    render(<App />);

    const item = listItemOf(await screen.findByText('ERP upgrade'));
    fireEvent.click(within(item).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel window' }));

    // The confirmation cannot be dismissed while the cancellation is unacknowledged…
    expect(await within(dialog).findByText('Working…')).toBeDefined();
    // …and the row it belongs to is the only one that goes busy: a second window is untouched.
    // `hidden: true` because Radix hides the page behind the modal from the accessibility tree.
    const busy = within(item).getByRole('button', { name: 'Cancel', hidden: true });
    await waitFor(() => expect(busy.hasAttribute('disabled')).toBe(true));
    const other = listItemOf(screen.getByText('Zammad upgrade'));
    expect(
      within(other).getByRole('button', { name: 'Cancel', hidden: true }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('reports a refused cancellation above the register', async () => {
    getState().maintenance = [windowRow({ id: 'mw-603' })];
    server.use(
      http.delete('/api/v1/admin/maintenance-windows/:id', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/not-found',
            title: 'The window was already finished',
            status: 404,
            detail: 'No live maintenance window mw-603.',
            code: 'NOT_FOUND',
            fieldErrors: [],
            remediation: 'Refresh the list.',
          },
          { status: 404 },
        ),
      ),
    );

    openAs('R1', '/governance/maintenance');
    render(<App />);

    const item = listItemOf(await screen.findByText('ERP upgrade'));
    fireEvent.click(within(item).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel window' }));

    // A failed cancellation means suppression may still be in force: the page says so above the
    // register rather than closing the dialog as if the window had stopped.
    expect(await screen.findByText('The window was already finished')).toBeDefined();
    expect(screen.getByText(/No live maintenance window mw-603/)).toBeDefined();
  });

  it('does not repeat a platform-wide scope under its own title', async () => {
    getState().maintenance = [
      windowRow({
        id: 'mw-604',
        scope: 'platform',
        scopeLabel: 'Platform-wide',
        title: 'Platform-wide',
      }),
    ];

    openAs('R1', '/governance/maintenance');
    render(<App />);

    // A platform-wide window has no product to add, so the second line says nothing and is dropped.
    expect((await screen.findAllByText('Platform-wide')).length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('Platform-wide').length).toBe(1);
  });
});

describe('policy exceptions: rejection and non-conflict failures', () => {
  it('rejects a waiting exception and keeps who rejected it on screen', async () => {
    getState().policyExceptions = [exceptionRow()];

    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByText('Compose policy exceptions');

    const item = listItemOf(await screen.findByText(/Published port/));
    fireEvent.click(within(item).getByRole('button', { name: 'Reject' }));

    // A rejection is a decision, so it is shown in the same place an approval is — and the row, not
    // just the banner, names the second party who made it.
    expect(await screen.findByText('Published port · rejected')).toBeDefined();
    expect(await screen.findByText(/rejected by Sofia Almeida/)).toBeDefined();
  });

  it('reports a decision failure that is not a state conflict as an error', async () => {
    getState().policyExceptions = [exceptionRow()];
    server.use(
      http.post('/api/v1/admin/policy-exceptions/:id/:decision', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/internal',
            title: 'The platform refused the decision',
            status: 500,
            detail: 'The decision could not be recorded.',
            code: 'INTERNAL',
            fieldErrors: [],
            remediation: 'Retry, then report the failure with the exception id.',
          },
          { status: 500 },
        ),
      ),
    );

    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByText('Compose policy exceptions');

    const item = listItemOf(await screen.findByText(/Published port/));
    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }));

    // Only "already decided" is a conflict between two operators; anything else is a fault, and it
    // must not be dressed up as the calm, expected case.
    expect(await screen.findByText('The platform refused the decision')).toBeDefined();
    expect(screen.getByText(/The decision could not be recorded/)).toBeDefined();
  });
});

describe('maintenance screen for a role that may only read', () => {
  it('offers no schedule action to a role that cannot configure a window', async () => {
    getState().maintenance = [];
    getState().policyExceptions = [];

    openAs('R2', '/governance/maintenance');
    render(<App />);

    expect(await screen.findByText('No maintenance windows')).toBeDefined();
    // The empty register must not carry the one control a reader cannot use: the only schedule
    // control left on the page is the disabled one in the header.
    expect(screen.getAllByRole('button', { name: 'Schedule window' }).length).toBe(1);
    expect(screen.getByText('Policy exceptions are not readable for your role')).toBeDefined();
  });
});
