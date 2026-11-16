import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * FR-4.9 / NFR-4.15. A maintenance window suppresses alert delivery for its whole span and a
 * cancelled one stops suppressing at once; a policy exception needs a second party, and the
 * requester never decides their own.
 *
 * Exception expiry is judged against the wall clock, so a decision test states its own deadline
 * rather than relying on the fixture's seed-relative one.
 */
/**
 * Moves the fixture's pending exception into the future (or the past) so the page's wall-clock
 * expiry verdict is the one the test intends, without inventing a record the contract would reject.
 */
function primePending(
  expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString(),
): void {
  const pending = getState().policyExceptions.find((item) => item.id === 'pe-105');
  if (!pending) throw new Error('the pending exception fixture is missing');
  pending.state = 'requested';
  pending.approver = null;
  pending.expiresAt = expiresAt;
}

describe('maintenance windows', () => {
  it('lists the windows with the state the platform clock decides', async () => {
    openAs('R1', '/governance/maintenance');
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Maintenance and policy exceptions' }),
    ).toBeDefined();
    expect(await screen.findByText(/^\d+ active$/)).toBeDefined();
    expect(await screen.findByText('Nextcloud Hub 31.0.4 upgrade')).toBeDefined();
    expect(screen.getByText('alerts suppressed')).toBeDefined();
    expect(screen.getByText('Scheduled')).toBeDefined();
  });

  it('cancels an active window and shows that suppression stopped', async () => {
    const live = present(
      getState().maintenance.find((entry) => entry.id === 'mw-441'),
      'the mw-441 maintenance window',
    );
    // The fixture is seeded relative to a fixed date; make it live for this test.
    live.state = 'active';
    live.startsAt = new Date(Date.now() - 60_000).toISOString();
    live.endsAt = new Date(Date.now() + 3_600_000).toISOString();

    openAs('R1', '/governance/maintenance');
    render(<App />);
    const item = present(
      (await screen.findByText('Nextcloud Hub 31.0.4 upgrade')).closest('li'),
      'the Nextcloud maintenance item',
    );
    fireEvent.click(within(item).getByRole('button', { name: 'Cancel' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cancel this maintenance window?')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel window' }));

    await waitFor(() =>
      expect(getState().maintenance.find((entry) => entry.id === 'mw-441')?.state).toBe(
        'completed',
      ),
    );
    expect(await screen.findByText('Cancelled')).toBeDefined();
    expect(screen.queryByText('alerts suppressed')).toBeNull();
  });

  it('schedules a platform-wide window after naming the work', async () => {
    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByRole('heading', { name: 'Maintenance and policy exceptions' });
    const before = getState().maintenance.length;

    fireEvent.click(screen.getByRole('button', { name: 'Schedule window' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Schedule a maintenance window')).toBeDefined();

    fireEvent.change(within(dialog).getByLabelText(/^Scope/), {
      target: { value: 'Quarterly database maintenance' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Starts/), {
      target: { value: '2027-12-01T22:00' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Ends/), {
      target: { value: '2027-12-02T02:00' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule window' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getState().maintenance.length).toBe(before + 1);
  });

  it('refuses a window that ends before it starts', async () => {
    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByRole('heading', { name: 'Maintenance and policy exceptions' });

    fireEvent.click(screen.getByRole('button', { name: 'Schedule window' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Scope/), {
      target: { value: 'Backwards window' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Starts/), {
      target: { value: '2027-12-02T02:00' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Ends/), {
      target: { value: '2027-12-01T22:00' },
    });

    expect(await screen.findByText('The window must end after it starts.')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(
      within(dialog).getByRole('button', { name: 'Schedule window' }).hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('compose policy exceptions', () => {
  it('lists the exceptions and refuses them by default', async () => {
    primePending();

    openAs('R1', '/governance/maintenance');
    render(<App />);

    expect(await screen.findByText('Compose policy exceptions')).toBeDefined();
    expect(await screen.findByText('awaiting second party')).toBeDefined();
    expect(screen.getAllByText('requested by Priya Raman').length).toBeGreaterThan(0);
  });

  it('approves a waiting exception and keeps the decision on screen', async () => {
    primePending();

    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByText('Compose policy exceptions');

    const item = present(
      (await screen.findByText(/Unpinned image/)).closest('li'),
      'the unpinned image exception item',
    );
    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Unpinned image · approved')).toBeDefined();
    expect(screen.getByText(/Decided by Sofia Almeida/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Unpinned image · approved')).toBeNull());
  });

  it('reports a refused decision instead of showing the old state as decided', async () => {
    primePending();
    server.use(
      http.post('/api/v1/admin/policy-exceptions/:id/:decision', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/state-conflict',
            title: 'This exception was already decided',
            status: 409,
            detail: 'pe-105 is approved.',
            code: 'STATE_CONFLICT',
            fieldErrors: [],
            remediation: 'Reload the register.',
          },
          { status: 409 },
        ),
      ),
    );

    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByText('Compose policy exceptions');

    const item = present(
      (await screen.findByText(/Unpinned image/)).closest('li'),
      'the unpinned image exception item',
    );
    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('This exception was already decided')).toBeDefined();
  });

  it('explains a late decision on an expired exception', async () => {
    primePending(new Date(Date.now() - 86_400_000).toISOString());

    openAs('R1', '/governance/maintenance');
    render(<App />);

    expect(
      await screen.findByText(/Past its expiry, so the API refuses a late decision/),
    ).toBeDefined();
    expect(screen.getByText('expired undecided')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  /*
   * FR-1.20 / NFR-4.15 / AC-33: the half of the flow that did not exist. An R1 files the request; the
   * queue shows it awaiting a second party, and the same person may not approve it.
   */
  it('files an exception for one product and shows it awaiting a second party', async () => {
    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByText('Compose policy exceptions');

    fireEvent.click(screen.getByRole('button', { name: 'Request exception' }));
    const dialog = await screen.findByRole('dialog');
    // The product list is a query; the control stays disabled until it answers, so the test waits for
    // the same thing an operator does. A change fired at a disabled select is dropped by React.
    const product = within(dialog).getByLabelText(/Product/) as HTMLSelectElement;
    await waitFor(() => expect(product.disabled).toBe(false));
    fireEvent.change(product, { target: { value: 'D02-01' } });
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'The vendor image has no pinned release until the next quarter.' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Expires on/), {
      target: { value: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) },
    });
    expect((within(dialog).getByLabelText(/Product/) as HTMLSelectElement).value).toBe('D02-01');
    expect(
      (within(dialog).getByLabelText(/Justification/) as HTMLTextAreaElement).value.length,
    ).toBeGreaterThan(20);
    expect((within(dialog).getByLabelText(/Expires on/) as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    const submit = within(dialog).getByRole('button', { name: 'Request exception' });
    expect((submit as HTMLButtonElement).disabled, 'the request must be submittable').toBe(false);
    fireEvent.click(submit);

    // The dialog closes only on success, so its absence means the server accepted the request.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const filed = present(
      getState().policyExceptions.find((item) => item.scope === 'D02-01'),
      'the filed exception',
    );
    expect(filed.state).toBe('requested');
    expect(filed.rule).toBe('privileged');
    // The register names the rule the way a person reads it, and shows the request as undecided.
    expect(await screen.findByText('D02-01')).toBeDefined();
    expect(await screen.findByText(/Privileged mode/)).toBeDefined();
    expect(screen.getAllByText('awaiting second party').length).toBeGreaterThan(0);
  });

  it('refuses a past or over-long expiry before the round trip', async () => {
    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByText('Compose policy exceptions');

    fireEvent.click(screen.getByRole('button', { name: 'Request exception' }));
    const dialog = await screen.findByRole('dialog');
    const expiry = within(dialog).getByLabelText(/Expires on/) as HTMLInputElement;
    const justification = within(dialog).getByLabelText(/Justification/) as HTMLTextAreaElement;
    fireEvent.change(justification, {
      target: { value: 'The vendor image has no pinned release until the next quarter.' },
    });

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    fireEvent.change(expiry, { target: { value: yesterday } });
    // An expired exception blocks the next deployment, so the form refuses to file one.
    expect(within(dialog).getByText('Choose a future date.')).toBeDefined();

    // A quarter is the ceiling the API enforces; the form says so before the round trip.
    const farFuture = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    fireEvent.change(expiry, { target: { value: farFuture } });
    expect(within(dialog).getByText('At most 90 days ahead.')).toBeDefined();
  });

  it('shows the server refusal inside the dialog and keeps it open', async () => {
    server.use(
      http.post('/api/v1/admin/policy-exceptions', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/state-conflict',
            title: 'An exception already covers this rule',
            status: 409,
            detail: 'Exception pe-104 is approved for D02-01.',
            code: 'STATE_CONFLICT',
            fieldErrors: [],
            remediation: 'Use the existing exception.',
          },
          { status: 409 },
        ),
      ),
    );

    openAs('R1', '/governance/maintenance');
    render(<App />);
    await screen.findByText('Compose policy exceptions');

    fireEvent.click(screen.getByRole('button', { name: 'Request exception' }));
    const dialog = await screen.findByRole('dialog');
    const product = within(dialog).getByLabelText(/Product/) as HTMLSelectElement;
    await waitFor(() => expect(product.disabled).toBe(false));
    fireEvent.change(product, { target: { value: 'D02-01' } });
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'The vendor image has no pinned release until the next quarter.' },
    });
    const submit = within(dialog).getByRole('button', { name: 'Request exception' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);

    expect(await screen.findByText('An exception already covers this rule')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('hides the exception request from a role that may not file one', async () => {
    openAs('R3', '/governance/maintenance');
    render(<App />);
    await screen.findByText('Compose policy exceptions');

    // NFR-4.15: R1 requests and a second party decides. The domain owner approves, and cannot file.
    expect(screen.getByRole('button', { name: 'Request exception' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('hides the window register from a role that may not read settings', async () => {
    openAs('R3', '/governance/maintenance');
    render(<App />);

    expect(
      await screen.findByText('The maintenance window register is not readable for your role'),
    ).toBeDefined();
    // The domain owner still decides exceptions.
    expect(await screen.findByText('Compose policy exceptions')).toBeDefined();
  });

  it('hides the exception register from an auditor', async () => {
    openAs('R2', '/governance/maintenance');
    render(<App />);

    expect(
      await screen.findByText('Policy exceptions are not readable for your role'),
    ).toBeDefined();
    expect(await screen.findByText('Scheduled and active windows')).toBeDefined();
  });

  it('explains empty registers rather than rendering bare panels', async () => {
    getState().maintenance = [];
    getState().policyExceptions = [];

    openAs('R1', '/governance/maintenance');
    render(<App />);

    expect(await screen.findByText('No maintenance windows')).toBeDefined();
    expect(screen.getByText('No compose policy exceptions')).toBeDefined();
  });

  it('reports an unreadable window register without an empty-state claim', async () => {
    server.use(http.get('/api/v1/admin/maintenance-windows', () => HttpResponse.error()));

    openAs('R1', '/governance/maintenance');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No maintenance windows')).toBeNull();
  });
});
