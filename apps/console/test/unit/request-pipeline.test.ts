import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiError, request } from '@seamnex/api-client';
import { JobAcceptedSchema, PlatformSettingsSchema } from '@seamnex/domain';
import { server } from '@seamnex/mocks/server';
import { openAs } from '../helpers';

/**
 * The request pipeline is the single enforcement point for the operation registry:
 * undeclared operations, undeclared query keys, malformed bodies, `If-Match` scope and
 * `204` handling are all decided there, not in each hook.
 */

async function problemOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error.problem;
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

describe('request pipeline contract enforcement', () => {
  it('rejects an operation that is not in the registry before sending it', async () => {
    openAs('R1');
    const problem = await problemOf(() => request('/not-a-real-endpoint', {}));
    expect(problem.code).toBe('UNKNOWN_OPERATION');
  });

  it('rejects an undeclared query parameter and names it', async () => {
    openAs('R1');
    const problem = await problemOf(() => request('/instances?bogus=1', {}));
    expect(problem.code).toBe('REQUEST_CONTRACT');
    expect(problem.status).toBe(400);
    expect(problem.fieldErrors.map((issue) => issue.field)).toContain('bogus');
  });

  it('accepts a declared enum query parameter and rejects a value outside it', async () => {
    openAs('R1');
    const ok = await request('/catalog?packaging=compose', {});
    expect(Array.isArray(ok)).toBe(true);

    const problem = await problemOf(() => request('/catalog?packaging=zip', {}));
    expect(problem.fieldErrors.map((issue) => issue.field)).toContain('packaging');
  });

  it('validates the request body against the declared schema', async () => {
    openAs('R1');
    const problem = await problemOf(() =>
      request('/instances', { method: 'POST', body: { slug: 'x' } }),
    );
    expect(problem.code).toBe('REQUEST_CONTRACT');
    expect(problem.fieldErrors.length).toBeGreaterThan(0);
  });

  it('does not send If-Match for an operation that does not declare concurrency', async () => {
    openAs('R1');
    let sent: string | null = 'unset';
    server.use(
      http.post('/api/v1/instances/:id/backups', ({ request: incoming }) => {
        sent = incoming.headers.get('if-match');
        return HttpResponse.json(
          { jobId: 'job-test', links: { self: '/jobs/job-test', logs: '/jobs/job-test/logs' } },
          { status: 202 },
        );
      }),
    );

    await request('/instances/inst-crm/backups', { schema: JobAcceptedSchema, method: 'POST' });
    expect(sent).toBeNull();
  });

  it('sends If-Match from the last GET for an operation that declares concurrency', async () => {
    openAs('R1');
    const settings = await request('/admin/settings', { schema: PlatformSettingsSchema });

    let sent: string | null = null;
    server.use(
      http.put('/api/v1/admin/settings', ({ request: incoming }) => {
        sent = incoming.headers.get('if-match');
        return HttpResponse.json(settings);
      }),
    );

    await request('/admin/settings', {
      method: 'PUT',
      body: { breakGlassMaxMinutes: 60 },
      schema: PlatformSettingsSchema,
    });

    expect(sent).not.toBeNull();
  });

  it('resolves a 204 without trying to parse a body', async () => {
    openAs('R1');
    server.use(http.delete('/api/v1/workflows/:id', () => new HttpResponse(null, { status: 204 })));

    const result = await request<void>('/workflows/wf-draft-1', { method: 'DELETE' });
    expect(result).toBeUndefined();
  });

  it('prefers the exact path over a parameterised sibling', async () => {
    openAs('R1');
    // `/instances/:id/backups` and `/instances/:id/:action` both match three segments. The
    // exact declaration must win: it has no request body, so a body is not validated against
    // the lifecycle schema and the call reaches the backup handler.
    const accepted = await request('/instances/inst-crm/backups', {
      schema: JobAcceptedSchema,
      method: 'POST',
      body: { dataRetention: 'nonsense' },
    });
    expect(accepted.jobId.length).toBeGreaterThan(0);
  });
});
