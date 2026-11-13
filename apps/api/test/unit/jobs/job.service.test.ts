import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../support/fakes';
import { JobService, JOB_LOG_CHANNEL_PREFIX } from '../../../src/jobs/job.service';

/**
 * The job model. Three properties are asserted here, each of which was a defect once: creation,
 * steps and the audit row commit together (a job without its evidence is not a job); a uniqueness
 * violation on the idempotency index is the *only* error that means "replay", because replaying on
 * any error hid connection failures behind a second, unrelated query; and Redis is only the
 * execution engine — losing it loses progress delivery, not history.
 */
const h = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  add: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));
vi.mock('bullmq', () => ({
  Queue: class {
    add = h.add;
    close = h.close;
  },
}));

const JOB_ID = '4a1e6f7c-0000-4000-8000-000000000001';

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    instance_id: 'inst-1',
    lane: 'inst-1',
    kind: 'deploy',
    state: 'queued',
    idempotency_key: null,
    requested_by: 'system',
    error_code: null,
    error_detail: null,
    payload: { manual: false },
    created_at: new Date('2026-01-01T00:00:00Z'),
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
    fn(db.client),
  );
  const inc = vi.fn();
  const metrics = {
    jobsCreated: { labels: vi.fn(() => ({ inc })) },
    jobTransitions: { labels: vi.fn(() => ({ inc })) },
  };
  const redis = { publish: vi.fn(async () => 1) };
  const audit = {
    lockChain: vi.fn(async () => undefined),
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
  };
  const service = new JobService(db.pool, redis as never, metrics as never, audit as never);
  return { db, redis, audit, metrics, inc, service };
}

const INPUT = {
  kind: 'deploy',
  instanceId: 'inst-1',
  idempotencyKey: 'key-1',
  requestedBy: 'alice',
  payload: { entryKey: 'D01-01' },
  steps: ['prepare', 'apply', 'verify'],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create', () => {
  it('inserts the job and its steps, audits it and enqueues it', async () => {
    const { db, audit, inc, service } = setup([
      ['INSERT INTO deployment_job', [jobRow()]],
      ['INSERT INTO job_step', []],
    ]);

    const result = await service.create({ ...INPUT, steps: ['prepare', 'verify', 'activate'] });

    expect(result).toEqual({ job: jobRow(), created: true });
    expect(audit.lockChain).toHaveBeenCalledOnce();
    const stepInserts = db.calls.filter((call) => call.sql.includes('INSERT INTO job_step'));
    expect(stepInserts.map((call) => call.params)).toEqual([
      [JOB_ID, 1, 'prepare', 'pending'],
      [JOB_ID, 2, 'verify', 'pending'],
      [JOB_ID, 3, 'activate', 'pending'],
    ]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'job.created',
        actorId: 'alice',
        targetId: JOB_ID,
        // The lane is derived from the instance (`laneForInstance`), so only its presence is pinned
        // here; the mapping itself is M-jobs' own contract.
        detail: { kind: 'deploy', lane: expect.any(String), instanceId: 'inst-1' },
      }),
      expect.anything(),
    );
    expect(inc).toHaveBeenCalledOnce();
    expect(h.add).toHaveBeenCalledWith(
      'run',
      expect.objectContaining({ jobId: JOB_ID, lane: 'inst-1', manual: false }),
      expect.objectContaining({ attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 }),
    );
  });

  it('marks a manual job so the worker does not consume it', async () => {
    const { service } = setup([
      ['INSERT INTO deployment_job', [jobRow({ payload: { manual: true } })]],
      ['INSERT INTO job_step', []],
    ]);

    await service.create({ ...INPUT, payload: { manual: true } });

    expect(h.add).toHaveBeenCalledWith(
      'run',
      expect.objectContaining({ manual: true }),
      expect.anything(),
    );
  });

  it('keeps the job when enqueueing fails, because the database is the queue of record', async () => {
    const { service } = setup([
      ['INSERT INTO deployment_job', [jobRow()]],
      ['INSERT INTO job_step', []],
    ]);
    h.add.mockRejectedValueOnce(new Error('redis down'));

    const result = await service.create(INPUT);

    expect(result.created).toBe(true);
    // `redispatchQueued` picks it up on the next scheduler cycle.
    expect(result.job.id).toBe(JOB_ID);
  });

  it('records a non-Error enqueue failure without throwing', async () => {
    const { service } = setup([
      ['INSERT INTO deployment_job', [jobRow()]],
      ['INSERT INTO job_step', []],
    ]);
    h.add.mockRejectedValueOnce('redis down');

    await expect(service.create(INPUT)).resolves.toMatchObject({ created: true });
  });

  it('replays the job an idempotency key already created', async () => {
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'deployment_job_idempotency_unique',
    });
    const { service } = setup([
      ['INSERT INTO deployment_job', () => Promise.reject(conflict)],
      ['WHERE idempotency_key = $1', [jobRow()]],
      ['AND payload = $2::jsonb', { rows: [{}], rowCount: 1 }],
    ]);

    await expect(service.create(INPUT)).resolves.toEqual({ job: jobRow(), created: false });
  });

  it('reports a key reused with a different body instead of answering with the old job', async () => {
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'deployment_job_idempotency_unique',
    });
    const { service } = setup([
      ['INSERT INTO deployment_job', () => Promise.reject(conflict)],
      // The specific statement first: it also contains the plain key lookup below.
      ['AND payload = $2::jsonb', { rows: [], rowCount: 0 }],
      ['WHERE idempotency_key = $1', [jobRow()]],
    ]);

    await expect(service.create(INPUT)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
  });

  it('reports a conflicting insert that has not committed yet', async () => {
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'deployment_job_idempotency_unique',
    });
    const { service } = setup([
      ['INSERT INTO deployment_job', () => Promise.reject(conflict)],
      ['WHERE idempotency_key = $1', []],
    ]);

    await expect(service.create(INPUT)).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
  });

  it.each(['deployment_job_one_active_per_instance', 'deployment_job_one_active_platform'])(
    'reports the blocking job on %s',
    async (constraint) => {
      const conflict = Object.assign(new Error('exclusion'), {
        code: '23505',
        constraint,
      });
      const { service } = setup([
        ['INSERT INTO deployment_job', () => Promise.reject(conflict)],
        ['WHERE state IN', [{ id: 'blocking-job' }]],
      ]);

      await expect(service.create(INPUT)).rejects.toMatchObject({
        code: 'INSTANCE_BUSY',
        status: 409,
        detail: expect.stringContaining('blocking job blocking-job'),
      });
    },
  );

  it('names the lane when the blocking job cannot be identified', async () => {
    const conflict = Object.assign(new Error('exclusion'), {
      code: '23505',
      constraint: 'deployment_job_one_active_per_instance',
    });
    const { service } = setup([
      ['INSERT INTO deployment_job', () => Promise.reject(conflict)],
      ['WHERE state IN', []],
    ]);

    await expect(service.create(INPUT)).rejects.toMatchObject({
      detail: expect.stringMatching(/^Another job is already active on lane /),
    });
  });

  it('recognises the same violation when the driver nests it under `cause`', async () => {
    const conflict = Object.assign(new Error('wrapped'), {
      cause: { code: '23505', constraint: 'deployment_job_one_active_platform' },
    });
    const { service } = setup([
      ['INSERT INTO deployment_job', () => Promise.reject(conflict)],
      ['WHERE state IN', []],
    ]);

    await expect(service.create(INPUT)).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
  });

  it('rethrows an unrelated failure instead of replaying it', async () => {
    const { service } = setup([
      ['INSERT INTO deployment_job', () => Promise.reject(new Error('connection reset'))],
    ]);

    await expect(service.create(INPUT)).rejects.toThrow('connection reset');
  });

  it('defaults the actor, the instance and the payload for a platform job', async () => {
    const { db, audit, service } = setup([
      ['INSERT INTO deployment_job', [jobRow({ instance_id: null, requested_by: 'system' })]],
      ['INSERT INTO job_step', []],
    ]);

    await service.create({ kind: 'catalog.reload', steps: ['reload'] });

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO deployment_job'));
    expect(insert?.params).toEqual([
      null,
      expect.any(String),
      'catalog.reload',
      null,
      'system',
      '{}',
    ]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'system',
        detail: expect.objectContaining({ instanceId: null }),
      }),
      expect.anything(),
    );
  });

  it('refuses a replay it cannot key, because that is a programming error', async () => {
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'deployment_job_idempotency_unique',
    });
    const { service } = setup([['INSERT INTO deployment_job', () => Promise.reject(conflict)]]);

    await expect(service.create({ kind: 'deploy', steps: [] })).rejects.toThrow(
      /idempotency replay without a key/,
    );
  });

  it('refuses when the insert returns no row', async () => {
    const { service } = setup([['INSERT INTO deployment_job', []]]);

    await expect(service.create(INPUT)).rejects.toThrow(/job insert returned no row/);
  });
});

describe('transition', () => {
  it('moves the job and audits the move, recording a failure as a failure', async () => {
    const { db, audit, inc, service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [jobRow()]],
      ['UPDATE deployment_job', [jobRow({ state: 'failed', error_code: 'E1' })]],
    ]);

    const job = await service.transition(JOB_ID, 'failed', { errorCode: 'E1' });

    expect(job.state).toBe('failed');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'job.failed',
        outcome: 'failure',
        detail: { from: 'queued', to: 'failed', errorCode: 'E1' },
      }),
      expect.anything(),
    );
    const update = db.calls.find((call) => call.sql.includes('UPDATE deployment_job'));
    expect(update?.params).toEqual([JOB_ID, 'failed', 'E1', null]);
    expect(inc).toHaveBeenCalledOnce();
  });

  it('is a no-op when the job is already in the target state', async () => {
    const { audit, service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [jobRow({ state: 'running' })]],
    ]);

    await expect(service.transition(JOB_ID, 'running')).resolves.toMatchObject({
      state: 'running',
    });
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses a transition the lifecycle does not allow', async () => {
    const { service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [jobRow({ state: 'succeeded' })]],
    ]);

    await expect(service.transition(JOB_ID, 'running')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
    });
  });

  it('answers 404 for a job that does not exist', async () => {
    const { service } = setup([['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', []]]);

    await expect(service.transition(JOB_ID, 'running')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('answers with the locked row when the update returns nothing', async () => {
    const locked = jobRow({ state: 'running' });
    const { service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [locked]],
      ['UPDATE deployment_job', []],
    ]);

    await expect(service.transition(JOB_ID, 'running')).resolves.toBe(locked);
  });
});

describe('steps', () => {
  it('moves a step and stamps the matching timestamps', async () => {
    const { db, service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [jobRow({ state: 'running' })]],
      ['UPDATE job_step', []],
    ]);

    await service.setStep(JOB_ID, 2, 'running', 'pulling image');

    const update = db.calls.find((call) => call.sql.includes('UPDATE job_step'));
    expect(update?.params).toEqual([JOB_ID, 2, 'running', 'pulling image']);
  });

  it('does nothing to a cancelled job except marking steps skipped', async () => {
    const { db, service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [jobRow({ state: 'cancelled' })]],
      ['UPDATE job_step', []],
    ]);

    await service.setStep(JOB_ID, 2, 'running');
    expect(db.calls.some((call) => call.sql.includes('UPDATE job_step'))).toBe(false);

    await service.setStep(JOB_ID, 2, 'skipped');
    expect(db.calls.some((call) => call.sql.includes('UPDATE job_step'))).toBe(true);
  });

  it('answers 404 for a step move on a job that does not exist', async () => {
    const { service } = setup([['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', []]]);

    await expect(service.setStep(JOB_ID, 1, 'running')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lists the steps in sequence order', async () => {
    const steps = [{ job_id: JOB_ID, seq: 1, name: 'prepare', state: 'pending', message: null }];
    const { db, service } = setup([
      ['SELECT * FROM job_step WHERE job_id = $1 ORDER BY seq', steps],
    ]);

    await expect(service.steps(JOB_ID)).resolves.toEqual(steps);
    expect(db.calls[0]?.params).toEqual([JOB_ID]);
  });
});

describe('logs', () => {
  const logRow = {
    id: '10',
    job_id: JOB_ID,
    seq: 3,
    ts: new Date('2026-01-01T00:00:05Z'),
    stream: 'stdout',
    line: 'pulling',
  };

  it('persists the line, then publishes it', async () => {
    const { db, redis, service } = setup([
      ['pg_advisory_xact_lock', []],
      ['INSERT INTO job_log', [logRow]],
    ]);

    const row = await service.appendLog(JOB_ID, 'stdout', 'pulling');

    expect(row).toBe(logRow);
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO job_log'));
    // The line is masked before it is stored, so a secret cannot enter the log table.
    expect(insert?.params).toEqual([JOB_ID, 'stdout', 'pulling']);
    expect(redis.publish).toHaveBeenCalledWith(
      `${JOB_LOG_CHANNEL_PREFIX}${JOB_ID}`,
      JSON.stringify({
        id: '10',
        seq: 3,
        stream: 'stdout',
        line: 'pulling',
        ts: '2026-01-01T00:00:05.000Z',
      }),
    );
  });

  it('keeps the row when the publish fails: a missed publish costs latency, not truth', async () => {
    const { redis, service } = setup([
      ['pg_advisory_xact_lock', []],
      ['INSERT INTO job_log', [logRow]],
    ]);
    redis.publish.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.appendLog(JOB_ID, 'stdout', 'line')).resolves.toBe(logRow);
  });

  it('refuses a log insert that returns no row', async () => {
    const { service } = setup([
      ['pg_advisory_xact_lock', []],
      ['INSERT INTO job_log', []],
    ]);

    await expect(service.appendLog(JOB_ID, 'stdout', 'line')).rejects.toThrow(
      /job_log insert returned no row/,
    );
  });

  it('treats a non-numeric cursor as the beginning of the stream', async () => {
    const { db, service } = setup([['SELECT id, job_id, seq, ts, stream, line', []]]);

    await service.logs(JOB_ID, 'not-a-number', 50);

    // A client-supplied header must not become a cast error inside an open SSE response.
    expect(db.calls[0]?.params).toEqual([JOB_ID, '0', 50]);
  });

  it('passes a numeric cursor through', async () => {
    const { db, service } = setup([['SELECT id, job_id, seq, ts, stream, line', []]]);

    await service.logs(JOB_ID, '900');

    expect(db.calls[0]?.params).toEqual([JOB_ID, '900', 200]);
  });
});

describe('cancel', () => {
  it('cancels before apply and audits it', async () => {
    const { db, audit, service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [jobRow({ state: 'running' })]],
      [
        'SELECT * FROM job_step WHERE job_id = $1 ORDER BY seq',
        [
          { job_id: JOB_ID, seq: 1, name: 'prepare', state: 'succeeded', message: null },
          { job_id: JOB_ID, seq: 2, name: 'apply', state: 'pending', message: null },
        ],
      ],
      ['UPDATE deployment_job', [jobRow({ state: 'cancelled' })]],
    ]);

    await expect(service.cancel(JOB_ID, 'alice')).resolves.toMatchObject({ state: 'cancelled' });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job.cancelled', actorId: 'alice' }),
      expect.anything(),
    );
    expect(db.calls.some((call) => call.sql.includes('UPDATE deployment_job'))).toBe(true);
  });

  it('returns an already cancelled job unchanged', async () => {
    const { audit, service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [jobRow({ state: 'cancelled' })]],
    ]);

    await expect(service.cancel(JOB_ID, 'alice')).resolves.toMatchObject({ state: 'cancelled' });
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses to cancel a job the lifecycle has already closed', async () => {
    const { service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [jobRow({ state: 'succeeded' })]],
    ]);

    await expect(service.cancel(JOB_ID, 'alice')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
  });

  it('refuses to cancel once apply has started: that needs a compensating rollback', async () => {
    const { service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [jobRow({ state: 'running' })]],
      [
        'SELECT * FROM job_step WHERE job_id = $1 ORDER BY seq',
        [{ job_id: JOB_ID, seq: 1, name: 'apply', state: 'succeeded', message: null }],
      ],
    ]);

    await expect(service.cancel(JOB_ID, 'alice')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: expect.stringContaining('already applied'),
    });
  });
});

describe('retry', () => {
  it('creates a new job that references the failed one', async () => {
    const { db, service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1', [jobRow({ state: 'failed' })]],
      [
        'SELECT * FROM job_step WHERE job_id = $1 ORDER BY seq',
        [
          { job_id: JOB_ID, seq: 1, name: 'prepare', state: 'succeeded', message: null },
          { job_id: JOB_ID, seq: 2, name: 'apply', state: 'failed', message: 'boom' },
        ],
      ],
      ['INSERT INTO deployment_job', [jobRow({ id: 'job-2' })]],
      ['INSERT INTO job_step', []],
    ]);

    const result = await service.retry(JOB_ID, 'alice');

    expect(result.job.id).toBe('job-2');
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO deployment_job'));
    expect(JSON.parse(String(insert?.params[5]))).toEqual({ manual: false, retryOf: JOB_ID });
    const steps = db.calls.filter((call) => call.sql.includes('INSERT INTO job_step'));
    expect(steps.map((call) => call.params[2])).toEqual(['prepare', 'apply']);
  });

  it.each(['queued', 'running', 'succeeded'])('refuses to retry a %s job', async (state) => {
    const { service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1', [jobRow({ state })]],
    ]);

    await expect(service.retry(JOB_ID, 'alice')).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
});

describe('housekeeping', () => {
  it('answers 404 for an unknown job', async () => {
    const { service } = setup([['SELECT * FROM deployment_job WHERE id = $1', []]]);

    await expect(service.get(JOB_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('redispatches the queued jobs that Redis has not seen', async () => {
    const { db, service } = setup([
      [
        "WHERE state = 'queued' AND created_at",
        { rows: [jobRow(), jobRow({ id: 'job-2' })], rowCount: 2 },
      ],
    ]);

    await expect(service.redispatchQueued(5)).resolves.toBe(2);
    expect(h.add).toHaveBeenCalledTimes(2);
    expect(db.calls[0]?.params).toEqual([5]);
  });

  it('reports a redispatch it could not enqueue, and keeps the count', async () => {
    const { service } = setup([
      ["WHERE state = 'queued' AND created_at", { rows: [jobRow()], rowCount: 1 }],
    ]);
    h.add.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.redispatchQueued()).resolves.toBe(1);
  });

  it('reports zero redispatched jobs when the driver returns no row count', async () => {
    const { service } = setup([
      ["WHERE state = 'queued' AND created_at", { rows: [], rowCount: null }],
    ]);

    await expect(service.redispatchQueued()).resolves.toBe(0);
  });

  it('ends the idempotency window after a day', async () => {
    const { db, service } = setup([
      ['UPDATE deployment_job\n          SET idempotency_key = NULL', { rows: [], rowCount: 3 }],
    ]);

    await expect(service.reapIdempotencyKeys()).resolves.toBe(3);
    expect(db.calls[0]?.sql).toContain("interval '24 hours'");
  });

  it('reports zero when the driver returns no row count', async () => {
    const { service } = setup([
      ['UPDATE deployment_job\n          SET idempotency_key = NULL', { rows: [], rowCount: null }],
    ]);

    await expect(service.reapIdempotencyKeys()).resolves.toBe(0);
  });

  it('closes the queue once, however often it is asked', async () => {
    const { service } = setup();

    await service.close();
    await service.close();
    await service.onApplicationShutdown();

    expect(h.close).toHaveBeenCalledOnce();
  });
});
