import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The fleet and one deployment. Two facts matter most here: the list never claims an empty fleet
 * when a filter is what emptied it, and the lifecycle controls are only enabled when the state
 * machine and the role both allow the action.
 */
describe('deployment inventory', () => {
  it('counts the fleet and states which rows are matching', async () => {
    openAs('R1', '/instances');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Instances' })).toBeDefined();
    const instances = getState().instances;
    expect(await screen.findByText(`${instances.length} deployments`)).toBeDefined();
  });

  it('searches the fleet on the server', async () => {
    openAs('R1', '/instances');
    render(<App />);
    await screen.findByRole('heading', { name: 'Instances' });
    await screen.findByText('EspoCRM');

    fireEvent.change(screen.getByLabelText('Search instances'), { target: { value: 'Zammad' } });

    await waitFor(() => expect(screen.queryByText('EspoCRM')).toBeNull());
    expect(await screen.findByText('Zammad')).toBeDefined();
  });

  it('explains a filter that matches nothing without claiming the fleet is empty', async () => {
    openAs('R1', '/instances');
    render(<App />);
    await screen.findByRole('heading', { name: 'Instances' });

    fireEvent.change(screen.getByLabelText('Search instances'), {
      target: { value: 'no-such-product' },
    });

    expect(await screen.findByText('No instance matches this filter')).toBeDefined();
    expect(screen.queryByText('No deployments yet')).toBeNull();
  });

  it('offers the catalog when the platform really has no deployment', async () => {
    getState().instances = [];

    openAs('R1', '/instances');
    render(<App />);

    expect(await screen.findByText('No deployments yet')).toBeDefined();
    expect(screen.getByRole('link', { name: /Browse the catalog/ })).toBeDefined();
    expect(screen.getByText('0 deployments')).toBeDefined();
  });

  it('reports an unreadable fleet instead of zeros', async () => {
    server.use(http.get('/api/v1/instances', () => HttpResponse.error()));

    openAs('R1', '/instances');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No deployments yet')).toBeNull();
  });

  it('hides the fleet from a role without instance.view_logs', async () => {
    openAs('R5', '/instances');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });

  it('shows the derived state, readiness and portal status of each deployment', async () => {
    openAs('R1', '/instances');
    render(<App />);
    await screen.findByRole('heading', { name: 'Instances' });

    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getByText('OrangeHRM')).toBeDefined());
    expect(within(table).getAllByText('Degraded').length).toBeGreaterThanOrEqual(1);
    expect(within(table).getAllByText('not ready').length).toBeGreaterThanOrEqual(2);
  });
});

describe('one deployment', () => {
  it('states the container truth, version and backup posture', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'EspoCRM' })).toBeDefined();
    expect(screen.getByText('Instance facts')).toBeDefined();
    expect(screen.getByText('Resolved deployment source')).toBeDefined();
    expect(screen.getByText('Resource usage')).toBeDefined();
    expect(screen.getByText('Backup posture')).toBeDefined();
    expect(screen.getAllByText('9.2.4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('10.0.11').length).toBeGreaterThan(0);
  });

  it('reports a degraded instance with the reason it is not ready', async () => {
    openAs('R1', '/instances/inst-people');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'OrangeHRM' })).toBeDefined();
    expect(await screen.findByText(/not ready/i)).toBeDefined();
  });

  it('refreshes the status against the platform and records it as a manual observation', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    fireEvent.click(screen.getByRole('button', { name: /Refresh status/ }));

    await waitFor(() => expect(screen.getByText(/source manual/)).toBeDefined());
  });

  it('offers the lifecycle actions on a ready instance and confirms before acting', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    for (const name of [
      'Start',
      'Stop',
      'Restart',
      'Reconfigure',
      'Upgrade',
      'Roll back',
      'Export',
      'Delete',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDefined();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Restart instance?')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));

    // The API accepts a job and the console moves to that job's page.
    expect(await screen.findByRole('heading', { name: /Restart|Job detail/ })).toBeDefined();
    expect(getState().jobs.some((job) => job.kind === 'restart')).toBe(true);
  });

  it('explains a stopped instance rather than offering an impossible stop', async () => {
    openAs('R1', '/instances/inst-shop');
    render(<App />);
    await screen.findByRole('heading', { name: 'WooCommerce' });

    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Restart' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows an administrator-only read-only lifecycle to an auditor', async () => {
    openAs('R2', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    expect(screen.getByText('read-only lifecycle')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('hides the environment tab from a role that may not read secrets', async () => {
    openAs('R2', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).not.toContain('Environment');
  });

  it('keeps the Environment tab for a role with a scoped grant', async () => {
    openAs('R3', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toContain('Environment');
  });

  it('warns before an irreversible delete and makes the data choice explicit', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getAllByText('Delete instance').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('What happens to the data')).toBeDefined();
    for (const label of [/Keep volumes/, /Export then delete/, /Delete everything/]) {
      expect(within(dialog).getByRole('radio', { name: label })).toBeDefined();
    }
  });

  it('plans an upgrade before running it', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Upgrade instance')).toBeDefined();
    expect(await within(dialog).findByText(/pre-upgrade backup/i)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: /Run upgrade|Starting/ })).toBeDefined();
  });

  it('reports a refused lifecycle action without navigating away', async () => {
    server.use(
      http.post('/api/v1/instances/:id/:action', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Lifecycle actions are not permitted for your role',
            status: 403,
            detail: 'restart needs instance.lifecycle.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the platform administrator.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));

    expect(
      await screen.findByText('Lifecycle actions are not permitted for your role'),
    ).toBeDefined();
    expect(screen.getByRole('heading', { name: 'EspoCRM' })).toBeDefined();
  });

  it('reports a missing instance instead of an empty shell', async () => {
    openAs('R1', '/instances/inst-unknown');
    render(<App />);

    expect((await screen.findAllByText(/No instance matches|not found/i)).length).toBeGreaterThan(
      0,
    );
  });

  it('reports a failed status refresh next to the control that caused it', async () => {
    server.use(http.get('/api/v1/instances/inst-crm/status', () => HttpResponse.error()));

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    fireEvent.click(screen.getByRole('button', { name: /Refresh status/ }));

    // The failure is reported once, in the header slot, and the facts stay on screen.
    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.getByText('Instance facts')).toBeDefined();
  });
});
