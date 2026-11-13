import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * FR-4.11: elevation is per task, justified in writing and approved by a second party. A session
 * that is not active cannot reveal a credential, a read-write request needs the domain owner, and
 * revocation is what ends the elevation early.
 *
 * The fixtures are pinned to a seed clock, and the page decides liveness from the wall clock, so
 * every test that needs a live grant moves the deadline into the future first.
 */
function primeActiveSession(): void {
  const active = getState().breakGlass.find((item) => item.id === 'bg-2291');
  if (active) active.expiresAt = new Date(Date.now() + 28 * 60_000).toISOString();
}

/**
 * Picks the first deployed instance in the request form.
 *
 * The select fills from its own query, so the dialog can be open while the placeholder is still
 * the only option: a single read of the options is a race, and on a loaded CI runner it returns
 * the placeholder alone — which used to fail as `undefined.value` rather than as a slow list.
 */
async function chooseTargetInstance(dialog: HTMLElement): Promise<void> {
  const target = await waitFor(() => {
    const options = within(dialog).getAllByRole('option') as HTMLOptionElement[];
    const found = options.find((option) => option.value !== '');
    if (!found) throw new Error('the instance list has not loaded yet');
    return found;
  });
  fireEvent.change(within(dialog).getByLabelText(/Target instance/), {
    target: { value: target.value },
  });
}

describe('break-glass sessions', () => {
  it('opens on the elevation history with its counts', async () => {
    primeActiveSession();

    openAs('R1', '/governance/break-glass');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Break-glass sessions' })).toBeDefined();
    expect(await screen.findByText('1 active')).toBeDefined();
    expect(screen.getByText('1 awaiting approval')).toBeDefined();
    expect(await screen.findByText('bg-2291')).toBeDefined();
  });

  it('reports the state of every recorded elevation', async () => {
    primeActiveSession();

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    expect(await screen.findByText('Active')).toBeDefined();
    expect(screen.getByText('Requested')).toBeDefined();
    expect(screen.getByText('Expired')).toBeDefined();
    expect(screen.getByText('Revoked')).toBeDefined();
  });

  it('requests an elevation with a written justification', async () => {
    primeActiveSession();

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });
    const before = getState().breakGlass.length;

    fireEvent.click(screen.getByRole('button', { name: 'Request elevation' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Request break-glass elevation')).toBeDefined();

    await chooseTargetInstance(dialog);
    fireEvent.click(within(dialog).getByRole('radio', { name: /Read-write/ }));
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: {
        value: 'Investigate the failed upgrade with the vendor on the bridge before the call ends.',
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit request' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getState().breakGlass.length).toBe(before + 1);
    expect(getState().breakGlass[0]?.state).toBe('requested');
  });

  it('holds the submit button until the justification is long enough', async () => {
    primeActiveSession();

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    fireEvent.click(screen.getByRole('button', { name: 'Request elevation' }));
    const dialog = await screen.findByRole('dialog');
    await chooseTargetInstance(dialog);
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'too short' },
    });

    expect(
      within(dialog).getByRole('button', { name: 'Submit request' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(within(dialog).getByText('Add more detail.')).toBeDefined();
  });

  it('lets the domain owner approve a read-write request', async () => {
    primeActiveSession();

    openAs('R3', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = present((await screen.findByText('bg-2292')).closest('tr'), 'the bg-2292 row');
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(getState().breakGlass.find((item) => item.id === 'bg-2292')?.state).toBe('active'),
    );
  });

  it('refuses to let an auditor approve a read-write elevation', async () => {
    primeActiveSession();

    openAs('R2', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = present((await screen.findByText('bg-2292')).closest('tr'), 'the bg-2292 row');
    expect(within(row).getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('reveals a credential once for an active elevation', async () => {
    primeActiveSession();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = present((await screen.findByText('bg-2291')).closest('tr'), 'the bg-2291 row');
    fireEvent.click(within(row).getByRole('button', { name: 'Credential' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Elevation credential')).toBeDefined();
    expect(await within(dialog).findByText('one-time-credential-shown-once')).toBeDefined();
    // The mock's reveal deadline is seeded, so the honest outcome is one of the two states.
    expect(
      within(dialog).getByText(/Valid for \d+ seconds|This credential has expired/),
    ).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy password' }));
    expect(await within(dialog).findByText('Copied')).toBeDefined();
  });

  it('revokes an active elevation after a confirmation', async () => {
    primeActiveSession();

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = present((await screen.findByText('bg-2291')).closest('tr'), 'the bg-2291 row');
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Revoke this elevation?')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke now' }));

    await waitFor(() =>
      expect(getState().breakGlass.find((item) => item.id === 'bg-2291')?.state).toBe('revoked'),
    );
  });

  it('reports a refusal to reveal an elevation that is no longer active', async () => {
    primeActiveSession();
    server.use(
      http.post('/api/v1/break-glass-sessions/:id/reveal', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/state-conflict',
            title: 'The elevation is not active',
            status: 409,
            detail: 'break-glass session bg-2291 is no longer active.',
            code: 'STATE_CONFLICT',
            fieldErrors: [],
            remediation: 'Request a new elevation.',
          },
          { status: 409 },
        ),
      ),
    );

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = present((await screen.findByText('bg-2291')).closest('tr'), 'the bg-2291 row');
    fireEvent.click(within(row).getByRole('button', { name: 'Credential' }));

    expect(await screen.findByText('The elevation is not active')).toBeDefined();
  });

  it('offers the first elevation from the empty register', async () => {
    getState().breakGlass = [];

    openAs('R1', '/governance/break-glass');
    render(<App />);

    expect(await screen.findByText('No break-glass sessions')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Request break-glass' })).toBeDefined();
  });

  it('reports an unreadable register as a problem, not as an empty history', async () => {
    server.use(http.get('/api/v1/break-glass-sessions', () => HttpResponse.error()));

    openAs('R1', '/governance/break-glass');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No break-glass sessions')).toBeNull();
  });
});
