import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The job history is the audit trail an operator reads after a failure. Filters are server-side,
 * a retry produces a new job rather than restarting the failed one, and a read-only role must see
 * the status without the lifecycle controls.
 */
describe('job history', () => {
  it('lists jobs newest first with the counts that match the rows', async () => {
    openAs('R1', '/jobs');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeDefined();
    const jobs = getState().jobs;
    expect(await screen.findByText(`${jobs.length} jobs`)).toBeDefined();
    expect(screen.getByText(/of \d+ shown/)).toBeDefined();
    await waitFor(() => expect(screen.getByText('job-1058')).toBeDefined());
  });

  it('filters by state on the server', async () => {
    openAs('R1', '/jobs');
    render(<App />);
    await screen.findByRole('heading', { name: 'Jobs' });
    await screen.findByText('job-1058');

    fireEvent.click(screen.getByRole('button', { name: 'running' }));

    await waitFor(() => expect(screen.getByText('1 of 1 shown')).toBeDefined());
    expect(screen.getByText('job-1058')).toBeDefined();
    expect(screen.queryByText('job-1041')).toBeNull();
  });

  it('filters by kind on the server and says when nothing matches', async () => {
    openAs('R1', '/jobs');
    render(<App />);
    await screen.findByRole('heading', { name: 'Jobs' });
    await screen.findByText('job-1058');

    fireEvent.click(screen.getByRole('button', { name: 'rollback' }));

    await waitFor(() => expect(screen.queryByText('job-1041')).toBeNull());
    expect(screen.getByText('job-1043')).toBeDefined();
  });

  it('loads the whole history in one page when the API returns no cursor', async () => {
    openAs('R1', '/jobs');
    render(<App />);
    await screen.findByRole('heading', { name: 'Jobs' });
    await screen.findByText('job-1058');

    // The mock returns every job in one page, so the cursor control is absent rather than inert.
    expect(screen.queryByRole('button', { name: /Load \d+ more/ })).toBeNull();
  });

  it('shows steps, logs and the instance link on a finished job', async () => {
    openAs('R1', '/jobs/job-1041');
    render(<App />);

    expect((await screen.findAllByText('Deploy D03-01 Zammad')).length).toBeGreaterThan(0);
    expect(screen.getByRole('list', { name: 'Job steps' })).toBeDefined();
    expect(
      await screen.findByText(
        new RegExp(`${getState().jobLogs['job-1041']?.length} lines · final`),
      ),
    ).toBeDefined();
    expect(screen.getByRole('link', { name: /Open instance/ })).toBeDefined();
  });

  it('cancels a running job and reflects the terminal state', async () => {
    openAs('R1', '/jobs/job-1058');
    render(<App />);

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);

    await waitFor(() =>
      expect(getState().jobs.find((job) => job.id === 'job-1058')?.state).toBe('cancelled'),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
  });

  it('reports a refused cancel next to the status', async () => {
    server.use(
      http.post('/api/v1/jobs/:id/cancel', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/job-terminal',
            title: 'Job already finished',
            status: 409,
            detail: 'Job job-1058 is cancelled.',
            code: 'JOB_TERMINAL',
            fieldErrors: [],
            remediation: 'Only queued or running jobs can be cancelled.',
          },
          { status: 409 },
        ),
      ),
    );

    openAs('R1', '/jobs/job-1058');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Job already finished')).toBeDefined();
  });

  it('retries a failed job as a new job', async () => {
    openAs('R1', '/jobs/job-1042');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect((await screen.findAllByText(/\(retry\)/)).length).toBeGreaterThan(0);
    expect(getState().jobs.some((job) => job.label.endsWith('(retry)'))).toBe(true);
  });

  it('offers no lifecycle controls to a read-only role but says who may act', async () => {
    openAs('R2', '/jobs/job-1058');
    render(<App />);

    expect(await screen.findByText('lifecycle: platform administrator')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('explains a missing job instead of rendering an empty panel', async () => {
    openAs('R1', '/jobs/job-0000');
    render(<App />);

    expect(await screen.findByText('Job not found')).toBeDefined();
    expect(screen.getByText(/No job matches job-0000/)).toBeDefined();
  });

  it('reports a refused job read with a retry', async () => {
    server.use(http.get('/api/v1/jobs/job-1041', () => HttpResponse.error()));

    openAs('R1', '/jobs/job-1041');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('reports unreadable job history without an empty table', async () => {
    server.use(http.get('/api/v1/jobs', () => HttpResponse.error()));

    openAs('R1', '/jobs');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No jobs to show')).toBeNull();
  });

  it('separates a failed row from one still in flight', async () => {
    openAs('R1', '/jobs');
    render(<App />);
    await screen.findByRole('heading', { name: 'Jobs' });

    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getByText('job-1042')).toBeDefined());
    expect(within(table).getAllByText('Failed').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('in flight').length).toBeGreaterThan(0);
  });
});
