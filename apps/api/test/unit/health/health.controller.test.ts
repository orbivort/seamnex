import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
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
  } as unknown as AppConfig;
  return {
    health,
    metrics,
    controller: new HealthController(health as never, config, metrics as never),
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
