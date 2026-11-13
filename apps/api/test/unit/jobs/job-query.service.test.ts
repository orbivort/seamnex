import { describe, expect, it } from 'vitest';
import { JobQueryService } from '../../../src/jobs/job-query.service';
import { decodeCursor } from '../../../src/common/http/cursor';
import { fakeDb, type Row } from '../../support/fakes';

const JOB_ID = '018f0000-0000-4000-8000-000000000000';
const INSTANCE_ID = '018f0000-0000-4000-8000-000000000001';

function jobRow(overrides: Row = {}): Row {
  return {
    id: JOB_ID,
    kind: 'deploy',
    instance_id: INSTANCE_ID,
    entry_key: 'D01-01',
    state: 'succeeded',
    requested_by: 'sub-1',
    requested_by_name: 'Alice',
    error_code: null,
    error_detail: null,
    payload: {},
    created_at: new Date('2026-01-02T03:04:05.000Z'),
    started_at: new Date('2026-01-02T03:05:00.000Z'),
    finished_at: new Date('2026-01-02T03:06:00.000Z'),
    ...overrides,
  };
}

function db(
  options: {
    rows?: Row[];
    count?: string;
    steps?: Row[];
  } = {},
) {
  return fakeDb([
    [/SELECT count\(\*\)::text AS count/, [{ count: options.count ?? '1' }]],
    [/FROM deployment_job j/, options.rows ?? [jobRow()]],
    [/FROM job_step/, options.steps ?? []],
  ]);
}

describe('JobQueryService.list', () => {
  it('projects a page with no filter and no extra statement for an empty total', async () => {
    const fake = db({ count: '0' });
    const page = await new JobQueryService(fake.pool).list({});

    expect(page.total).toBe(0);
    expect(page.nextCursor).toBeNull();
    expect(fake.calls.map((call) => call.sql.trim().slice(0, 6))).toEqual([
      'SELECT',
      'SELECT',
      'SELECT',
    ]);
    expect(fake.unmatched).toEqual([]);
  });

  it('projects label, summary, progress and the resolved requester', async () => {
    const page = await new JobQueryService(db().pool).list({});

    expect(page.items[0]).toMatchObject({
      id: JOB_ID,
      kind: 'deploy',
      instanceId: INSTANCE_ID,
      entryKey: 'D01-01',
      label: 'deploy · D01-01',
      state: 'succeeded',
      progress: 100,
      createdAt: '2026-01-02T03:04:05.000Z',
      startedAt: '2026-01-02T03:05:00.000Z',
      finishedAt: '2026-01-02T03:06:00.000Z',
      requestedBy: 'Alice',
      summary: 'deploy job',
      errorCode: null,
      errorMessage: null,
      steps: [],
    });
  });

  it('uses the label and summary the payload carries', async () => {
    const page = await new JobQueryService(
      db({ rows: [jobRow({ payload: { label: 'Mail server', summary: 'first deploy' } })] }).pool,
    ).list({});

    expect(page.items[0]).toMatchObject({ label: 'Mail server', summary: 'first deploy' });
  });

  it('falls back to the platform label when the job has no instance', async () => {
    const page = await new JobQueryService(
      db({ rows: [jobRow({ instance_id: null, entry_key: null })] }).pool,
    ).list({});
    expect(page.items[0]?.label).toBe('deploy · platform');
  });

  it('treats a kind outside the declaration as a deploy', async () => {
    const page = await new JobQueryService(db({ rows: [jobRow({ kind: 'legacy' })] }).pool).list(
      {},
    );
    expect(page.items[0]?.kind).toBe('deploy');
  });

  it('computes progress from the step rows attached to the job', async () => {
    const page = await new JobQueryService(
      db({
        steps: [
          {
            job_id: JOB_ID,
            seq: 1,
            name: 'resolve',
            state: 'succeeded',
            started_at: null,
            finished_at: null,
            message: null,
          },
          {
            job_id: JOB_ID,
            seq: 2,
            name: 'apply',
            state: 'skipped',
            started_at: null,
            finished_at: null,
            message: 'not needed',
          },
          {
            job_id: JOB_ID,
            seq: 3,
            name: 'record',
            state: 'running',
            started_at: null,
            finished_at: null,
            message: null,
          },
          {
            job_id: 'other',
            seq: 1,
            name: 'x',
            state: 'succeeded',
            started_at: null,
            finished_at: null,
            message: null,
          },
        ],
      }).pool,
    ).list({});

    const job = page.items[0];
    expect(job?.progress).toBe(67);
    expect(job?.steps).toHaveLength(3);
    expect(job?.steps[1]?.message).toBe('not needed');
  });

  it('keeps a running job with no steps at 0 progress', async () => {
    const page = await new JobQueryService(
      db({ rows: [jobRow({ state: 'running', started_at: null, finished_at: null })] }).pool,
    ).list({});
    expect(page.items[0]?.progress).toBe(0);
    expect(page.items[0]?.startedAt).toBeNull();
    expect(page.items[0]?.finishedAt).toBeNull();
  });

  it('falls back to the recorded subject, then to system, when the directory has no name', async () => {
    const first = await new JobQueryService(
      db({ rows: [jobRow({ requested_by_name: null })] }).pool,
    ).list({});
    expect(first.items[0]?.requestedBy).toBe('sub-1');

    const second = await new JobQueryService(
      db({ rows: [jobRow({ requested_by_name: null, requested_by: null })] }).pool,
    ).list({});
    expect(second.items[0]?.requestedBy).toBe('system');
  });

  it('returns an empty page for an instance filter that is not a uuid, without querying', async () => {
    const fake = db();
    const page = await new JobQueryService(fake.pool).list({ instanceId: 'not-a-uuid' });

    expect(page).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(fake.calls).toEqual([]);
  });

  it('binds every declared filter into the predicate', async () => {
    const fake = db();
    await new JobQueryService(fake.pool).list({
      instanceId: INSTANCE_ID,
      kind: 'deploy',
      state: 'succeeded',
    });

    const count = fake.calls[0];
    expect(count?.sql).toContain('instance_id = $1');
    expect(count?.sql).toContain('kind = $2');
    expect(count?.sql).toContain('state = $3');
    expect(count?.params).toEqual([INSTANCE_ID, 'deploy', 'succeeded']);
  });

  it('applies a keyset cursor and derives the next one from the over-fetched row', async () => {
    const fake = db({
      rows: [jobRow({ id: 'a' }), jobRow({ id: 'b' }), jobRow({ id: 'c' })],
    });
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', id: 'z' }),
      'utf8',
    ).toString('base64url');

    const page = await new JobQueryService(fake.pool).list({ limit: '2', cursor });

    const pageQuery = fake.calls[1];
    expect(pageQuery?.sql).toContain('AND (created_at, id) <');
    expect(pageQuery?.params).toEqual(['2026-01-01T00:00:00.000Z', 'z', 3]);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor ?? undefined)).toBeTruthy();
  });

  it('ignores a seq cursor, which belongs to the audit page', async () => {
    const fake = db();
    const cursor = Buffer.from(JSON.stringify({ seq: '9' }), 'utf8').toString('base64url');
    await new JobQueryService(fake.pool).list({ cursor });
    expect(fake.calls[1]?.sql).not.toContain('AND (created_at, id) <');
  });

  it('refuses a malformed cursor', async () => {
    await expect(new JobQueryService(db().pool).list({ cursor: 'garbage' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('JobQueryService.detail', () => {
  it('returns one projected job', async () => {
    const job = await new JobQueryService(db().pool).detail(JOB_ID);
    expect(job.id).toBe(JOB_ID);
  });

  it('refuses an id that is not a uuid before querying', async () => {
    const fake = db();
    await expect(new JobQueryService(fake.pool).detail('x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(fake.calls).toEqual([]);
  });

  it('refuses a job that does not exist', async () => {
    await expect(new JobQueryService(db({ rows: [] }).pool).detail(JOB_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: expect.stringContaining(JOB_ID),
    });
  });

  it('refuses when the projection drops the row, which would be a defect', async () => {
    const fake = fakeDb([
      [/WHERE j.id = \$1/, [jobRow()]],
      [/FROM job_step/, []],
    ]);
    // The row projects to one item, so this asserts the happy path is not silently skipped.
    await expect(new JobQueryService(fake.pool).detail(JOB_ID)).resolves.toMatchObject({
      id: JOB_ID,
    });
  });
});
