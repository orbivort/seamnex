import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { Backup, Job, PlatformRestoreRun, RestorePhaseStatus } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/** The mock platform is seeded around a fixed instant; a crafted run is anchored to *now* so it sorts first. */
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

function phase(
  name: RestorePhaseStatus['phase'],
  state: RestorePhaseStatus['state'],
  finishedAt: string | null = state === 'succeeded' ? iso(-1_000) : null,
): RestorePhaseStatus {
  return {
    phase: name,
    label: `${name} phase`,
    state,
    startedAt: state === 'pending' ? null : iso(-2_000),
    finishedAt,
    detail: `detail for ${name}`,
  };
}

function makeRun(overrides: Partial<PlatformRestoreRun> = {}): PlatformRestoreRun {
  return {
    id: 'rst-200',
    backupId: 'bkp-platform-1022',
    kind: 'platform',
    phase: 'complete',
    state: 'succeeded',
    startedAt: iso(0),
    finishedAt: iso(0),
    loginVerifiedAt: iso(0),
    concurrency: 4,
    failedReason: null,
    justification: 'Recover the control plane onto the rebuilt host after the disk failure.',
    requestedBy: 'Sofia Almeida',
    routesUnpublishedUntilLogin: true,
    phases: [phase('preparing', 'succeeded'), phase('idp', 'succeeded')],
    ...overrides,
  };
}

/** Puts a crafted run in front of the seeded ones, which is how the page picks the run it shows. */
function installRun(run: PlatformRestoreRun): PlatformRestoreRun {
  getState().recovery.runs = [run, ...getState().recovery.runs];
  return run;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-7777',
    kind: 'platform-backup',
    instanceId: null,
    entryKey: null,
    label: 'Platform state backup bkp-platform-1023',
    state: 'succeeded',
    progress: 100,
    createdAt: iso(0),
    startedAt: iso(0),
    finishedAt: iso(0),
    requestedBy: 'Sofia Almeida',
    summary: 'Capture the platform state, including the identity-provider realm.',
    errorCode: null,
    errorMessage: null,
    steps: [],
    ...overrides,
  };
}

/** Accepts a write with a job the test controls, so the follow-up is decided by the stubbed job. */
function acceptWithJob(path: string, job: Job) {
  server.use(
    http.post(path, () =>
      HttpResponse.json(
        {
          jobId: job.id,
          links: { self: `/api/v1/jobs/${job.id}`, logs: `/api/v1/jobs/${job.id}/logs` },
        },
        { status: 202 },
      ),
    ),
    http.get(`/api/v1/jobs/${job.id}`, () => HttpResponse.json(job)),
  );
}

/** Opens the drill dialog and picks the first deployed instance, waiting for the list to arrive. */
async function pickDrillInstance(dialog: HTMLElement): Promise<void> {
  const target = await waitFor(() => {
    const options = within(dialog).getAllByRole('option') as HTMLOptionElement[];
    const found = options.find((option) => option.value !== '');
    if (!found) throw new Error('the instance list has not loaded yet');
    return found;
  });
  fireEvent.change(within(dialog).getByLabelText(/Instance/), { target: { value: target.value } });
}

/**
 * FR-1.36 is a timeline, and a timeline is only evidence if it distinguishes the states it can
 * actually be in: a phase that failed, one that is running, one still waiting and one skipped are
 * four different facts. The seeded newest run succeeded in every phase, so these are crafted.
 */
describe('restore timeline states', () => {
  it('reports a phase that failed as failed, and the run with it', async () => {
    installRun(
      makeRun({
        state: 'failed',
        phase: 'products',
        failedReason:
          'Smoke test failed: D07-01 OrangeHRM returned 0 employees after restore; the volume capture was incomplete.',
        phases: [
          phase('preparing', 'succeeded'),
          phase('idp', 'succeeded'),
          phase('control_plane', 'failed'),
          phase('login_verified', 'skipped'),
          phase('products', 'running'),
          phase('verify', 'succeeded', null),
        ],
      }),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);

    const phases = await screen.findByRole('list', { name: 'Restore phases in fixed order' });
    expect(within(phases).getByText('failed')).toBeDefined();
    expect(within(phases).getByText('skipped')).toBeDefined();
    expect(within(phases).getByText('running')).toBeDefined();
    // A succeeded phase without a finishing stamp is "done", not a date it cannot produce.
    expect(within(phases).getByText('done')).toBeDefined();

    expect(await screen.findByText('Reported as failed, not completed')).toBeDefined();
    expect(screen.getByText(/returned 0 employees/)).toBeDefined();
  });

  it('admits a failure it cannot explain instead of inventing a reason', async () => {
    installRun(makeRun({ state: 'failed', failedReason: null }));

    openAs('R1', '/governance/recovery');
    render(<App />);

    expect(await screen.findByText('Reported as failed, not completed')).toBeDefined();
    expect(
      screen.getByText('The run did not complete; product routes stay unpublished.'),
    ).toBeDefined();
  });

  it('follows a running restore from the polled gate', async () => {
    getState().recovery.gate = {
      routesPublished: false,
      loginVerifiedAt: null,
      detail: 'Product routes are unpublished until an administrative login succeeds.',
    };
    installRun(
      makeRun({
        id: 'rst-201',
        state: 'running',
        phase: 'products',
        finishedAt: null,
        loginVerifiedAt: null,
        phases: [
          phase('idp', 'succeeded'),
          phase('control_plane', 'running'),
          phase('products', 'pending'),
        ],
      }),
    );
    server.use(
      http.get('/api/v1/platform/restore-status', () =>
        HttpResponse.json({
          run: getState().recovery.runs[0],
          gate: getState().recovery.gate,
          generatedAt: iso(0),
        }),
      ),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);

    // The polled run is the one on screen, so its live phases are what the timeline prints.
    const phases = await screen.findByRole('list', { name: 'Restore phases in fixed order' });
    expect(within(phases).getByText('running')).toBeDefined();
    expect(within(phases).getByText('waiting')).toBeDefined();

    expect(await screen.findByText('in progress')).toBeDefined();
    expect(screen.getAllByText('not yet').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Product routes remain unpublished until the administrative login/),
    ).toBeDefined();
  });

  it('explains a run that has no phase record yet', async () => {
    installRun(makeRun({ state: 'running', phases: [], finishedAt: null }));

    openAs('R1', '/governance/recovery');
    render(<App />);

    expect(await screen.findByText(/This run has no phase record yet/)).toBeDefined();
  });

  it('explains a platform that has never been restored', async () => {
    getState().recovery.runs = [];

    openAs('R1', '/governance/recovery');
    render(<App />);

    expect(await screen.findByText('No platform restore has run')).toBeDefined();
    expect(screen.getByText('Restore timeline')).toBeDefined();
  });
});

/**
 * A capture and a restore are accepted as jobs, and the register is only honest once the job
 * terminates — the page follows the accepted job and reports each terminal state in its own words.
 */
describe('recovery job follow-up', () => {
  it('reports a platform capture that finished', async () => {
    acceptWithJob('/api/v1/recovery/backups', makeJob());

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByRole('heading', { name: 'Recovery' });

    fireEvent.click(screen.getByRole('button', { name: 'Back up platform state' }));

    expect(await screen.findByText('Platform backup captured')).toBeDefined();
    expect(screen.getByText(/The set is now in the register/)).toBeDefined();
  });

  it('reports a capture that failed with the job’s own message', async () => {
    acceptWithJob(
      '/api/v1/recovery/backups',
      makeJob({ state: 'failed', errorMessage: 'The artefact upload was refused by the store.' }),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByRole('heading', { name: 'Recovery' });

    fireEvent.click(screen.getByRole('button', { name: 'Back up platform state' }));

    expect(await screen.findByText('The platform capture failed')).toBeDefined();
    expect(screen.getByText('The artefact upload was refused by the store.')).toBeDefined();
  });

  it('admits a capture that stopped without a reason', async () => {
    acceptWithJob('/api/v1/recovery/backups', makeJob({ state: 'failed', errorMessage: null }));

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByRole('heading', { name: 'Recovery' });

    fireEvent.click(screen.getByRole('button', { name: 'Back up platform state' }));

    expect(await screen.findByText('The platform capture failed')).toBeDefined();
    expect(screen.getByText(/The job stopped before it uploaded anything/)).toBeDefined();
  });

  it('names a restore job that finished', async () => {
    acceptWithJob(
      '/api/v1/recovery/restores',
      makeJob({ id: 'job-9999', kind: 'platform-restore' }),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Recover the control plane onto the rebuilt host after the disk failure.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start restore' }));

    expect(await screen.findByText('Restore job job-9999 finished')).toBeDefined();
  });

  it('reports a restore that failed with the job’s own message', async () => {
    acceptWithJob(
      '/api/v1/recovery/restores',
      makeJob({
        id: 'job-9999',
        kind: 'platform-restore',
        state: 'failed',
        errorMessage: 'The identity provider did not answer after the realm import.',
      }),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Recover the control plane onto the rebuilt host after the disk failure.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start restore' }));

    expect(await screen.findByText('The platform restore failed')).toBeDefined();
    expect(screen.getByText(/did not answer after the realm import/)).toBeDefined();
  });

  it('admits a restore that stopped without a reason', async () => {
    acceptWithJob(
      '/api/v1/recovery/restores',
      makeJob({ id: 'job-9999', kind: 'platform-restore', state: 'failed', errorMessage: null }),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Recover the control plane onto the rebuilt host after the disk failure.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start restore' }));

    expect(await screen.findByText('The platform restore failed')).toBeDefined();
    expect(
      screen.getByText(/The run stopped; the gate stays closed until a restore completes/),
    ).toBeDefined();
  });
});

/** The restore register must describe a capture it can only partly vouch for, and the drill verdicts. */
describe('recovery register', () => {
  it('reports a failed capture and one still running rather than rounding them up', async () => {
    const seed = getState().recovery.backups[0] as Backup;
    getState().recovery.backups = [
      { ...seed, id: 'bkp-platform-1025', state: 'running', finishedAt: null, objectKey: '' },
      { ...seed, id: 'bkp-platform-1024', state: 'failed', objectKey: '' },
    ];

    openAs('R1', '/governance/recovery');
    render(<App />);

    const register = await screen.findByRole('table', {
      name: 'Platform-state backups, separate from product backups',
    });
    expect(within(register).getByText('bkp-platform-1025')).toBeDefined();
    // Both states are printed as recorded facts, not folded into "no usable capture".
    expect(within(register).getByText('running')).toBeDefined();
    expect(within(register).getByText('failed')).toBeDefined();
  });

  it('says never rather than inventing a date when nothing has been captured', async () => {
    getState().recovery.backups = [];
    const succeeded = getState().recovery.runs.find((run) => run.state === 'succeeded');
    expect(succeeded).toBeDefined();
    // A successful run that never verified an administrative login is not verified evidence.
    (succeeded as PlatformRestoreRun).loginVerifiedAt = null;

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByRole('heading', { name: 'Recovery' });

    expect(await screen.findByText(/last backup never/)).toBeDefined();
    expect(screen.getByText(/last verified restore never/)).toBeDefined();
  });

  it('reports a drill that is still queued as started, not as passed', async () => {
    server.use(
      http.post('/api/v1/restore-drills', () =>
        HttpResponse.json(
          {
            id: 'drill-documents-9',
            instanceId: 'inst-documents',
            instanceLabel: 'D08-01 Paperless-ngx',
            performedAt: iso(0),
            smokeTest: 'queued',
            passed: false,
            evidenceUrl: 'https://evidence.seamnex.local/restore-drills/documents-9',
          },
          { status: 201 },
        ),
      ),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(await screen.findByRole('button', { name: 'Schedule drill' }));
    const dialog = await screen.findByRole('dialog');
    await pickDrillInstance(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run drill' }));

    expect(await screen.findByText('Drill drill-documents-9 queued')).toBeDefined();
  });

  it('reports a drill that did not pass as a failure with its evidence', async () => {
    server.use(
      http.post('/api/v1/restore-drills', () =>
        HttpResponse.json(
          {
            id: 'drill-documents-9',
            instanceId: 'inst-documents',
            instanceLabel: 'D08-01 Paperless-ngx',
            performedAt: iso(0),
            smokeTest: 'Document count did not match the manifest',
            passed: false,
            evidenceUrl: 'https://evidence.seamnex.local/restore-drills/documents-9',
          },
          { status: 201 },
        ),
      ),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(await screen.findByRole('button', { name: 'Schedule drill' }));
    const dialog = await screen.findByRole('dialog');
    await pickDrillInstance(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run drill' }));

    expect(await screen.findByText('Drill drill-documents-9 did not pass')).toBeDefined();
  });

  it('puts a refused drill next to the instance it was for', async () => {
    server.use(
      http.post('/api/v1/restore-drills', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/instance-not-found',
            title: 'Choose an instance',
            status: 422,
            code: 'INSTANCE_NOT_FOUND',
            detail: 'A drill targets one deployed instance.',
            fieldErrors: [],
            remediation: 'Select an instance from the fleet.',
          },
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(await screen.findByRole('button', { name: 'Schedule drill' }));
    const dialog = await screen.findByRole('dialog');
    await pickDrillInstance(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run drill' }));

    expect(await within(dialog).findByText('Choose an instance')).toBeDefined();
    expect(within(dialog).getByText('A drill targets one deployed instance.')).toBeDefined();
  });

  it('says that the drill is running while the answer is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/restore-drills', async () => {
        await gate;
        return HttpResponse.json(
          {
            type: 'x',
            title: 'Late',
            status: 422,
            code: 'LATE',
            detail: 'Late.',
            fieldErrors: [],
            remediation: 'Retry.',
          },
          { status: 422 },
        );
      }),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(await screen.findByRole('button', { name: 'Schedule drill' }));
    const dialog = await screen.findByRole('dialog');
    await pickDrillInstance(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run drill' }));

    expect(await within(dialog).findByText('Running drill…')).toBeDefined();
    release();
    await within(dialog).findByText('Late');
  });

  it('closes the drill form without running anything', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(await screen.findByRole('button', { name: 'Schedule drill' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers the first drill from an empty drill register', async () => {
    getState().recovery.drills = [];

    openAs('R1', '/governance/recovery');
    render(<App />);

    expect(await screen.findByText('No restore drill recorded')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule a drill' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Schedule a restore drill')).toBeDefined();
  });

  it('offers no drill action to a role that cannot run one', async () => {
    getState().recovery.drills = [];

    openAs('R2', '/governance/recovery');
    render(<App />);

    expect(await screen.findByText('No restore drill recorded')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Schedule a drill' })).toBeNull();
    expect(screen.getByText('Read-only recovery view')).toBeDefined();
  });
});

/** The restore the operator asks for: which capture, on what evidence, and what the server says. */
describe('restore request form', () => {
  it('starts from the capture the operator chose, not only the newest one', async () => {
    const seed = getState().recovery.backups[0] as Backup;
    getState().recovery.backups = [
      { ...seed, id: 'bkp-platform-1030' },
      { ...seed, id: 'bkp-platform-1029' },
    ];

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText(/Platform-state backup/) as HTMLSelectElement;
    // The form defaults to the newest capture; an older set stays selectable.
    expect(select.value).toBe('bkp-platform-1030');

    fireEvent.change(select, { target: { value: 'bkp-platform-1029' } });

    expect(select.value).toBe('bkp-platform-1029');
  });

  it('reports a refused restore inside the form that asked for it', async () => {
    server.use(
      http.post('/api/v1/recovery/restores', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/justification-required',
            title: 'A written justification is required',
            status: 422,
            code: 'JUSTIFICATION_REQUIRED',
            detail:
              'A platform restore is a recovery event; it needs a recorded reason and a witness.',
            fieldErrors: [],
            remediation: 'Describe the incident, the scope and the expected outcome.',
          },
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Recover the control plane onto the rebuilt host after the disk failure.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start restore' }));

    expect(await within(dialog).findByText('A written justification is required')).toBeDefined();
  });

  it('says that it is starting while the answer is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/recovery/restores', async () => {
        await gate;
        return HttpResponse.json(
          {
            type: 'x',
            title: 'Late',
            status: 422,
            code: 'LATE',
            detail: 'Late.',
            fieldErrors: [],
            remediation: 'Retry.',
          },
          { status: 422 },
        );
      }),
    );

    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Recover the control plane onto the rebuilt host after the disk failure.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start restore' }));

    expect(await within(dialog).findByText('Starting…')).toBeDefined();
    release();
    await within(dialog).findByText('Late');
  });

  it('closes the restore form without starting anything', async () => {
    openAs('R1', '/governance/recovery');
    render(<App />);
    await screen.findByText('Restore rst-118');

    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
