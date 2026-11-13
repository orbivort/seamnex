import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * FR-1.35 / FR-1.36 / NFR-3.5: the recovery screen is evidence. It states what a platform backup
 * contains, whether the route gate is closed, and whether a restore drill actually passed. A
 * read-only role can inspect all of it but cannot start a restore or a drill.
 */
describe('recovery evidence', () => {
  it('reports the platform backups, the last restore and the route gate', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Recovery' })).toBeDefined();
    expect(await screen.findByText('Restore rst-118')).toBeDefined();
    expect(screen.getByText('Route publication')).toBeDefined();
    expect(screen.getByText('Platform-state backups')).toBeDefined();
    expect(screen.getByText('What the backup contains')).toBeDefined();
    expect(screen.getByText('bkp-platform-1022')).toBeDefined();
  });

  it('names every phase of the fixed restore order', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByRole('heading', { name: 'Recovery' });

    const phases = await screen.findByRole('list', {
      name: 'Restore phases in fixed order',
    });
    expect(within(phases).getByText('Identity provider')).toBeDefined();
    expect(within(phases).getByText('Control plane')).toBeDefined();
    expect(within(phases).getByText('Product instances (parallel)')).toBeDefined();
  });

  it('reports a failed restore as failed, not as completed', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByRole('heading', { name: 'Recovery' });

    // The newest run succeeds; its predecessor failed and is still part of the record.
    const previous = getState().recovery.runs.find((run) => run.state === 'failed');
    expect(previous).toBeDefined();
  });

  it('accepts a platform backup and names the job', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByRole('heading', { name: 'Recovery' });

    fireEvent.click(screen.getByRole('button', { name: 'Back up platform state' }));

    expect(await screen.findByText(/Platform backup job .* accepted/)).toBeDefined();
  });

  it('starts a restore only with a justification and a chosen backup', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Start a platform-state restore')).toBeDefined();

    const submit = within(dialog).getByRole('button', { name: 'Start restore' });
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: {
        value: 'Recover the control plane onto the rebuilt host after the disk failure.',
      },
    });

    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false));
    fireEvent.click(submit);

    expect(await screen.findByText(/Restore job .* queued/)).toBeDefined();
  });

  it('refuses a restore whose justification is too short', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'short' },
    });

    expect(within(dialog).getByText('Add more detail.')).toBeDefined();
    expect(
      within(dialog).getByRole('button', { name: 'Start restore' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('schedules a restore drill and reports the verdict with its evidence', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(await screen.findByRole('button', { name: 'Schedule drill' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Schedule a restore drill')).toBeDefined();

    const select = within(dialog).getByLabelText(/Instance/);
    const options = within(dialog).getAllByRole('option') as HTMLOptionElement[];
    const target = options.find((option) => option.value !== '');
    fireEvent.change(select, { target: { value: target?.value ?? '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run drill' }));

    expect(await screen.findByText(/Drill .* passed/)).toBeDefined();
    expect(screen.getByText(/Evidence: https:\/\/evidence\.seamnex\.local/)).toBeDefined();
  });

  it('shows a failed drill and links its evidence', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByRole('heading', { name: 'Recovery' });

    const drills = await screen.findByText('Restore drills');
    expect(drills).toBeDefined();
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Evidence' }).length).toBeGreaterThan(0);
  });

  it('explains an empty drill register', async () => {
    getState().recovery.drills = [];

    openAs('R1', '/governance/recovery');
    render(<App />);

    expect(await screen.findByText('No restore drill recorded')).toBeDefined();
  });

  it('closes the route gate visibly when a restore is in flight', async () => {
    getState().recovery.gate = {
      ...getState().recovery.gate,
      routesPublished: false,
      detail: 'The platform restore is in flight; every product route is unpublished.',
    };

    openAs('R1', '/governance/recovery');
    render(<App />);

    expect(await screen.findByText('routes unpublished')).toBeDefined();
    expect(
      (await screen.findAllByText(/every product route is unpublished/i)).length,
    ).toBeGreaterThan(0);
  });

  it('is a read-only view for an auditor', async () => {
    openAs('R2', '/governance/recovery');
    render(<App />);

    expect(await screen.findByText('Read-only recovery view')).toBeDefined();
    const backup = await screen.findByRole('button', { name: 'Back up platform state' });
    expect(backup.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Start restore' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('reports a refused backup next to the action', async () => {
    server.use(
      http.post('/api/v1/recovery/backups', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Platform backup is not permitted for your role',
            status: 403,
            detail: 'recovery.manage is required.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the platform administrator.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByRole('heading', { name: 'Recovery' });

    fireEvent.click(screen.getByRole('button', { name: 'Back up platform state' }));

    expect(await screen.findByText('Platform backup is not permitted for your role')).toBeDefined();
  });

  it('reports unreadable recovery evidence instead of an empty register', async () => {
    server.use(http.get('/api/v1/recovery', () => HttpResponse.error()));

    openAs('R1', '/governance/recovery');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No platform restore has run')).toBeNull();
  });
});
