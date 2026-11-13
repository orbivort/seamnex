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

  it('states that the register is read-only for an auditor and disables the toggle', async () => {
    openAs('R2', '/governance/licenses');
    render(<App />);

    expect(await screen.findByText('Read-only register')).toBeDefined();
    const toggles = await screen.findAllByRole('button', {
      name: /hosted-service flag for/i,
    });
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) expect(toggle.hasAttribute('disabled')).toBe(true);
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
