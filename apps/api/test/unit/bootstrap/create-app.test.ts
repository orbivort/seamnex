import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import type { Logger } from '../../../src/common/logging/logger';

/**
 * `createApplication` is the one place three cross-cutting policies are wired: the request id, the
 * response headers and the request metric/log line. None of them is reachable through the contract,
 * so a regression here is invisible to every other suite — the previous `@All('*')` catch-all, for
 * instance, turned every unknown URL into a new metric label. The hooks are captured as they are
 * registered and then driven directly, which keeps this test free of a listening socket and of the
 * container (whose providers need Postgres and Redis).
 */
type Hook = (request: unknown, reply: unknown, payload?: unknown) => unknown;

const h = vi.hoisted(() => {
  const hooks = new Map<string, Hook>();
  const inc = vi.fn();
  const observe = vi.fn();
  const httpRequests = { labels: vi.fn(() => ({ inc })) };
  const httpDuration = { labels: vi.fn(() => ({ observe })) };
  const app = {
    get: vi.fn(() => ({ httpRequests, httpDuration })),
    setGlobalPrefix: vi.fn(),
    getHttpAdapter: () => ({
      getInstance: () => ({
        addHook: (name: string, hook: Hook) => {
          hooks.set(name, hook);
        },
      }),
    }),
  };
  const adapterOptions: unknown[] = [];
  return { hooks, inc, observe, httpRequests, httpDuration, app, adapterOptions };
});

vi.mock('@nestjs/core', () => ({ NestFactory: { create: vi.fn(async () => h.app) } }));
vi.mock('@nestjs/platform-fastify', () => ({
  FastifyAdapter: class {
    constructor(options: unknown) {
      h.adapterOptions.push(options);
    }
  },
}));
vi.mock('../../../src/app.module', () => ({ AppModule: class AppModule {} }));

const { createApplication, routeTemplate, API_PREFIX } =
  await import('../../../src/bootstrap/create-app');

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    trustProxy: false,
    LOG_LEVEL: 'silent',
    SEAMNEX_ROLE: 'api',
    isProduction: false,
    ...overrides,
  } as unknown as AppConfig;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

function makeReply(statusCode = 200): {
  header: ReturnType<typeof vi.fn>;
  statusCode: number;
} {
  return { header: vi.fn(), statusCode };
}

beforeEach(() => {
  h.hooks.clear();
  h.adapterOptions.length = 0;
});

describe('routeTemplate', () => {
  it('uses the route template Fastify resolved, not the raw URL', () => {
    const request = {
      url: '/api/v1/jobs/3f1c0d2e/stream',
      routeOptions: { url: '/api/v1/jobs/:id/stream' },
    };
    expect(routeTemplate(request as never)).toBe('/api/v1/jobs/:id/stream');
  });

  it('labels a request that reached no route once, not once per URL', () => {
    // The bug this pins: normalising `request.url` by hand meant anonymous traffic to
    // `/api/v1/<random>` minted unbounded label values.
    expect(routeTemplate({ url: '/api/v1/anything-random' } as never)).toBe('(unmatched)');
    expect(routeTemplate({ url: '/api/v1/other-random' } as never)).toBe('(unmatched)');
  });
});

describe('createApplication', () => {
  it('creates the Nest app over a Fastify adapter with the configured proxy trust', async () => {
    const app = await createApplication(makeConfig({ trustProxy: true }), makeLogger());

    expect(app).toBe(h.app);
    expect(h.adapterOptions[0]).toMatchObject({
      trustProxy: true,
      logger: false,
      bodyLimit: 1_048_576,
    });
    expect(h.app.setGlobalPrefix).toHaveBeenCalledWith(API_PREFIX);
    expect(h.app.get).toHaveBeenCalledOnce();
  });

  it('builds its own logger when no process logger was supplied', async () => {
    // `LOG_LEVEL=silent` keeps the real pino logger quiet; the point is the left-hand branch of
    // `processLogger ?? createLogger(...)` being exercised through the real factory.
    await expect(createApplication(makeConfig({ LOG_LEVEL: 'silent' }))).resolves.toBe(h.app);
  });

  it('assigns a request id and starts the latency clock on request', async () => {
    await createApplication(makeConfig(), makeLogger());
    const onRequest = h.hooks.get('onRequest');
    expect(onRequest).toBeDefined();

    const reply = makeReply();
    const request: Record<string, unknown> = { headers: {} };
    await onRequest?.(request, reply);

    expect(typeof request.requestId).toBe('string');
    expect(String(request.requestId).length).toBeGreaterThan(0);
    expect(typeof request.startedAt).toBe('bigint');
    expect(reply.header).toHaveBeenCalledWith('x-request-id', request.requestId);
  });

  it('keeps an inbound x-request-id rather than minting a new one', async () => {
    await createApplication(makeConfig(), makeLogger());
    const reply = makeReply();
    const request: Record<string, unknown> = { headers: { 'x-request-id': 'caller-supplied-id' } };
    await h.hooks.get('onRequest')?.(request, reply);
    expect(request.requestId).toBe('caller-supplied-id');
  });

  it('adds the security headers to every response and returns the payload unchanged', async () => {
    await createApplication(makeConfig({ isProduction: false }), makeLogger());
    const onSend = h.hooks.get('onSend');
    const reply = makeReply();
    const payload = { ok: true };

    await expect(onSend?.({ method: 'GET' }, reply, payload)).resolves.toBe(payload);
    expect(reply.header).toHaveBeenCalledWith('x-content-type-options', 'nosniff');
    expect(reply.header).toHaveBeenCalledWith('x-frame-options', 'DENY');
    expect(reply.header).toHaveBeenCalledWith('referrer-policy', 'no-referrer');
    expect(reply.header).toHaveBeenCalledWith('cache-control', 'no-store');
    // HSTS is a production promise; plain-HTTP development must not send it.
    expect(reply.header).not.toHaveBeenCalledWith('strict-transport-security', expect.anything());
  });

  it('adds HSTS only when the app is configured as production', async () => {
    await createApplication(makeConfig({ isProduction: true }), makeLogger());
    const reply = makeReply();
    await h.hooks.get('onSend')?.({ method: 'GET' }, reply, 'body');
    expect(reply.header).toHaveBeenCalledWith('strict-transport-security', 'max-age=31536000');
  });

  it('records one metric pair and one structured line per response', async () => {
    const log = makeLogger();
    await createApplication(makeConfig(), log);
    const onResponse = h.hooks.get('onResponse');
    const reply = makeReply(201);
    const request: Record<string, unknown> = {
      method: 'POST',
      routeOptions: { url: '/api/v1/jobs' },
      requestId: 'req-1',
      startedAt: process.hrtime.bigint() - 5_000_000n,
    };

    await onResponse?.(request, reply);

    expect(h.httpRequests.labels).toHaveBeenCalledWith('POST', '/api/v1/jobs', '201');
    expect(h.inc).toHaveBeenCalledOnce();
    expect(h.httpDuration.labels).toHaveBeenCalledWith('POST', '/api/v1/jobs');
    expect(h.observe).toHaveBeenCalledOnce();
    // Observed in seconds, which is what the histogram's buckets are declared in.
    const seconds = h.observe.mock.calls[0]?.[0] as number;
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(seconds).toBeLessThan(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', route: '/api/v1/jobs', status: 201 }),
      'request',
    );
  });

  it('reports zero latency for a response whose request hook never ran', async () => {
    const log = makeLogger();
    await createApplication(makeConfig(), log);
    const reply = makeReply();
    const onResponse = h.hooks.get('onResponse');

    await onResponse?.({ method: 'GET', url: '/api/v1/health' }, reply);

    expect(h.httpRequests.labels).toHaveBeenCalledWith('GET', '(unmatched)', '200');
    expect(h.observe).toHaveBeenCalledWith(0);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 0, requestId: undefined }),
      'request',
    );
  });
});
