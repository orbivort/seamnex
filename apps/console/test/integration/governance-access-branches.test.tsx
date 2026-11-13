import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { AccessRequest } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The two decision scopes, the reject path and the refusals.
 *
 * The queue has two halves that the default view never shows: a decision that is refused (the row
 * must not stay looking decided) and the "Decided" scope (a row whose decider is unknown must say
 * so rather than print nothing). Neither is reachable from the open queue, so they are driven here.
 */
describe('access request decisions', () => {
  it('rejects a request and records the rejection on the row', async () => {
    openAs('R1', '/governance/access-requests');
    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Reject request \S+ from Lena Hoff/i }),
    );

    const dialog = await screen.findByRole('dialog');
    // The question and its consequence differ from approval: nothing is granted.
    expect(within(dialog).getByText('Reject this request?')).toBeDefined();
    expect(within(dialog).getByText(/nothing is granted/i)).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject request' }));

    expect(await screen.findByText(/Nothing is waiting for a decision/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    const row = (await screen.findByText('Lena Hoff')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Rejected')).toBeDefined();
  });

  it('keeps a refused decision out of the row and reports it in the dialog', async () => {
    server.use(
      http.post('/api/v1/admin/access-requests/:id/approve', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/state-conflict',
            title: 'The request was already decided',
            status: 409,
            detail: 'ar-3204 is approved; a second decision would rewrite the decider.',
            code: 'STATE_CONFLICT',
            fieldErrors: [],
            remediation: 'Reload the queue.',
          },
          { status: 409 },
        ),
      ),
    );

    openAs('R1', '/governance/access-requests');
    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Approve request \S+ from Lena Hoff/i }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and grant' }));

    // The refusal is read where the decision was made, and the dialog stays open.
    expect(await within(dialog).findByText('The request was already decided')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The optimistic guess was rolled back: the row is still open and still decidable.
    const row = screen.getByText('Lena Hoff').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Open')).toBeDefined();
    expect(
      screen.getByRole('button', { name: /Approve request \S+ from Lena Hoff/i }),
    ).toBeDefined();
  });

  it('closes the question without deciding anything', async () => {
    openAs('R1', '/governance/access-requests');
    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Approve request \S+ from Lena Hoff/i }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Nothing was sent: the row is still open and still offers its buttons.
    expect(
      screen.getByRole('button', { name: /Approve request \S+ from Lena Hoff/i }),
    ).toBeDefined();
  });

  it('lists the decided rows under their own scope', async () => {
    openAs('R1', '/governance/access-requests');
    render(<App />);
    await screen.findByText('Lena Hoff');

    fireEvent.click(screen.getByRole('button', { name: 'Decided' }));

    // Only decided rows remain, and the open one leaves.
    expect(await screen.findByText('Iris Nwosu')).toBeDefined();
    expect(screen.getByText('Diego Salas')).toBeDefined();
    expect(screen.queryByText('Lena Hoff')).toBeNull();
  });

  it('names an unknown decider instead of leaving the cell blank', async () => {
    const decided = getState().accessRequests.find((item) => item.id === 'ar-3203');
    expect(decided).toBeDefined();
    (decided as AccessRequest).decidedBy = null;
    (decided as AccessRequest).decidedAt = null;

    openAs('R1', '/governance/access-requests');
    render(<App />);
    await screen.findByText('Lena Hoff');

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    const row = (await screen.findByText('Iris Nwosu')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Unknown decider')).toBeDefined();
  });
});

/**
 * The empty queue is two different facts — "nothing has ever been requested" and "nothing matches
 * this view" — and only the second one is a filter the operator can undo. Both empty states carry
 * a different next step, so both are driven.
 */
describe('access request empty states', () => {
  it('explains an empty queue and hides the decision controls', async () => {
    getState().accessRequests = [];

    openAs('R1', '/governance/access-requests');
    render(<App />);

    expect(await screen.findByText('No access requests yet')).toBeDefined();
    expect(screen.getByText('0 requests')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Approve request/i })).toBeNull();
  });

  it('offers a way back from a filter that matches nothing', async () => {
    const open = getState().accessRequests.find((item) => item.state === 'open');
    expect(open).toBeDefined();
    getState().accessRequests = [open as AccessRequest];

    openAs('R1', '/governance/access-requests');
    render(<App />);
    await screen.findByText('Lena Hoff');

    fireEvent.click(screen.getByRole('button', { name: 'Decided' }));

    expect(await screen.findByText('No request matches this view')).toBeDefined();
    // Singular: the count is part of the sentence, and "1 requests exist" reads as a bug.
    expect(screen.getByText(/1 request exists/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Show all requests' }));

    expect(await screen.findByText('Lena Hoff')).toBeDefined();
  });

  it('waits for the server to name the decider when the session is unknown', async () => {
    /*
     * The optimistic row prints a decider, so without the session identity the row must not be
     * guessed at all — the honest fallback is the server's answer. This is the only way to reach
     * that arm: with a readable `/me`, every decision is guessed first.
     */
    server.use(http.get('/api/v1/me', () => HttpResponse.error()));

    openAs('R1', '/governance/access-requests');
    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Approve request \S+ from Lena Hoff/i }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and grant' }));

    expect(await screen.findByText(/Nothing is waiting for a decision/i)).toBeDefined();
  });
});

/**
 * The audit trail's two secondary paths: the export range and the cursor page. Both are about the
 * chain the reader is looking at, so an empty page must export nothing and a page still in flight
 * must say so rather than look idle.
 */
describe('audit trail range and paging', () => {
  it('exports nothing when the filters leave no rows to describe a range', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: 'nobody-matches-this' } });
    expect(await screen.findByText('No audit events match these filters')).toBeDefined();

    const before = getState().audit.length;
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(false),
    );
    // An export appends its own audit record; nothing was appended, so nothing was requested.
    expect(getState().audit.length).toBe(before);
    expect(screen.queryByText('The platform API could not be reached')).toBeNull();
  });

  it('reports a page that is still loading before it renders it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    server.use(
      http.get('/api/v1/audit-events', async ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor === null) {
          return HttpResponse.json({ items: [], nextCursor: '25', total: 26 });
        }
        await gate;
        return HttpResponse.json({ items: [], nextCursor: null, total: 26 });
      }),
    );

    openAs('R1', '/governance/audit');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Load \d+ more/ }));

    expect(await screen.findByText('Loading…')).toBeDefined();
    release();
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  });

  it('closes the proof drawer without leaving the sequence armed', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    fireEvent.click(await screen.findByRole('button', { name: 'Verify chain' }));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('SHA-256 hash chain');

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close panel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reports a proof that does not verify as a broken chain', async () => {
    const hash = `sha256:${'a'.repeat(64)}`;

    server.use(
      http.get('/api/v1/audit-events/:seq/proof', ({ params }) =>
        HttpResponse.json({
          seq: Number.parseInt(String(params.seq), 10),
          hash,
          prevHash: `sha256:${'b'.repeat(64)}`,
          algorithm: 'SHA-256 hash chain',
          chainValid: false,
          verifiedAt: '2026-10-22T08:07:00Z',
          anchoredDay: '2026-10-22',
          anchorSignature: 'age1qpzry9x8gf2tvdw0s3jn54khce6mua7l',
          path: [
            { seq: 1, hash },
            { seq: 2, hash },
          ],
        }),
      ),
    );

    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    fireEvent.click(await screen.findByRole('button', { name: 'Verify chain' }));
    const drawer = await screen.findByRole('dialog');

    expect(await within(drawer).findByText('No')).toBeDefined();
    expect(within(drawer).getByText('Chain valid')).toBeDefined();
  });
});
