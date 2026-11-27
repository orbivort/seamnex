import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import { AppError } from '../../../src/common/problem/app-error';
import { HealthController } from '../../../src/health/health.controller';

type Reply = {
  statuses: number[];
  headers: Record<string, unknown>;
  sent: unknown[];
};

function replyDouble(): Reply & Record<string, unknown> {
  const reply: Reply & Record<string, unknown> = {
    statuses: [],
    headers: {},
    sent: [],
    request: { requestId: 'rid-probe', headers: {} },
    status(code: number) {
      reply.statuses.push(code);
      return reply;
    },
    header(name: string, value: unknown) {
      reply.headers[name.toLowerCase()] = value;
      return reply;
    },
    getHeader(name: string) {
      return reply.headers[name.toLowerCase()];
    },
    send(payload?: unknown) {
      reply.sent.push(payload);
      return reply;
    },
  };
  return reply;
}

function build(
  options: {
    ready?: boolean;
    metricsEnabled?: boolean;
    registryMetrics?: string;
    metricsToken?: string;
    exposition?: string;
  } = {},
) {
  const health = {
    liveness: vi.fn().mockReturnValue({ status: 'ok', role: 'api', uptimeSeconds: 12 }),
    readiness: vi.fn().mockResolvedValue({
      ok: options.ready ?? true,
      role: 'api',
      checkedAt: '2026-01-01T00:00:00.000Z',
      dependencies: [
        { name: 'postgres', ok: options.ready ?? true, latencyMs: 1 },
        { name: 'redis', ok: options.ready ?? true, latencyMs: 1 },
        { name: 'idp', ok: false, latencyMs: 1 },
      ],
    }),
  };
  const metrics = {
    dependencyUp: { labels: vi.fn().mockReturnValue({ set: vi.fn() }) },
    registry: {
      metrics: vi.fn().mockResolvedValue(options.registryMetrics ?? '# metrics\n'),
      contentType: 'text/plain; version=0.0.4',
    },
  };
  const config = {
    SEAMNEX_METRICS_ENABLED: options.metricsEnabled ?? true,
    SEAMNEX_METRICS_TOKEN: options.metricsToken ?? '',
  } as unknown as AppConfig;
  const observability = {
    exposition: vi.fn().mockResolvedValue(options.exposition ?? '# instance metrics\n'),
  };
  return {
    health,
    metrics,
    observability,
    controller: new HealthController(
      health as never,
      config,
      metrics as never,
      observability as never,
    ),
  };
}

describe('GET /healthz', () => {
  it('returns the liveness body without touching a dependency', () => {
    const { controller, health } = build();
    expect(controller.liveness()).toEqual({ status: 'ok', role: 'api', uptimeSeconds: 12 });
    expect(health.readiness).not.toHaveBeenCalled();
  });
});

describe('GET /readyz', () => {
  it('answers 200 with the report and records both dependency gauges', async () => {
    const { controller, metrics } = build();
    const reply = replyDouble();

    await controller.readiness(reply as never);

    expect(reply.statuses).toEqual([200]);
    expect(reply.sent[0]).toMatchObject({ ok: true });
    expect(metrics.dependencyUp.labels).toHaveBeenCalledWith('postgres');
    expect(metrics.dependencyUp.labels).toHaveBeenCalledWith('redis');
  });

  it('answers a problem document naming the dependencies that did not answer', async () => {
    const { controller } = build({ ready: false });
    const reply = replyDouble();

    await controller.readiness(reply as never);

    expect(reply.statuses).toEqual([503]);
    expect(reply.headers['content-type']).toContain('application/problem+json');
    expect(reply.sent[0]).toMatchObject({
      code: 'UNAVAILABLE',
      detail: expect.stringContaining('postgres, redis'),
    });
  });

  it('answers a readiness problem without a request object on the reply', async () => {
    const { controller } = build({ ready: false });
    const reply = replyDouble();
    delete reply.request;

    await controller.readiness(reply as never);

    expect(reply.statuses).toEqual([503]);
    expect(reply.headers['x-request-id']).toBe('unknown');
  });

  it('answers a disabled-metrics problem without a request object on the reply', async () => {
    const { controller } = build({ metricsEnabled: false });
    const reply = replyDouble();
    delete reply.request;

    await controller.prometheus(reply as never);

    expect(reply.statuses).toEqual([404]);
    expect(reply.headers['x-request-id']).toBe('unknown');
  });

  it('reports a dependency missing from the report as down rather than throwing', async () => {
    const { controller, metrics } = build();
    const reply = replyDouble();
    (controller as unknown as { health: { readiness: () => Promise<unknown> } }).health.readiness =
      vi.fn().mockResolvedValue({
        ok: true,
        role: 'api',
        checkedAt: '2026-01-01T00:00:00.000Z',
        dependencies: [],
      });

    await controller.readiness(reply as never);

    const set = metrics.dependencyUp.labels.mock.results[0]?.value.set as ReturnType<typeof vi.fn>;
    expect(set).toHaveBeenCalledWith(0);
  });
});

describe('GET /metrics', () => {
  it('serves the registry with its content type when metrics are enabled', async () => {
    const { controller } = build({ registryMetrics: '# HELP seamnex_role_up\n' });
    const reply = replyDouble();

    await controller.prometheus(reply as never);

    expect(reply.statuses).toEqual([200]);
    expect(reply.headers['content-type']).toBe('text/plain; version=0.0.4');
    expect(reply.sent[0]).toContain('seamnex_role_up');
  });

  it('answers NOT_FOUND when the deployment disabled metrics', async () => {
    const { controller } = build({ metricsEnabled: false });
    const reply = replyDouble();

    await controller.prometheus(reply as never);

    expect(reply.statuses).toEqual([404]);
    expect(reply.sent[0]).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('falls back to the inbound request id when the reply carries no request', async () => {
    const { controller } = build({ metricsEnabled: false });
    const reply = replyDouble();
    reply.request = { headers: { 'x-request-id': 'rid-header' } };

    await controller.prometheus(reply as never);

    expect(reply.headers['x-request-id']).toBe('rid-header');
  });
});

describe('GET /metrics/instances/:id', () => {
  it('serves one instance s exposition as Prometheus text', async () => {
    const { controller, observability } = build({ exposition: '# HELP seamnex_instance_up\n' });
    const reply = replyDouble();

    await controller.instanceMetrics('i1', undefined, reply as never);

    expect(observability.exposition).toHaveBeenCalledWith('i1');
    expect(reply.statuses).toEqual([200]);
    expect(reply.headers['content-type']).toContain('text/plain');
    expect(reply.sent[0]).toContain('seamnex_instance_up');
  });

  it('answers NOT_FOUND when metrics are disabled', async () => {
    const { controller, observability } = build({ metricsEnabled: false });
    const reply = replyDouble();

    await controller.instanceMetrics('i1', undefined, reply as never);

    expect(observability.exposition).not.toHaveBeenCalled();
    expect(reply.statuses).toEqual([404]);
    expect(reply.sent[0]).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires the shared token when the deployment configured one', async () => {
    const { controller, observability } = build({ metricsToken: 'scrape-secret' });
    const reply = replyDouble();

    await controller.instanceMetrics('i1', 'Bearer wrong', reply as never);

    expect(observability.exposition).not.toHaveBeenCalled();
    expect(reply.statuses).toEqual([404]);
  });

  it('accepts the shared token when it matches', async () => {
    const { controller } = build({ metricsToken: 'scrape-secret' });
    const reply = replyDouble();

    await controller.instanceMetrics('i1', 'Bearer scrape-secret', reply as never);

    expect(reply.statuses).toEqual([200]);
  });

  it('does not treat a non-Bearer credential as a supplied token', async () => {
    const { controller, observability } = build({ metricsToken: 'scrape-secret' });
    const reply = replyDouble();
    delete reply.request;

    await controller.instanceMetrics('i1', 'Basic c2NyYXBl', reply as never);

    // The scheme is part of the contract: a Basic header is not the bearer the scraper was given.
    expect(observability.exposition).not.toHaveBeenCalled();
    expect(reply.statuses).toEqual([404]);
    expect(reply.headers['x-request-id']).toBe('unknown');
  });

  it('answers the not-found for an instance the platform does not know', async () => {
    const { controller, observability } = build();
    // The controller recognises a deliberate not-found by its status, so this double carries one.
    observability.exposition.mockRejectedValueOnce(
      new AppError({ code: 'NOT_FOUND', status: 404, detail: 'No instance i9.' }),
    );
    const reply = replyDouble();
    delete reply.request;

    await controller.instanceMetrics('i9', undefined, reply as never);

    // A scrape of a deleted instance is a failed scrape, not a 500: the body still says why.
    expect(reply.statuses).toEqual([404]);
    expect(reply.sent[0]).toMatchObject({ code: 'NOT_FOUND', detail: 'No instance i9.' });
    expect(reply.headers['x-request-id']).toBe('unknown');
  });

  it('rethrows a failure that is not a deliberate not-found', async () => {
    const { controller, observability } = build();
    observability.exposition.mockRejectedValueOnce(new Error('database unavailable'));
    const reply = replyDouble();

    await expect(controller.instanceMetrics('i1', undefined, reply as never)).rejects.toThrow(
      'database unavailable',
    );
    expect(reply.statuses).toEqual([]);
  });
});
