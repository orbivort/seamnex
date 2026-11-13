import { describe, expect, it } from 'vitest';
import { JobQueryService } from '../../../src/jobs/job-query.service';
import { fakeDb, type Row } from '../../support/fakes';

/**
 * Two degenerate answers from the driver: a count statement that returns no row at all, and a page
 * statement that returns none. The list endpoint is the portal's landing screen, so neither may
 * turn into a `NaN` total or a second, pointless round trip for steps that cannot exist.
 */
const JOB_ID = '018f0000-0000-4000-8000-000000000000';

function jobRow(): Row {
  return {
    id: JOB_ID,
    kind: 'deploy',
    instance_id: null,
    entry_key: null,
    state: 'succeeded',
    requested_by: 'sub-1',
    requested_by_name: 'Alice',
    error_code: null,
    error_detail: null,
    payload: {},
    created_at: new Date('2026-01-02T03:04:05.000Z'),
    started_at: null,
    finished_at: null,
  };
}

describe('JobQueryService.list without rows', () => {
  it('reads a count statement that returned no row as zero, not as NaN', async () => {
    const fake = fakeDb([
      [/SELECT count\(\*\)::text AS count/, []],
      [/FROM deployment_job j/, [jobRow()]],
      [/FROM job_step/, []],
    ]);

    const page = await new JobQueryService(fake.pool).list({});

    expect(page.total).toBe(0);
    expect(page.items).toHaveLength(1);
  });

  it('projects an empty page without asking for the steps of no job', async () => {
    // No `FROM job_step` route exists on purpose: a statement there would fail the fake with its
    // SQL in the message, which is the assertion that the projection stopped early.
    const fake = fakeDb([
      [/SELECT count\(\*\)::text AS count/, [{ count: '0' }]],
      [/FROM deployment_job j/, []],
    ]);

    const page = await new JobQueryService(fake.pool).list({});

    expect(page).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(fake.calls).toHaveLength(2);
    expect(fake.unmatched).toEqual([]);
  });
});
