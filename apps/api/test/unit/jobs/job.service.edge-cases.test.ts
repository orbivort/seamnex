import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../support/fakes';
import { JobService } from '../../../src/jobs/job.service';

/**
 * Two paths the main suite leaves open, both about *what the caller actually sent*: a platform job
 * carries no instance, so the busy-lane lookup must bind `null` rather than throw on `undefined`;
 * and a replay must compare the payload the client sent, which is empty when it sent none.
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
    instance_id: null,
    lane: 'platform',
    kind: 'catalog.reload',
    state: 'queued',
    idempotency_key: null,
    requested_by: 'system',
    error_code: null,
    error_detail: null,
    payload: {},
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
  return { db, service };
}

function conflict(constraint: string): Error {
  return Object.assign(new Error('exclusion'), { code: '23505', constraint });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a platform job that collides with the active-job index', () => {
  it('binds a null instance into the blocking-job lookup and names the lane', async () => {
    const { db, service } = setup([
      [
        'INSERT INTO deployment_job',
        () => Promise.reject(conflict('deployment_job_one_active_platform')),
      ],
      ['WHERE state IN', []],
    ]);

    await expect(
      service.create({ kind: 'catalog.reload', steps: ['reload'] }),
    ).rejects.toMatchObject({ code: 'INSTANCE_BUSY', status: 409 });

    const lookup = db.calls.find((call) => call.sql.includes('WHERE state IN'));
    // A platform job has no instance: the parameter must be an explicit null, not `undefined`.
    expect(lookup?.params).toEqual([null, expect.any(String)]);
  });
});

describe('a transition whose update matched no row', () => {
  it('answers with the row it locked instead of undefined', async () => {
    // The same-state guard returns before the update, so this is the only shape that reaches the
    // fallback: the update reports no row and the caller still needs the job it locked.
    const locked = jobRow({ state: 'queued' });
    const { db, service } = setup([
      ['SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE', [locked]],
      ['UPDATE deployment_job', []],
    ]);

    await expect(service.transition(JOB_ID, 'running')).resolves.toBe(locked);
    expect(db.calls.filter((call) => call.sql.includes('UPDATE deployment_job'))).toHaveLength(1);
  });
});

describe('replaying an idempotency key sent without a body', () => {
  it('compares the stored payload against an empty object', async () => {
    const { db, service } = setup([
      [
        'INSERT INTO deployment_job',
        () => Promise.reject(conflict('deployment_job_idempotency_unique')),
      ],
      ['AND payload = $2::jsonb', { rows: [{}], rowCount: 1 }],
      ['WHERE idempotency_key = $1', [jobRow({ idempotency_key: 'key-blank' })]],
    ]);

    const result = await service.create({
      kind: 'catalog.reload',
      idempotencyKey: 'key-blank',
      steps: ['reload'],
    });

    expect(result.created).toBe(false);
    expect(result.job.id).toBe(JOB_ID);
    const compare = db.calls.find((call) => call.sql.includes('AND payload = $2::jsonb'));
    expect(compare?.params).toEqual(['key-blank', '{}']);
  });
});
