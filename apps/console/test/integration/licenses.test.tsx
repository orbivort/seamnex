import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * FR-1.14 / AC-44: the licence register is a release gate. Its restrictions must be stated, the
 * hosted-service toggle must be refused with a reason, and an auditor must be able to read the
 * register without being able to change what it certifies.
 */
describe('license register', () => {
  it('counts the register and reports restrictions per row', async () => {
    openAs('R1', '/governance/licenses');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'License register' })).toBeDefined();
    const rows = getState().licenses;
    expect(await screen.findByText(`${rows.length} instances`)).toBeDefined();
    expect(
      await screen.findByText(
        `${rows.filter((row) => row.status === 'review_required').length} require review`,
      ),
    ).toBeDefined();

    const table = screen.getByRole('table');
    expect(within(table).getAllByText('no resale').length).toBe(
      rows.filter((row) => row.resaleRestricted).length,
    );
  });

  it('offers the auditor the review action but not the hosted-service toggle', async () => {
    openAs('R2', '/governance/licenses');
    render(<App />);

    expect(await screen.findByText('Audit and review')).toBeDefined();
    const toggles = await screen.findAllByRole('button', {
      name: /hosted-service flag for/i,
    });
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) expect(toggle.hasAttribute('disabled')).toBe(true);

    const reviews = await screen.findAllByRole('button', {
      name: /the licence review for/i,
    });
    expect(reviews.length).toBe(getState().licenses.length);
  });

  it('lets the auditor record a review and shows the evidence on the row', async () => {
    const row = present(
      getState().licenses.find((entry) => entry.status === 'review_required'),
      'a licence awaiting review',
    );
    openAs('R2', '/governance/licenses');
    render(<App />);
    await screen.findByRole('heading', { name: 'License register' });

    fireEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(`Record the licence review for ${row.product}`),
      }),
    );

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Upstream reference/), {
      target: { value: 'https://example.invalid/LICENSE' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record review' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const table = screen.getByRole('table');
    const tableRow = present(
      within(table).getByText(row.product).closest('tr'),
      'the reviewed row',
    );
    expect(await within(tableRow).findByText('https://example.invalid/LICENSE')).toBeDefined();
    expect(within(tableRow).queryByText('review required')).toBeNull();
    // The reviewer is a person on screen; the identity id stays in the payload for the audit trail.
    expect(await within(tableRow).findByText('Ruth Adler')).toBeDefined();
    expect(within(tableRow).queryByText('usr-ruth-adler')).toBeNull();
  });

  it('refuses to submit a review without the upstream evidence', async () => {
    const row = present(
      getState().licenses.find((entry) => entry.status === 'review_required'),
      'a licence awaiting review',
    );
    openAs('R2', '/governance/licenses');
    render(<App />);
    await screen.findByRole('heading', { name: 'License register' });

    fireEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(`Record the licence review for ${row.product}`),
      }),
    );

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record review' }));

    expect(
      await within(dialog).findByText(/artefact the review was checked against/i),
    ).toBeDefined();
    expect(row.upstreamRef).toBeNull();
  });

  it('refuses hosted-service mode for an unreviewed licence and states why', async () => {
    const row = present(
      getState().licenses.find((entry) => entry.status === 'review_required'),
      'a licence awaiting review',
    );
    openAs('R1', '/governance/licenses');
    render(<App />);
    await screen.findByRole('heading', { name: 'License register' });

    fireEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(`Enable hosted-service flag for ${row.product}`),
      }),
    );

    expect(
      await screen.findByText(new RegExp(`${row.licenseId} licence.*has not been reviewed`)),
    ).toBeDefined();
    expect(row.hostedService).toBe(false);
  });

  it('flips the hosted-service flag through the API and reflects the answer', async () => {
    openAs('R1', '/governance/licenses');
    render(<App />);
    await screen.findByRole('heading', { name: 'License register' });

    const row = present(
      getState().licenses.find((entry) => !entry.hostedService),
      'a licence that is not offered as a hosted service',
    );
    const button = await screen.findByRole('button', {
      name: new RegExp(`Enable hosted-service flag for ${row.product}`),
    });

    fireEvent.click(button);

    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: new RegExp(`Disable hosted-service flag for ${row.product}`),
        }),
      ).toBeDefined(),
    );
    expect(screen.getByText('offered as hosted service', { exact: false })).toBeDefined();
  });

  it('names the licence that blocks hosted-service provision', async () => {
    openAs('R1', '/governance/licenses');
    render(<App />);
    await screen.findByRole('heading', { name: 'License register' });

    const blocked = getState().licenses.find(
      (row) => row.hostedServiceRestricted && !row.hostedService,
    );
    if (!blocked) return;
    expect(await screen.findByText(`blocked by ${blocked.licenseId}`)).toBeDefined();
  });

  it('shows the API refusal next to the control instead of silently doing nothing', async () => {
    server.use(
      http.put('/api/v1/licenses/:instanceId/hosted-service', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/license-restricted',
            title: 'License restricts hosted service',
            status: 409,
            detail: 'The licence does not permit offering this product as a hosted service.',
            code: 'LICENSE_RESTRICTED',
            fieldErrors: [],
            remediation: 'Procure a commercial licence before enabling hosted-service mode.',
          },
          { status: 409 },
        ),
      ),
    );

    openAs('R1', '/governance/licenses');
    render(<App />);
    await screen.findByRole('heading', { name: 'License register' });

    const [button] = await screen.findAllByRole('button', {
      name: /Enable hosted-service flag for/i,
    });
    fireEvent.click(present(button, 'an enable control'));

    expect(
      await screen.findByText(/does not permit offering this product as a hosted service/i),
    ).toBeDefined();
  });

  it('marks a register that cannot be read as unavailable rather than as empty', async () => {
    server.use(http.get('/api/v1/licenses', () => HttpResponse.error()));

    openAs('R1', '/governance/licenses');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No licensed deployments')).toBeNull();
  });

  it('explains an empty register instead of showing a bare table', async () => {
    getState().licenses = [];

    openAs('R1', '/governance/licenses');
    render(<App />);

    expect(await screen.findByText('No licensed deployments')).toBeDefined();
    expect(screen.getByText('0 instances')).toBeDefined();
  });

  it('reports an unreviewed licence as review required, not as signed off', async () => {
    const row = getState().licenses.find((entry) => entry.status === 'review_required');
    if (!row) return;

    openAs('R1', '/governance/licenses');
    render(<App />);

    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('review required').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Not reviewed').length).toBeGreaterThan(0);
  });
});
