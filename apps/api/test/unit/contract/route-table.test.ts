import { describe, expect, it, vi } from 'vitest';
import { API_OPERATIONS } from '@seamnex/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX } from '../../../src/config/config';
import { RouteTableService } from '../../../src/contract/route-table';
import { AppError } from '../../../src/common/problem/app-error';
import { operationOf, testContext } from '../../support/operation-input';

type Mounted = {
  method: string;
  url: string;
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

type ReplyDouble = {
  readonly headers: Record<string, unknown>;
  readonly statuses: number[];
  readonly sent: unknown[];
  raw: { headersSent: boolean };
};

function replyDouble(): FastifyReply & ReplyDouble {
  const headers: Record<string, unknown> = {};
  const statuses: number[] = [];
  const sent: unknown[] = [];
  const reply = {
    headers,
    statuses,
    sent,
    raw: { headersSent: false },
    status(code: number) {
      statuses.push(code);
      return reply;
    },
    header(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    send(payload?: unknown) {
      sent.push(payload);
      return reply;
    },
  } as unknown as FastifyReply & ReplyDouble;
  return reply;
}

function requestDouble(overrides: Record<string, unknown> = {}): FastifyRequest {
  return {
    method: 'GET',
    url: '/api/v1/jobs',
    requestId: 'rid-dispatch',
    headers: {},
    query: {},
    params: {},
    body: undefined,
    ...overrides,
  } as unknown as FastifyRequest;
}

type HarnessOptions = {
  /** Explicitly `undefined` models a declared operation that no handler group implements. */
  handler?: ((input: unknown) => Promise<unknown>) | undefined;
  context?: ReturnType<typeof testContext>;
  isProduction?: boolean;
  adapter?: boolean;
};

function harness(options: HarnessOptions = {}) {
  const routes: Mounted[] = [];
  const server = {
    route: (route: Mounted) => routes.push(route),
  };
  const adapterHost = {
    httpAdapter: options.adapter === false ? null : { getInstance: () => server },
  };
  const handlers = {
    size: 1,
    get: () => options.handler,
  };
  const guards = {
    run: (_input: unknown, fn: (context: ReturnType<typeof testContext>) => Promise<unknown>) =>
      fn(options.context ?? testContext()),
  };
  const config = {
    isProduction: options.isProduction ?? false,
    SESSION_COOKIE_NAME: 'seamnex_session',
    CSRF_COOKIE_NAME: 'seamnex_csrf',
    SESSION_COOKIE_SECURE: true,
    SESSION_COOKIE_DOMAIN: '.example.test',
  };

  const service = new RouteTableService(
    adapterHost as never,
    handlers as never,
    guards as never,
    config as never,
  );
  service.onModuleInit();

  async function dispatch(key: string, request = requestDouble(), reply = replyDouble()) {
    const operation = operationOf(key);
    const route = routes.find(
      (candidate) =>
        candidate.method === operation.method &&
        candidate.url === `/${API_PREFIX}${operation.path}`,
    );
    if (route === undefined) throw new Error(`${key} was not mounted`);
    await route.handler(request, reply);
    return reply as ReplyDouble;
  }

  return { service, routes, dispatch };
}

describe('RouteTableService mounting', () => {
  it('mounts every declared operation exactly once', () => {
    const { routes } = harness();

    expect(routes).toHaveLength(API_OPERATIONS.length);
    const mounted = routes.map((route) => `${route.method} ${route.url}`);
    expect(new Set(mounted).size).toBe(mounted.length);
    for (const operation of API_OPERATIONS) {
      expect(mounted).toContain(`${operation.method} /${API_PREFIX}${operation.path}`);
    }
  });

  it('skips the mount in a role without an HTTP adapter instead of exiting fatally', () => {
    const { routes } = harness({ adapter: false });
    expect(routes).toEqual([]);
  });
});

describe('RouteTableService dispatch', () => {
  it('writes a validated body with the request id and a 200 status', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'body', body: { items: [], nextCursor: null, total: 0 } }),
    });

    const reply = await dispatch('GET /jobs');

    expect(reply.statuses).toEqual([200]);
    expect(reply.headers['x-request-id']).toBe('rid-dispatch');
    expect(reply.sent[0]).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it('publishes the ETag of an etag operation and any handler-supplied headers', async () => {
    const { dispatch } = harness({
      handler: async () => ({
        kind: 'body',
        body: {
          breakGlassMaxMinutes: 30,
          restoreConcurrency: 4,
          oversubscriptionFactor: 1.5,
          sessionIdleMinutes: 30,
          sessionAbsoluteHours: 12,
          metadataReviewDays: 90,
          auditRetentionDays: 365,
          updatedAt: '2026-01-01T00:00:00.000Z',
          updatedBy: 'alice',
        },
        etag: '"v1"',
        headers: { 'x-total-count': '0' },
      }),
    });

    const reply = await dispatch('GET /admin/settings');

    expect(reply.headers.etag).toBe('"v1"');
    expect(reply.headers['x-total-count']).toBe('0');
  });

  it('does not publish an ETag on an operation that does not declare one', async () => {
    const { dispatch } = harness({
      handler: async () => ({
        kind: 'body',
        body: { items: [], nextCursor: null, total: 0 },
        etag: '"x"',
      }),
    });
    const reply = await dispatch('GET /jobs');
    expect(reply.headers.etag).toBeUndefined();
  });

  it('writes 204 with no body for a noContent result', async () => {
    const { dispatch } = harness({ handler: async () => ({ kind: 'noContent' }) });
    const reply = await dispatch('DELETE /workflows/:id');
    expect(reply.statuses).toEqual([204]);
    expect(reply.sent).toEqual([undefined]);
  });

  it('writes 202 with the job links for an accepted result', async () => {
    const jobId = '018f0000-0000-4000-8000-000000000000';
    const { dispatch } = harness({
      handler: async () => ({ kind: 'accepted', jobId }),
    });

    const reply = await dispatch('POST /jobs/:id/retry');

    expect(reply.statuses).toEqual([202]);
    expect(reply.sent[0]).toEqual({
      jobId,
      links: {
        self: `/api/v1/jobs/${jobId}`,
        logs: `/api/v1/jobs/${jobId}/logs`,
      },
    });
  });

  it('writes nothing for a stream result, which owns the reply itself', async () => {
    const { dispatch } = harness({ handler: async () => ({ kind: 'stream' }) });
    const reply = await dispatch('GET /jobs/:id/stream');
    expect(reply.statuses).toEqual([]);
    expect(reply.sent).toEqual([]);
  });

  it('answers 501 when a declared operation has no handler', async () => {
    const { dispatch } = harness({ handler: undefined });
    const reply = await dispatch('GET /jobs');

    expect(reply.statuses).toEqual([501]);
    expect(reply.headers['content-type']).toContain('application/problem+json');
    expect(reply.sent[0]).toMatchObject({ code: 'OPERATION_NOT_IMPLEMENTED' });
  });

  it('answers 422 for a query that is not the declared surface', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'noContent' }),
    });

    const reply = await dispatch('GET /jobs', requestDouble({ query: { undeclared: '1' } }));

    expect(reply.statuses).toEqual([422]);
    expect(reply.sent[0]).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('answers 500 when a handler body violates the contract outside production', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'body', body: { wrong: true } }),
    });
    const reply = await dispatch('GET /jobs');
    expect(reply.statuses).toEqual([500]);
    expect(reply.sent[0]).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('passes an invalid body through in production, where the contract is test-gated', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'body', body: { wrong: true } }),
      isProduction: true,
    });
    const reply = await dispatch('GET /jobs');
    expect(reply.statuses).toEqual([200]);
    expect(reply.sent[0]).toEqual({ wrong: true });
  });

  it('renders an AppError through the shared problem writer, including its headers', async () => {
    const { dispatch } = harness({
      handler: async () => {
        throw new AppError({
          code: 'RATE_LIMITED',
          detail: 'slow down',
          headers: { 'retry-after': '12' },
        });
      },
    });

    const reply = await dispatch('GET /jobs');

    expect(reply.statuses).toEqual([429]);
    expect(reply.headers['retry-after']).toBe('12');
    expect(reply.sent[0]).toMatchObject({ code: 'RATE_LIMITED', detail: 'slow down' });
  });

  it('masks an unknown error as a generic 500', async () => {
    const { dispatch } = harness({
      handler: async () => {
        throw new Error('pg://user:pw@db:5432/seamnex');
      },
    });
    const reply = await dispatch('GET /jobs');
    expect(reply.statuses).toEqual([500]);
    expect(JSON.stringify(reply.sent[0])).not.toContain('pw@db');
  });

  it('only logs an error that arrives after a stream started', async () => {
    const { dispatch } = harness({
      handler: async () => {
        throw new Error('after head');
      },
    });
    const reply = replyDouble();
    (reply as unknown as { raw: { headersSent: boolean } }).raw.headersSent = true;

    const out = await dispatch('GET /jobs', requestDouble(), reply);

    expect(out.statuses).toEqual([]);
    expect(out.sent).toEqual([]);
  });

  it('passes params, cookies, headers and the bound request id to the handler', async () => {
    const handler = vi.fn().mockResolvedValue({ kind: 'noContent' });
    const context = testContext({ requestId: 'rid-bound' });
    const { dispatch } = harness({ handler, context });

    await dispatch(
      'GET /jobs/:id',
      requestDouble({
        params: { id: 'job-1' },
        headers: { cookie: 'seamnex_session=sid; seamnex_csrf=tok' },
      }),
      replyDouble(),
    );

    const [input] = handler.mock.calls[0] as [
      {
        params: Record<string, string>;
        cookies: Record<string, string>;
        requestId: string;
        headers: Record<string, unknown>;
      },
    ];
    expect(input.params).toEqual({ id: 'job-1' });
    expect(input.cookies).toEqual({ seamnex_session: 'sid', seamnex_csrf: 'tok' });
    expect(input.requestId).toBe(context.requestId);
  });
});

describe('sliding session renewal', () => {
  it('re-emits the cookie pair with the remaining idle lifetime', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'noContent' }),
      context: testContext({
        sessionIdleExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    });

    const reply = await dispatch('DELETE /workflows/:id');
    const cookies = reply.headers['set-cookie'] as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('seamnex_session=');
    expect(cookies[0]).toContain('HttpOnly');
  });

  it('does not renew for a service actor or a context with no session', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'noContent' }),
      context: testContext({ actorType: 'service' }),
    });
    const reply = await dispatch('DELETE /workflows/:id');
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('does not renew when the idle deadline has already passed', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'noContent' }),
      context: testContext({
        sessionIdleExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    });
    const reply = await dispatch('DELETE /workflows/:id');
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('does not renew when the idle deadline is unparseable', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'noContent' }),
      context: testContext({ sessionIdleExpiresAt: 'not-a-date' }),
    });
    const reply = await dispatch('DELETE /workflows/:id');
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('does not renew when the context has no session id or no csrf token', async () => {
    for (const context of [
      testContext({
        sessionId: null,
        sessionIdleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      testContext({
        csrfToken: null,
        sessionIdleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]) {
      const { dispatch } = harness({ handler: async () => ({ kind: 'noContent' }), context });
      const reply = await dispatch('DELETE /workflows/:id');
      expect(reply.headers['set-cookie']).toBeUndefined();
    }
  });

  it('publishes an ETag on a conditional write as well as on a read', async () => {
    const { dispatch } = harness({
      handler: async () => ({
        kind: 'body',
        body: {
          breakGlassMaxMinutes: 30,
          restoreConcurrency: 4,
          oversubscriptionFactor: 1.5,
          sessionIdleMinutes: 30,
          sessionAbsoluteHours: 12,
          metadataReviewDays: 90,
          auditRetentionDays: 365,
          updatedAt: '2026-01-01T00:00:00.000Z',
          updatedBy: 'alice',
        },
        etag: '"v2"',
      }),
    });

    const reply = await dispatch('PUT /admin/settings');
    expect(reply.headers.etag).toBe('"v2"');
  });

  it('logs the string form of a non-Error refusal', async () => {
    const { dispatch } = harness({
      handler: async () => {
        throw 'plain string failure';
      },
    });
    const reply = await dispatch('GET /jobs');
    expect(reply.statuses).toEqual([500]);
  });

  it('does not overwrite a cookie the handler already wrote', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'noContent' }),
      context: testContext({
        sessionIdleExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    });
    const reply = replyDouble();
    reply.header('set-cookie', 'seamnex_session=cleared');

    await dispatch('DELETE /workflows/:id', requestDouble(), reply);

    expect(reply.headers['set-cookie']).toBe('seamnex_session=cleared');
  });
});

describe('response schema gate', () => {
  it('names the operation in the refusal', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'body', body: 42 }),
    });
    const reply = await dispatch('GET /jobs');
    const problem = reply.sent[0] as { detail: string };
    expect(problem.detail).toContain('GET /jobs');
  });

  it('carries remediation pointing at the handler, not the request', async () => {
    const { dispatch } = harness({
      handler: async () => ({ kind: 'body', body: 42 }),
    });
    const reply = await dispatch('GET /jobs');
    const problem = reply.sent[0] as { remediation: string };
    expect(problem.remediation).toContain('defect in the handler');
  });
});
