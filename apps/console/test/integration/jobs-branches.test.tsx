import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The branches of the job screens that the happy-path suite never reaches: the states a job can be
 * forced into (no instance, a truncated log, a skipped step, a background read that starts failing),
 * the whole blocked-reason matrix behind the rollback offer, and the cursor-paged history.
 *
 * The steps, logs and instance state live in the mock platform's store, so a case sets up the state
 * the screen is meant to explain and then mounts the app — no sleeps and no fake timers.
 */

/**
 * `apiMode` is a build-time constant (`__SEAMNEX_MOCKS__` is on for every test run), so the "not a mock
 * build" arm of the simulated-log note is unreachable from a test. This file is the one place that
 * overrides it; the mock arm stays covered by `jobs.test.tsx`, which mounts the same page.
 */
vi.mock('../../src/api-mode', async (importOriginal) => {
  // Everything else — `mocksEnabled`, the transport wiring the harness uses — stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiMode: 'live' as const };
});

function jobById(id: string) {
  const job = getState().jobs.find((item) => item.id === id);
  if (!job) throw new Error(`fixture job ${id} is missing`);
  return job;
}

describe('failed-upgrade rollback offer', () => {
  it('rolls the instance back and opens the job it queued', async () => {
    // FR-1.7: the upgrade dialog promises a one-step rollback, so the page a failed upgrade lands on
    // has to be able to perform it — and follow the new job rather than staying on the failed one.
    openAs('R1', '/jobs/job-1042');
    render(<App />);

    // The offer renders with the job; its verdict needs the instance and its plan, so it arrives
    // one round trip later.
    const offer = await screen.findByRole('button', { name: 'Roll back' });
    await waitFor(() => expect(offer.hasAttribute('disabled')).toBe(false));
    fireEvent.click(offer);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Roll back this instance?')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));

    // The accepted job is a new one, so the page navigates to it instead of leaving the operator on
    // the failed upgrade.
    expect(
      (await screen.findAllByRole('heading', { name: 'Rollback D06-01 ERPNext' })).length,
    ).toBeGreaterThan(0);
    expect(
      getState().jobs.some(
        (job) => job.label === 'Rollback D06-01 ERPNext' && job.kind === 'rollback',
      ),
    ).toBe(true);
  });

  it('queues nothing when the confirmation is cancelled', async () => {
    // A dismissed dialog must not roll anything back: the confirm is the only path to the mutation.
    openAs('R1', '/jobs/job-1042');
    render(<App />);

    const before = getState().jobs.length;
    const offer = await screen.findByRole('button', { name: 'Roll back' });
    await waitFor(() => expect(offer.hasAttribute('disabled')).toBe(false));
    fireEvent.click(offer);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Roll back this instance?')).toBeNull());
    expect(getState().jobs.length).toBe(before);
    expect(getState().instances.find((item) => item.id === 'inst-erp')?.state).toBe('ready');
  });

  it('waits for the instance state when the job names no instance', async () => {
    // `instanceId` is nullable: a platform-level job can fail and still be a failed upgrade, and the
    // page must say what it is waiting for instead of offering a rollback of nothing.
    jobById('job-1042').instanceId = null;

    openAs('R1', '/jobs/job-1042');
    render(<App />);

    expect(await screen.findByText('Waiting for the instance state.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Roll back' }).hasAttribute('disabled')).toBe(true);
  });

  it('explains that a stopped instance cannot be rolled back', async () => {
    // The lifecycle matrix, not the plan, decides this: a stopped instance has no running services
    // to restore, so the copy names the state the operator is actually looking at.
    const erp = getState().instances.find((item) => item.id === 'inst-erp');
    if (!erp) throw new Error('fixture instance inst-erp is missing');
    erp.state = 'stopped';
    erp.ready = false;

    openAs('R1', '/jobs/job-1042');
    render(<App />);

    // The page interpolates the state's label object, so the sentence is asserted by its prefix.
    expect(await screen.findByText(/^Not available from/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Roll back' }).hasAttribute('disabled')).toBe(true);
  });

  it('explains a missing predecessor instead of queueing a job that cannot work', async () => {
    // `rollbackAvailable` is false when the instance retains no previous render set; queueing the
    // job would only produce a failure nobody can act on, so the offer explains itself instead.
    server.use(
      http.get('/api/v1/instances/:id/plan', () =>
        HttpResponse.json({
          action: 'rollback',
          instanceId: 'inst-erp',
          from: '15.42.0',
          to: '15.41.2',
          changes: [
            { field: 'image.digest', from: 'sha256:2e94b7c1d05a', to: 'sha256:41ab9f02c7de' },
          ],
          preUpgradeBackup: false,
          capacityVerdict: {
            admissible: true,
            headline: 'Within host capacity',
            detail: 'No additional reservation required.',
          },
          rollbackAvailable: false,
        }),
      ),
    );

    openAs('R1', '/jobs/job-1042');
    render(<App />);

    expect(
      await screen.findByText(/No previous render set is retained for this instance/),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Roll back' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps the offer but names the role that may use it', async () => {
    // R2 may read the job and the instance but holds no `instance.lifecycle` grant. The offer stays
    // visible so the failure is understandable, and the reason is the role, not the state.
    openAs('R2', '/jobs/job-1042');
    render(<App />);

    expect(
      await screen.findByText('Rolling back requires the platform administrator role.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Roll back' }).hasAttribute('disabled')).toBe(true);
  });

  it('reports a refused rollback beside the dialog that asked for it', async () => {
    // A 409 from the lifecycle endpoint left nothing on screen before this branch existed, so the
    // confirm looked like it had worked.
    server.use(
      http.post('/api/v1/instances/:id/rollback', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/invalid-state',
            title: 'No previous render set is retained',
            status: 409,
            detail:
              'The instance has no retained predecessor; the pre-upgrade backup is the path back.',
            code: 'INVALID_STATE',
            fieldErrors: [],
            remediation: 'Restore the pre-upgrade backup instead.',
          },
          { status: 409 },
        ),
      ),
    );

    openAs('R1', '/jobs/job-1042');
    render(<App />);

    const offer = await screen.findByRole('button', { name: 'Roll back' });
    await waitFor(() => expect(offer.hasAttribute('disabled')).toBe(false));
    fireEvent.click(offer);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));

    expect(await screen.findByText('No previous render set is retained')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});

describe('job progress panel', () => {
  it('shows a skipped step as skipped rather than pending', async () => {
    // A cancelled or failed job leaves the steps it never ran in `skipped`; rendering them as
    // pending would claim work is still to come.
    const job = jobById('job-1058');
    job.steps = job.steps.map((step, index) =>
      index === 3 ? { ...step, state: 'skipped' as const, message: null } : step,
    );

    openAs('R1', '/jobs/job-1058');
    render(<App />);

    const steps = await screen.findByRole('list', { name: 'Job steps' });
    expect(within(steps).getByText('Verify readiness')).toBeDefined();
    expect(within(steps).getAllByRole('listitem').length).toBe(4);
  });

  it('says when the retained log no longer starts at the first line', async () => {
    // The stream keeps a bounded buffer, so a first sequence number above 1 means the beginning was
    // dropped. Without the notice the log reads as the whole story.
    const logs = getState().jobLogs['job-1058'] ?? [];
    getState().jobLogs['job-1058'] = logs.slice(3);

    openAs('R1', '/jobs/job-1058');
    render(<App />);

    const log = await screen.findByRole('log', { name: 'Job log output' });
    expect(
      await within(log).findByText(
        new RegExp(`Earlier output is not shown · ${logs.length - 3} lines retained`),
      ),
    ).toBeDefined();
  });

  it('offers no instance link on a platform-level job', async () => {
    // A platform backup has no instance; the link would point at `/instances/null`.
    openAs('R1', '/jobs/job-1055');
    render(<App />);

    expect((await screen.findAllByText('Platform-state backup')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /Open instance/ })).toBeNull();
  });

  it('drops the lifecycle note once a read-only role has nothing left to do', async () => {
    // The note explains why a control is missing. On a finished job there is no control to miss, so
    // repeating it would suggest work the operator could have done.
    openAs('R2', '/jobs/job-1041');
    render(<App />);

    expect((await screen.findAllByText('Deploy D03-01 Zammad')).length).toBeGreaterThan(0);
    expect(screen.queryByText('lifecycle: platform administrator')).toBeNull();
  });

  it('keeps the lifecycle note on a failed job a read-only role cannot act on', async () => {
    // A failed job is the case where the missing retry matters, so the note stays.
    openAs('R2', '/jobs/job-1051');
    render(<App />);

    expect(await screen.findByText('lifecycle: platform administrator')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('surfaces a job read that fails while the panel is already open', async () => {
    // The panel used to keep polling a job the platform no longer had, and showed a frozen progress
    // bar. The problem belongs on the panel, with the last known job still readable underneath.
    openAs('R1', '/jobs/job-1058');
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeDefined();

    // The job is pruned with the retention window: the stream closes and the poll starts answering
    // 404, which is the one path that reaches the panel's own error branch.
    getState().jobs = getState().jobs.filter((job) => job.id !== 'job-1058');

    expect(await screen.findByText('Job not found')).toBeDefined();
    expect(screen.getByText('Apply environment values to D08-01 Paperless-ngx')).toBeDefined();

    // The panel's own retry is the last one on the page (the page-level banner has one too), and
    // pressing it re-reads the job rather than leaving a dead panel behind.
    const panelRetry = screen.getAllByRole('button', { name: 'Retry' }).at(-1);
    if (!panelRetry) throw new Error('the panel rendered no retry control');
    fireEvent.click(panelRetry);
    await waitFor(() => expect(screen.getAllByText('Job not found').length).toBeGreaterThan(0));
  });
});

describe('job history paging', () => {
  it('follows the cursor the API returns and says how much is left', async () => {
    // The overview only sees one page of a cursor-paged history, so the control has to name the
    // remainder and disable itself while the next page is in flight.
    const firstPage = getState().jobs.slice(0, 2);
    const lastPage = getState().jobs.slice(2, 3);

    server.use(
      http.get('/api/v1/jobs', async ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        const total = firstPage.length + lastPage.length;
        if (cursor === null) {
          return HttpResponse.json({ items: firstPage, nextCursor: '2', total });
        }
        // A page that answers immediately would never show the in-flight label.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return HttpResponse.json({ items: lastPage, nextCursor: null, total });
      }),
    );

    openAs('R1', '/jobs');
    render(<App />);

    expect(await screen.findByText(`${firstPage.length + lastPage.length} jobs`)).toBeDefined();
    const more = await screen.findByRole('button', { name: 'Load 1 more' });
    expect(more.hasAttribute('disabled')).toBe(false);

    fireEvent.click(more);

    const busy = await screen.findByRole('button', { name: 'Loading…' });
    expect(busy.hasAttribute('disabled')).toBe(true);

    await waitFor(() =>
      expect(
        screen.getByText(
          `${firstPage.length + lastPage.length} of ${firstPage.length + lastPage.length} shown`,
        ),
      ).toBeDefined(),
    );
    expect(screen.queryByRole('button', { name: /Load \d+ more/ })).toBeNull();
  });
});
