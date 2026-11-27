import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import { AppError } from '../../../src/common/problem/app-error';
import { fakeDb, type Row } from '../../support/fakes';
import { ABANDONED_FAILURE_CODE, TRANSIENT_FAILURE_CODE } from '../../../src/jobs/job-failure';
import { JobRetryService } from '../../../src/jobs/job-retry.service';

/**
 * NFR-6.5 — the retry pass is the difference between a transient outage costing a person an hour
 * and costing nobody anything. Two properties carry that promise, and both are easy to get subtly
 * wrong: a retry must not replay a pipeline that already applied its change, and a job whose worker
 * disappeared must be settled rather than left holding its lane for ever.
 */
const CONFIG = {
  SEAMNEX_JOB_RETRY_MAX_ATTEMPTS: 3,
  SEAMNEX_JOB_RETRY_BACKOFF_MS: 60_000,
  SEAMNEX_JOB_RETRY_MAX_DELAY_MS: 900_000,
  SEAMNEX_JOB_RETRY_BATCH: 25,
  SEAMNEX_JOB_STALE_AFTER_MS: 3_600_000,
} as unknown as AppConfig;

const NOW = new Date('2026-03-04T09:00:00.000Z');
const MINUTE = 60_000;

const DEPLOY_STAGES = [
  { name: 'resolve', step: 'Resolve source', run: async () => undefined },
  { name: 'apply', step: 'Apply', run: async () => undefined },
];

function failed(overrides: Row = {}): Row {
  return {
    id: 'job-1',
    kind: 'deploy',
    instance_id: 'inst-1',
    requested_by: 'alice',
    error_code: 'UNAVAILABLE',
    payload: {},
    finished_at: new Date(NOW.getTime() - 10 * MINUTE),
    ...overrides,
  };
}

/** A row set, or a producer: the second shape is how a failure path is expressed. */
type RouteAnswer = Row[] | ((sql: string, params: readonly unknown[]) => unknown);

function setup(
  options: {
    failed?: Row[];
    running?: RouteAnswer;
    steps?: Row[];
    stages?: { name: string; step: string; run: () => Promise<void> }[];
    stepsFor?: string[];
    failureHandler?: (() => Promise<void>) | undefined;
    candidateError?: Error;
  } = {},
) {
  const db = fakeDb([
    ["j.state = 'running'", options.running === undefined ? [] : options.running],
    [
      'j.error_code = ANY',
      options.candidateError === undefined
        ? () => Promise.resolve(options.failed ?? [])
        : () => Promise.reject(options.candidateError),
    ],
    ['FROM job_step WHERE job_id = ANY', options.steps ?? []],
  ]);

  const created = vi.fn(async () => ({ job: { id: 'job-2' }, created: true }));
  const jobs = {
    create: created,
    transition: vi.fn(async () => ({ id: 'job-1', state: 'failed' })),
    appendLog: vi.fn(async () => ({})),
    get: vi.fn(async () => ({ state: 'running' })),
  };
  const pipelines = {
    stepsFor: vi.fn(() => options.stepsFor ?? ['Resolve source', 'Apply']),
    stages: vi.fn(() => options.stages ?? DEPLOY_STAGES),
    failureHandler: vi.fn(() => options.failureHandler),
  };
  const audit = {
    append: vi.fn(async (_input: Record<string, unknown>) => ({ seq: '1', hash: 'h' })),
  };
  const outcomes: string[] = [];
  const metrics = {
    jobRetries: {
      labels: vi.fn((outcome: string) => {
        outcomes.push(outcome);
        return { inc: vi.fn() };
      }),
    },
  };

  const service = new JobRetryService(
    db.pool,
    CONFIG,
    jobs as never,
    pipelines as never,
    audit as never,
    metrics as never,
  );
  return { db, jobs, pipelines, audit, outcomes, service, created };
}

describe('retryTransient', () => {
  it('queues a successor that references the failed job and carries the next attempt', async () => {
    const { jobs, audit, outcomes, service, db } = setup({
      failed: [failed()],
      steps: [{ job_id: 'job-1', name: 'Apply', state: 'pending' }],
    });

    const result = await service.retryTransient(NOW);

    expect(result).toEqual({ scheduled: 1, skipped: 0 });
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deploy',
        instanceId: 'inst-1',
        requestedBy: 'system',
        payload: { retryOf: 'job-1', attempt: 2 },
        steps: ['Resolve source', 'Apply'],
      }),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'job.retry.scheduled',
        targetId: 'job-2',
        detail: expect.objectContaining({ previousJobId: 'job-1', attempt: 2, delayMs: 60_000 }),
      }),
    );
    expect(outcomes).toEqual(['scheduled']);
    // The chain is what makes the pass idempotent: a job that already has a successor is not retried.
    expect(db.calls.some((call) => call.sql.includes('NOT EXISTS'))).toBe(true);
    // Both logs carry the policy's one visible trace: two unrelated rows in the console read as a
    // second operator action, which is exactly what an automatic retry is not.
    expect(jobs.appendLog).toHaveBeenCalledWith(
      'job-2',
      'system',
      expect.stringContaining('Retried automatically after job job-1 failed with UNAVAILABLE'),
    );
    expect(jobs.appendLog).toHaveBeenCalledWith(
      'job-1',
      'system',
      expect.stringContaining('Retry queued automatically: job job-2'),
    );
    expect(jobs.appendLog).toHaveBeenCalledWith(
      'job-2',
      'system',
      expect.stringContaining('attempt 2 of 3'),
    );
  });

  it('does not let an exhausted failure starve the batch of newer candidates', async () => {
    const { db, service } = setup({ failed: [] });

    await service.retryTransient(NOW);

    // The bound belongs in the statement, not only in the per-row refusal: the query orders oldest
    // first, so 25 terminal transient failures would occupy every future pass and no new failure
    // would ever be examined. `payload.attempt` is text in jsonb, hence the numeric guard.
    const sql = String(db.calls.find((call) => call.sql.includes('j.error_code = ANY'))?.sql);
    expect(sql).toContain("j.payload->>'attempt' ~ '^[0-9]+$'");
    expect(sql).toContain('< $3');
  });

  it('never replays a pipeline that had started its apply stage', async () => {
    const { jobs, outcomes, service } = setup({
      failed: [failed()],
      steps: [{ job_id: 'job-1', name: 'Apply', state: 'succeeded' }],
    });

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 0, skipped: 1 });
    expect(jobs.create).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['skipped_apply_started']);
  });

  it('refuses an apply-gated kind whose boundary cannot be resolved', async () => {
    const { jobs, outcomes, service } = setup({
      failed: [failed()],
      stages: [{ name: 'resolve', step: 'Resolve source', run: async () => undefined }],
    });

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 0, skipped: 1 });
    expect(jobs.create).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['skipped_unproven_boundary']);
  });

  it('retries a kind whose first stage is apply, because repeating it is idempotent', async () => {
    const { jobs, service } = setup({
      failed: [failed({ kind: 'stop', payload: {} })],
      steps: [{ job_id: 'job-1', name: 'stop containers', state: 'failed' }],
      stepsFor: ['stop containers', 'Record state'],
    });

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 1, skipped: 0 });
    expect(jobs.create).toHaveBeenCalledOnce();
  });

  it('stops when the attempt budget is spent', async () => {
    const { jobs, outcomes, service } = setup({
      failed: [failed({ payload: { attempt: 3 } })],
    });

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 0, skipped: 1 });
    expect(jobs.create).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['skipped_attempts_spent']);
  });

  it('waits out the backoff instead of retrying a flapping dependency immediately', async () => {
    const { jobs, outcomes, service } = setup({
      failed: [failed({ finished_at: new Date(NOW.getTime() - 5_000) })],
    });

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 0, skipped: 1 });
    expect(jobs.create).not.toHaveBeenCalled();
    // A wait is not a decision: no counter for a job that is simply inside its backoff window.
    expect(outcomes).toEqual([]);
  });

  it('doubles the wait with each attempt instead of using one global cut-off', async () => {
    const { service, db, audit } = setup({
      failed: [failed({ id: 'job-a' }), failed({ id: 'job-b', payload: { attempt: 2 } })],
      steps: [],
    });

    await service.retryTransient(new Date(NOW.getTime() + 3_600_000));

    // The candidate query is the same for every row; the decision is per row. The third parameter
    // bounds the attempts inside the statement, so a terminal failure cannot occupy the batch (see
    // the starvation test below).
    expect(db.calls.find((call) => call.sql.includes('j.error_code = ANY'))?.params).toEqual([
      [
        TRANSIENT_FAILURE_CODE,
        'UNAVAILABLE',
        'ADAPTER_UNAVAILABLE',
        'REPOSITORY_UNAVAILABLE',
        'AUTH_PROVIDER_UNAVAILABLE',
        'SECRET_UNAVAILABLE',
        'RATE_LIMITED',
      ],
      25,
      3,
    ]);
    expect(
      audit.append.mock.calls.map(
        (call) => (call[0] as { detail: Record<string, unknown> }).detail,
      ),
    ).toEqual([
      expect.objectContaining({ previousJobId: 'job-a', attempt: 2, delayMs: 60_000 }),
      expect.objectContaining({ previousJobId: 'job-b', attempt: 3, delayMs: 120_000 }),
    ]);
  });

  const refusals: [string, Row, string][] = [
    [
      'a manual job, which exists for observation only',
      { payload: { manual: true } },
      'skipped_manual',
    ],
    ['a restore, which a human must decide about', { kind: 'restore' }, 'skipped_needs_human'],
    [
      'a decisive failure, which repeats identically',
      { error_code: 'COMPOSE_POLICY_BLOCKED' },
      'skipped_not_transient',
    ],
  ];
  it.each(refusals)('leaves %s alone', async (_label, overrides, outcome) => {
    const { jobs, outcomes, service } = setup({ failed: [failed(overrides)] });

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 0, skipped: 1 });
    expect(jobs.create).not.toHaveBeenCalled();
    expect(outcomes).toEqual([outcome]);
  });

  it('treats a busy lane as expected, not as a failed pass', async () => {
    const { jobs, outcomes, service } = setup({ failed: [failed()] });
    jobs.create.mockRejectedValueOnce(
      new AppError({ code: 'INSTANCE_BUSY', status: 409, detail: 'already running' }),
    );

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 0, skipped: 1 });
    expect(outcomes).toEqual(['skipped_busy']);
  });

  it('still retries when the audit row cannot be written, because the job already exists', async () => {
    const { audit, service, outcomes } = setup({ failed: [failed()] });
    audit.append.mockRejectedValueOnce(new Error('audit chain unavailable'));

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 1, skipped: 0 });
    expect(outcomes).toEqual(['scheduled']);
  });

  it('still retries when either log line cannot be written', async () => {
    const { jobs, service, outcomes } = setup({ failed: [failed()] });
    jobs.appendLog.mockRejectedValue(new Error('job_log partition unavailable'));

    // The note is a courtesy to the operator; refusing a queued retry because the log is unwritable
    // would make the platform's durability depend on its narration.
    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 1, skipped: 0 });
    expect(outcomes).toEqual(['scheduled']);
    expect(jobs.create).toHaveBeenCalledOnce();
  });

  it('describes a non-Error refusal without throwing', async () => {
    const { jobs, outcomes, service } = setup({ failed: [failed()] });
    jobs.create.mockRejectedValueOnce('constraint');

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 0, skipped: 1 });
    expect(outcomes).toEqual(['skipped_error']);
  });

  it('keeps going when one successor cannot be created', async () => {
    const { jobs, outcomes, service } = setup({
      failed: [failed({ id: 'job-a' }), failed({ id: 'job-b' })],
    });
    jobs.create.mockRejectedValueOnce(new Error('constraint')).mockResolvedValueOnce({
      job: { id: 'job-c' },
      created: true,
    } as never);

    await expect(service.retryTransient(NOW)).resolves.toEqual({ scheduled: 1, skipped: 1 });
    expect(outcomes).toEqual(['skipped_error', 'scheduled']);
  });
});

describe('abandonStaleRunning', () => {
  it('settles a job whose worker disappeared, through the module’s own failure handler', async () => {
    const handler = vi.fn(async () => undefined);
    const { jobs, pipelines, service, outcomes } = setup({
      running: [
        {
          id: 'job-9',
          kind: 'platform-restore',
          instance_id: null,
          requested_by: 'alice',
          payload: { restoreId: 'run-1' },
        },
      ],
      failureHandler: handler,
    });

    await expect(service.abandonStaleRunning()).resolves.toBe(1);

    // The owner settles `restore_run`; without this the run would sit `running` for ever.
    expect(pipelines.failureHandler).toHaveBeenCalledWith('platform-restore');
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-9', action: 'platform-restore' }),
      expect.any(Error),
    );
    expect(jobs.transition).toHaveBeenCalledWith('job-9', 'failed', {
      errorCode: ABANDONED_FAILURE_CODE,
      errorDetail: expect.stringContaining('worker that held this job is gone'),
      actorId: 'scheduler',
    });
    expect(jobs.appendLog).toHaveBeenCalledWith('job-9', 'system', expect.any(String));
    expect(outcomes).toEqual(['abandoned']);
  });

  it('still marks the job failed when the owner’s failure handler throws', async () => {
    const { jobs, service, outcomes } = setup({
      running: [
        {
          id: 'job-9',
          kind: 'platform-restore',
          instance_id: null,
          requested_by: 'alice',
          payload: { restoreId: 'run-1' },
        },
      ],
      failureHandler: async () => {
        throw new Error('restore_run is locked');
      },
    });

    // A handler that throws must not leave the row `running`: that is the stuck lane this pass
    // exists to clear, and the transition is the part an operator can act on.
    await expect(service.abandonStaleRunning()).resolves.toBe(1);
    expect(jobs.transition).toHaveBeenCalledWith('job-9', 'failed', expect.anything());
    expect(outcomes).toEqual(['abandoned']);
  });

  it('ignores a job that moved on between the read and the update', async () => {
    const { jobs, service } = setup({
      running: [
        { id: 'job-9', kind: 'deploy', instance_id: 'inst-1', requested_by: 'alice', payload: {} },
      ],
    });
    jobs.transition.mockRejectedValueOnce(
      new AppError({ code: 'STATE_CONFLICT', status: 409, detail: 'no' }),
    );

    await expect(service.abandonStaleRunning()).resolves.toBe(0);
  });

  it('derives liveness from the log and the running step, not from the start time alone', async () => {
    const { service, db } = setup();

    await service.abandonStaleRunning();

    const query = db.calls.find((call) => call.sql.includes("j.state = 'running'"))?.sql ?? '';
    expect(query).toContain('max(l.ts) FROM job_log');
    expect(query).toContain("s.state = 'running'");
    expect(query).toContain('make_interval');
  });
});

describe('tick', () => {
  it('answers zeros instead of throwing when the database refuses the candidate query', async () => {
    const { service } = setup({ candidateError: new Error('connection reset') });

    await expect(service.tick(NOW)).resolves.toEqual({
      scheduled: 0,
      skipped: 0,
      abandoned: 0,
    });
  });

  it('still retries when the abandonment pass cannot read the table', async () => {
    const { service, jobs } = setup({
      running: () => {
        throw new Error('catalog lookup unavailable');
      },
      failed: [failed()],
    });

    await expect(service.tick(NOW)).resolves.toEqual({
      scheduled: 1,
      skipped: 0,
      abandoned: 0,
    });
    expect(jobs.create).toHaveBeenCalledOnce();
  });

  it('runs the abandonment pass even when the retry pass fails', async () => {
    const { jobs, service } = setup({
      running: [
        { id: 'job-9', kind: 'deploy', instance_id: 'inst-1', requested_by: 'alice', payload: {} },
      ],
      candidateError: new Error('connection reset'),
    });

    const result = await service.tick(NOW);

    expect(result.abandoned).toBe(1);
    expect(jobs.transition).toHaveBeenCalledOnce();
  });
});
