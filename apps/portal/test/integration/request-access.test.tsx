import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';
import { problemResponse } from '../problem-response';

function openRequests(): void {
  openAs('R5', 'degraded', '/entitlements');
  render(<App />);
}

async function openRequestDialog(): Promise<HTMLElement> {
  openRequests();
  fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
  return screen.findByRole('dialog');
}

async function chooseFirstProduct(dialog: HTMLElement): Promise<string> {
  const select = (await within(dialog).findByRole('combobox', {
    name: /Product/,
  })) as HTMLSelectElement | null;
  if (select === null) throw new Error('the request dialog lists no products');
  const option = Array.from(select.options).find((item) => item.value !== '');
  if (option === undefined) throw new Error('the request dialog has no selectable product');
  fireEvent.change(select, { target: { value: option.value } });
  return option.value;
}

describe('request access', () => {
  it('lists the products the role does not hold, with owner and guarantee class', async () => {
    const dialog = await openRequestDialog();

    const select = (await within(dialog).findByRole('combobox', {
      name: /Product/,
    })) as HTMLSelectElement | null;
    expect(select).not.toBeNull();

    await chooseFirstProduct(dialog);

    expect(within(dialog).getByText(/^owner /)).toBeDefined();
    expect(within(dialog).getByText(/^role: /)).toBeDefined();
    expect(within(dialog).getAllByText(/Single sign-on|Sign-in required/).length).toBeGreaterThan(
      0,
    );
  });

  it('requires a justification of at least ten characters', async () => {
    const dialog = await openRequestDialog();
    const submit = within(dialog).getByRole('button', { name: 'Send request' });

    await chooseFirstProduct(dialog);
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    const justification = within(dialog).getByLabelText(/Justification/);
    fireEvent.change(justification, { target: { value: 'short' } });

    expect(within(dialog).getByText('Use at least 10 characters.')).toBeDefined();
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(justification, {
      target: { value: 'Need read access to the supplier contract archive for the Q4 renewal.' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the request, then reports the open ticket and closes cleanly', async () => {
    const dialog = await openRequestDialog();
    await chooseFirstProduct(dialog);
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Need read access to the supplier contract archive for the Q4 renewal.' },
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

    expect(await within(dialog).findByText(/is open/)).toBeDefined();
    expect(within(dialog).getByText(/Awaiting a decision from the domain owner/)).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: 'Send request' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says when there is nothing left to request', async () => {
    server.use(
      http.get('/api/v1/portal/requestable', () =>
        HttpResponse.json([
          {
            entryKey: 'D02-01',
            domain: 'Marketing Automation',
            product: 'Mautic',
            description: 'Marketing automation.',
            guaranteeClass: 'fa_header',
            productRole: 'member',
            owner: 'Mara Vogel',
            requested: true,
            requestedAt: '2026-11-01T08:00:00.000Z',
          },
        ]),
      ),
    );

    const dialog = await openRequestDialog();

    expect(await within(dialog).findByText('Nothing left to request')).toBeDefined();
    expect(within(dialog).queryByRole('combobox', { name: /Product/ })).toBeNull();
  });

  it('reports a failed listing with a retry', async () => {
    server.use(
      http.get('/api/v1/portal/requestable', () =>
        problemResponse(
          503,
          'CATALOG_UNAVAILABLE',
          'Requestable products unavailable',
          'The catalog could not be read.',
        ),
      ),
    );

    const dialog = await openRequestDialog();

    expect(await within(dialog).findByText('Requestable products unavailable')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: /Retry/i }));
    expect(await within(dialog).findByText('Requestable products unavailable')).toBeDefined();
  });

  it('closes from the dialog chrome and clears the form', async () => {
    const dialog = await openRequestDialog();
    await chooseFirstProduct(dialog);
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'A reason that is long enough to send.' },
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports a request in flight before the id exists', async () => {
    server.use(
      http.post('/api/v1/admin/access-requests', async () => {
        await delay(150);
        return HttpResponse.json(
          {
            id: 'ar-9999',
            requester: { id: 'usr-lena-hoff', name: 'Lena Hoff' },
            kind: 'entitlement',
            target: 'D02-01 Mautic — product access',
            justification: 'Need read access to the supplier contract archive for the Q4 renewal.',
            state: 'open',
            createdAt: '2026-11-05T08:00:00.000Z',
            decidedBy: 'Sofia Almeida',
            decidedAt: '2026-11-05T08:05:00.000Z',
            domain: 'Marketing Automation',
          },
          { status: 201 },
        );
      }),
    );

    const dialog = await openRequestDialog();
    await chooseFirstProduct(dialog);
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Need read access to the supplier contract archive for the Q4 renewal.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

    expect(await within(dialog).findByText('Sending…')).toBeDefined();
    // A decided request says who decided it instead of "awaiting a decision".
    expect(await within(dialog).findByText(/is open/)).toBeDefined();
    expect(within(dialog).queryByText(/Awaiting a decision/)).toBeNull();
  });

  it('reports a refused request inside the dialog', async () => {
    server.use(
      http.post('/api/v1/admin/access-requests', () =>
        problemResponse(
          422,
          'JUSTIFICATION_REQUIRED',
          'A justification is required',
          'The domain owner needs a reason to decide.',
        ),
      ),
    );

    const dialog = await openRequestDialog();
    await chooseFirstProduct(dialog);
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Need read access to the supplier contract archive for the Q4 renewal.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

    expect(await within(dialog).findByText('A justification is required')).toBeDefined();
    await waitFor(() => expect(within(dialog).queryByText(/is open/)).toBeNull());
  });
});
