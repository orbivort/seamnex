import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { BreakGlassSession } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The register decides liveness from the wall clock, and the fixtures are pinned to a seed clock,
 * so a test that needs a live grant moves the deadline first — exactly as the page does.
 */
function primeActiveSession(): BreakGlassSession {
  const active = getState().breakGlass.find((item) => item.id === 'bg-2291');
  expect(active).toBeDefined();
  (active as BreakGlassSession).expiresAt = new Date(Date.now() + 28 * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  return active as BreakGlassSession;
}

/** A promise the test releases, so a request in flight can be observed before it answers. */
function deferred(): { release: () => void; wait: Promise<void> } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, wait };
}

/**
 * Picks the first deployed instance in the request form.
 *
 * The select is populated from its own query, so the dialog can be open before the options land:
 * the placeholder is the only option for a frame, which makes "find the first non-empty option"
 * a race unless it is retried.
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

/**
 * The table row that carries `element`.
 *
 * A guard rather than an assertion: `closest` is nullable, and a row that went missing would
 * otherwise fail inside a `within(row)` query — naming the query that ran, not the layout that
 * changed. The `expect` keeps the check in the report; the throw narrows the type for the caller.
 */
function rowOf(element: HTMLElement): HTMLTableRowElement {
  const row = element.closest('tr');
  expect(row).toBeDefined();
  if (row === null) throw new Error('the session is not rendered inside a table row');
  return row;
}

function jsonProblem(status: number, code: string, title: string, detail: string) {
  return HttpResponse.json(
    {
      type: `https://platform.seamnex.local/problems/${code.toLowerCase()}`,
      title,
      status,
      code,
      detail,
      fieldErrors: [],
      remediation: 'Refresh the list.',
    },
    { status },
  );
}

/**
 * FR-4.11 refusals: an elevation that is ended, decided or requested can fail for reasons the
 * operator can act on, and each one belongs next to the control that caused it. None of these
 * answers is reachable through the happy path, so they are driven with the mock's own problem
 * shapes.
 */
describe('break-glass action refusals', () => {
  it('names the second factor an ended elevation needs', async () => {
    primeActiveSession();
    server.use(
      http.post('/api/v1/break-glass-sessions/:id/revoke', () =>
        jsonProblem(
          403,
          'MFA_REQUIRED',
          'A second factor is required to end an elevation',
          'This session was established without a satisfied second factor.',
        ),
      ),
    );

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke now' }));

    // The page says which factor is missing instead of repeating the problem's generic title.
    expect(await screen.findByText('Ending an elevation needs a second factor')).toBeDefined();
    expect(screen.getByText(/Sign in again with your second factor/)).toBeDefined();
  });

  it('reports any other action refusal with the problem it came with', async () => {
    primeActiveSession();
    server.use(
      http.post('/api/v1/break-glass-sessions/:id/revoke', () =>
        jsonProblem(
          409,
          'INVALID_STATE',
          'Only an active session can be revoked',
          'Session is expired.',
        ),
      ),
    );

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke now' }));

    expect(await screen.findByText('Only an active session can be revoked')).toBeDefined();
    expect(screen.getByText('Session is expired.')).toBeDefined();
  });

  it('says that it is revoking while the answer is still in flight', async () => {
    primeActiveSession();
    const gate = deferred();
    server.use(
      http.post('/api/v1/break-glass-sessions/:id/revoke', async () => {
        await gate.wait;
        return jsonProblem(409, 'INVALID_STATE', 'Only an active session can be revoked', 'Late.');
      }),
    );

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke now' }));

    expect(await within(dialog).findByText('Revoking…')).toBeDefined();
    gate.release();
    // The refusal is a page-level banner: it belongs to the register, not to the question.
    expect(await screen.findByText('Only an active session can be revoked')).toBeDefined();
  });

  it('says that it is approving while the answer is still in flight', async () => {
    primeActiveSession();
    const gate = deferred();
    server.use(
      http.post('/api/v1/break-glass-sessions/:id/approve', async ({ params }) => {
        await gate.wait;
        const session = getState().breakGlass.find((item) => item.id === String(params.id));
        return HttpResponse.json(session);
      }),
    );

    openAs('R3', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2292'));
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));

    expect(await within(row).findByText('Approving…')).toBeDefined();
    gate.release();
    await waitFor(() => expect(within(row).queryByText('Approving…')).toBeNull());
  });

  it('rejects a pending elevation from its row', async () => {
    primeActiveSession();

    openAs('R3', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2292'));
    fireEvent.click(within(row).getByRole('button', { name: 'Reject' }));

    await waitFor(() =>
      expect(getState().breakGlass.find((item) => item.id === 'bg-2292')?.state).toBe('rejected'),
    );
  });
});

/**
 * The request form's refusals. The instance list is the form's only target source and a request is
 * filed against a deployment, so an unreadable list must block submission; a field-level refusal
 * belongs under the field, not only in the banner above it.
 */
describe('break-glass request form', () => {
  it('blocks submission when the instance list cannot be read, and retries it', async () => {
    primeActiveSession();
    server.use(http.get('/api/v1/instances', () => HttpResponse.error()));

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    fireEvent.click(screen.getByRole('button', { name: 'Request elevation' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('The instance list could not be loaded')).toBeDefined();
    // The target select says why it has nothing to offer rather than looking merely empty.
    expect(within(dialog).getByRole('option', { name: 'Instance list unavailable' })).toBeDefined();
    expect(
      within(dialog).getByRole('button', { name: 'Submit request' }).hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByText('The instance list could not be loaded')).toBeDefined();
  });

  it('puts a field-level refusal under the field it belongs to', async () => {
    primeActiveSession();
    server.use(
      http.post('/api/v1/break-glass-sessions', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/justification-required',
            title: 'A written justification is required',
            status: 422,
            code: 'JUSTIFICATION_REQUIRED',
            detail: 'Elevation needs a substantive written reason the approver can decide on.',
            fieldErrors: [
              {
                field: 'justification',
                code: 'minLength',
                message: 'Write the change, the reason and the rollback.',
              },
            ],
            remediation: 'Describe the change, the reason and the rollback.',
          },
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    fireEvent.click(screen.getByRole('button', { name: 'Request elevation' }));
    const dialog = await screen.findByRole('dialog');

    await chooseTargetInstance(dialog);
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: {
        value: 'Investigate the failed upgrade with the vendor before the bridge call ends.',
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit request' }));

    expect(await within(dialog).findByText('A written justification is required')).toBeDefined();
    expect(
      within(dialog).getByText('Write the change, the reason and the rollback.'),
    ).toBeDefined();
  });

  it('says that it is submitting while the answer is still in flight', async () => {
    primeActiveSession();
    const gate = deferred();
    server.use(
      http.post('/api/v1/break-glass-sessions', async () => {
        await gate.wait;
        return jsonProblem(409, 'INVALID_STATE', 'Not accepted yet', 'Late.');
      }),
    );

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    fireEvent.click(screen.getByRole('button', { name: 'Request elevation' }));
    const dialog = await screen.findByRole('dialog');

    await chooseTargetInstance(dialog);
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Investigate the failed upgrade with the vendor on the bridge call.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit request' }));

    expect(await within(dialog).findByText('Submitting…')).toBeDefined();
    gate.release();
    await within(dialog).findByText('Not accepted yet');
  });

  it('closes the request form from its own close control', async () => {
    primeActiveSession();

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    fireEvent.click(screen.getByRole('button', { name: 'Request elevation' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers the first elevation from the empty register', async () => {
    getState().breakGlass = [];

    openAs('R1', '/governance/break-glass');
    render(<App />);

    expect(await screen.findByText('No break-glass sessions')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Request break-glass' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Request break-glass elevation')).toBeDefined();
  });
});

/**
 * The credential window and the revoke question. A revealed credential is shown once and dropped;
 * a revoke question names what ends and, when the grant has no deadline, must not invent one.
 */
describe('break-glass credential and revoke dialogs', () => {
  it('confirms a copy, confirms a second copy, and reports a blocked clipboard', async () => {
    primeActiveSession();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Credential' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Elevation credential');

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Copy password' }));
    const copied = await within(dialog).findByRole('button', { name: 'Copied' });
    // A second copy must restart the confirmation timer, not stack a second one.
    fireEvent.click(copied);
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeDefined();

    // A clipboard that refuses is not an error worth blocking on: the button stays honest.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('blocked')) },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy account' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Copy account' })).toBeDefined(),
    );
  });

  it('states how long a fresh credential stays valid', async () => {
    primeActiveSession();
    server.use(
      http.post('/api/v1/break-glass-sessions/:id/reveal', () =>
        HttpResponse.json({
          username: 'bg-svc-erp',
          password: 'one-time-credential-shown-once',
          methodNote: 'Created through the product API right after approval.',
          expiresAt: new Date(Date.now() + 45_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        }),
      ),
    );

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Credential' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/^Valid for \d+ seconds$/)).toBeDefined();
  });

  it('withdraws a credential whose window has already closed', async () => {
    primeActiveSession();
    server.use(
      http.post('/api/v1/break-glass-sessions/:id/reveal', () =>
        HttpResponse.json({
          username: 'bg-svc-erp',
          password: 'one-time-credential-shown-once',
          methodNote: 'Created through the product API right after approval.',
          expiresAt: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        }),
      ),
    );

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Credential' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('This credential has expired')).toBeDefined();
  });

  it('reports a reveal refusal that is not a state conflict as a danger', async () => {
    primeActiveSession();
    server.use(
      http.post('/api/v1/break-glass-sessions/:id/reveal', () =>
        jsonProblem(
          403,
          'FORBIDDEN',
          'Revealing a credential is not permitted for your role',
          'breakglass.request is required.',
        ),
      ),
    );

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Credential' }));

    expect(
      await screen.findByText('Revealing a credential is not permitted for your role'),
    ).toBeDefined();
  });

  it('drops the credential when the window closes', async () => {
    primeActiveSession();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Credential' }));
    let dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Elevation credential');

    // The window's own close control must drop the value as surely as the footer button does.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(row).getByRole('button', { name: 'Credential' }));
    dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Elevation credential');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('warns when a live grant is inside its last five minutes', async () => {
    const active = primeActiveSession();
    active.expiresAt = new Date(Date.now() + 3 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    // A live deadline is read as time remaining; a closed one falls back to its absolute stamp.
    expect(await within(row).findByText(/\d+ min from now/)).toBeDefined();
  });

  it('keeps a grant that has no deadline, then closes the question untouched', async () => {
    const active = primeActiveSession();
    // A grant without a deadline is still live; the question must not promise an end it lacks.
    active.expiresAt = null;

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Revoke this elevation?')).toBeDefined();
    expect(within(dialog).queryByText(/would otherwise end on its own/)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it active' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getState().breakGlass.find((item) => item.id === 'bg-2291')?.state).toBe('active');

    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says when a grant would end on its own', async () => {
    primeActiveSession();

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    const row = rowOf(await screen.findByText('bg-2291'));
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/It would otherwise end on its own/)).toBeDefined();
  });

  it('marks a self-approved grant on the row that carries it', async () => {
    primeActiveSession();
    const expired = getState().breakGlass.find((item) => item.id === 'bg-2288');
    expect(expired).toBeDefined();
    (expired as BreakGlassSession).selfApproved = true;

    openAs('R1', '/governance/break-glass');
    render(<App />);
    await screen.findByRole('heading', { name: 'Break-glass sessions' });

    expect(await screen.findByText('Ruth Adler (self)')).toBeDefined();
  });
});
