import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { PrivacyRequest } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * NFR-4.13 / FR-4.3: a data-subject request is addressed by its pseudonymous reference, advanced
 * one scope at a time, and closed only when every scope reported completion. The screen has to
 * distinguish "nothing selected" from "nothing recorded" and must not let an operator open a
 * request without a reference.
 */
function request(overrides: Partial<PrivacyRequest> = {}): PrivacyRequest {
  return {
    id: 'pr-9999',
    subjectRef: 'sub_test',
    kind: 'export',
    state: 'open',
    openedBy: 'Sofia Almeida',
    openedAt: '2026-10-01T09:00:00.000Z',
    dueAt: '2026-11-01T09:00:00.000Z',
    closedAt: null,
    scopes: [],
    evidence: [],
    ...overrides,
  } as PrivacyRequest;
}

describe('privacy request queue', () => {
  it('opens on the queue with the selected request scopes beside it', async () => {
    openAs('R1', '/governance/privacy');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Privacy requests' })).toBeDefined();
    const requests = getState().privacy;
    expect(await screen.findByText(`${requests.length} requests`)).toBeDefined();
    expect(
      screen.getByText(`${requests.filter((item) => item.state !== 'complete').length} open`),
    ).toBeDefined();

    const first = present(requests[0], 'a privacy request');
    expect(await screen.findByText(`Scopes for ${first.subjectRef}`)).toBeDefined();
    expect(screen.getByText('Subject reference')).toBeDefined();
  });

  it('advances one scope and reports the new progress', async () => {
    openAs('R1', '/governance/privacy');
    render(<App />);
    await screen.findByRole('heading', { name: 'Privacy requests' });

    const advanceButton = await screen.findByRole('button', { name: 'Advance scope' });
    fireEvent.click(advanceButton);

    expect(await screen.findByText(/pr-\d+ advanced/)).toBeDefined();
    expect(screen.getByText(/scopes complete\./)).toBeDefined();
  });

  it('closes the request once the last scope completes', async () => {
    getState().privacy = [
      request({
        id: 'pr-9001',
        scopes: [
          {
            scopeType: 'platform',
            scopeId: 'idp_user',
            label: 'Identity-provider record',
            state: 'pending',
            detail: 'Profile.',
          },
        ],
      }),
    ];

    openAs('R1', '/governance/privacy');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Advance scope' }));

    expect(await screen.findByText('pr-9001 advanced')).toBeDefined();
    expect(await screen.findByText('complete')).toBeDefined();
    // A completed request has nothing left to advance.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Advance scope' })).toBeNull());
  });

  it('reports a refused advance next to the control', async () => {
    server.use(
      http.post('/api/v1/privacy/requests/:id/advance', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/invalid-state',
            title: 'This request is already complete',
            status: 409,
            detail: 'Request pr-4102 is complete.',
            code: 'INVALID_STATE',
            fieldErrors: [],
            remediation: 'Open another request.',
          },
          { status: 409 },
        ),
      ),
    );

    openAs('R1', '/governance/privacy');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Advance scope' }));

    expect(await screen.findByText('This request is already complete')).toBeDefined();
  });

  it('opens a request by subject reference and selects the new one', async () => {
    openAs('R1', '/governance/privacy');
    render(<App />);
    await screen.findByRole('heading', { name: 'Privacy requests' });

    fireEvent.click(screen.getByRole('button', { name: 'Open request' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Open request' });
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Subject reference/), {
      target: { value: 'sub_44c1' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Request kind/), {
      target: { value: 'delete' },
    });

    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false));
    fireEvent.click(submit);

    expect(await screen.findByText(/pr-\d+ advanced|Scopes for/)).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getState().privacy[0]?.subjectRef).toBe('sub_44c1');
    expect(getState().privacy[0]?.kind).toBe('delete');
  });

  it('shows the API field error instead of a generic failure for a malformed reference', async () => {
    openAs('R1', '/governance/privacy');
    render(<App />);
    await screen.findByRole('heading', { name: 'Privacy requests' });

    fireEvent.click(screen.getByRole('button', { name: 'Open request' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Subject reference/), {
      target: { value: 'Sofia Almeida' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open request' }));

    // The client validates the body against the contract before it leaves the browser, and the
    // field error is attached to the input that caused it.
    expect(
      await screen.findByText('The request does not match the platform contract'),
    ).toBeDefined();
    expect(
      (
        await screen.findAllByText(
          /Use the opaque subject reference from the identity-provider export/i,
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('warns when a closed record still has outstanding scopes', async () => {
    getState().privacy = [
      request({
        state: 'complete',
        scopes: [
          {
            scopeType: 'platform',
            scopeId: 'audit_event',
            label: 'Audit events',
            state: 'pending',
            detail: 'Never reported.',
          },
        ],
      }),
    ];

    openAs('R1', '/governance/privacy');
    render(<App />);

    expect(await screen.findByText('Closed with scopes still outstanding')).toBeDefined();
    expect(screen.getByText(/never reported completion/i)).toBeDefined();
  });

  it('says a request with no scope has nothing to advance', async () => {
    getState().privacy = [request()];

    openAs('R1', '/governance/privacy');
    render(<App />);

    expect(
      await screen.findByText(
        /No scope is recorded for this request, so there is nothing to advance/i,
      ),
    ).toBeDefined();
    expect(screen.getByText('No step recorded yet.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Advance scope' })).toBeNull();
  });

  it('distinguishes an empty queue from an unselected request', async () => {
    getState().privacy = [];

    openAs('R1', '/governance/privacy');
    render(<App />);

    expect(await screen.findByText('No privacy requests')).toBeDefined();
    expect(screen.getByText('Nothing selected')).toBeDefined();
  });

  it('is a read-only queue for an auditor', async () => {
    openAs('R2', '/governance/privacy');
    render(<App />);

    expect(await screen.findByText('Read-only privacy queue')).toBeDefined();
    const open = await screen.findByRole('button', { name: 'Open request' });
    expect(open.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Advance scope' })).toBeNull();
  });

  it('reports an unreadable queue as a problem panel', async () => {
    server.use(http.get('/api/v1/privacy/requests', () => HttpResponse.error()));

    openAs('R1', '/governance/privacy');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No privacy requests')).toBeNull();
  });
});
