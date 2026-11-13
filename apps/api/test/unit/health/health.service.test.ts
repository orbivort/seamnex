import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import { HealthService } from '../../../src/health/health.service';

const CONFIG = {
  SEAMNEX_ROLE: 'api',
  SEAMNEX_BUILD_VERSION: '1.2.3',
  SEAMNEX_BUILD_REVISION: '8f3c1a',
} as unknown as AppConfig;

function build(
  options: {
    database?: () => Promise<unknown>;
    redis?: () => Promise<unknown>;
    provider?: () => Promise<unknown>;
  } = {},
) {
  const pool = { query: vi.fn(options.database ?? (() => Promise.resolve({ rows: [] }))) };
  const redis = { ping: vi.fn(options.redis ?? (() => Promise.resolve('PONG'))) };
  const provider = {
    authConfig: vi.fn(
      options.provider ?? (() => Promise.resolve({ provider: 'stub', authorizeUrl: null })),
    ),
  };
  return {
    pool,
    redis,
    provider,
    service: new HealthService(pool as never, redis as never, CONFIG, provider as never),
  };
}

describe('liveness', () => {
  it('reports the process role, its uptime and the release it was built from', () => {
    const { service } = build();
    const body = service.liveness();

    expect(body.status).toBe('ok');
    expect(body.role).toBe('api');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // The release is the tag baked in at image build, not the workspace copy: this is the only
    // runtime answer to "which release is this?" (see CONTRACT_DOCUMENT_VERSION for the copy the
    // OpenAPI document carries instead).
    expect(body.version).toBe('1.2.3');
    expect(body.revision).toBe('8f3c1a');
  });
});

describe('readiness', () => {
  it('reports every dependency as ready when all three answer', async () => {
    const { service } = build();
    const report = await service.readiness();

    expect(report.ok).toBe(true);
    expect(report.role).toBe('api');
    expect(report.dependencies.map((dependency) => dependency.name)).toEqual([
      'postgres',
      'redis',
      'idp',
    ]);
    for (const dependency of report.dependencies) {
      expect(dependency.ok).toBe(true);
      expect(dependency.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('is not ready when the database is unreachable, and names the failure', async () => {
    const { service } = build({ database: () => Promise.reject(new Error('connection refused')) });
    const report = await service.readiness();

    expect(report.ok).toBe(false);
    expect(report.dependencies.find((d) => d.name === 'postgres')).toMatchObject({
      ok: false,
      detail: 'connection refused',
    });
  });

  it('is not ready when Redis is unreachable, and stringifies a non-Error', async () => {
    const { service } = build({ redis: () => Promise.reject('gone') });
    const report = await service.readiness();

    expect(report.ok).toBe(false);
    expect(report.dependencies.find((d) => d.name === 'redis')).toMatchObject({
      ok: false,
      detail: 'gone',
    });
  });

  it('stringifies a non-Error database failure', async () => {
    const { service } = build({ database: () => Promise.reject({ code: 'ECONNREFUSED' }) });
    const report = await service.readiness();
    expect(report.dependencies.find((d) => d.name === 'postgres')?.detail).toBe('[object Object]');
  });

  it('reports an identity provider outage without taking the replica out of rotation', async () => {
    const { service } = build({ provider: () => Promise.reject(new Error('discovery down')) });
    const report = await service.readiness();

    expect(report.ok).toBe(true);
    expect(report.dependencies.find((d) => d.name === 'idp')).toMatchObject({
      ok: false,
      detail: 'discovery down',
    });
  });

  it('marks the stub provider as a dependency it never contacts', async () => {
    const { service } = build();
    const report = await service.readiness();
    expect(report.dependencies.find((d) => d.name === 'idp')?.detail).toContain('stub provider');
  });

  it('does not label a real provider as the stub', async () => {
    const { service } = build({
      provider: () => Promise.resolve({ provider: 'oidc', authorizeUrl: 'https://kc.test' }),
    });
    const report = await service.readiness();
    expect(report.dependencies.find((d) => d.name === 'idp')?.detail).toBeUndefined();
  });

  it('caches the report for one second so a 1 Hz probe is not a load test', async () => {
    const { service, pool, redis } = build();

    const first = await service.readiness();
    const second = await service.readiness();

    expect(second).toBe(first);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when forced', async () => {
    const { service, pool } = build();

    await service.readiness();
    await service.readiness(true);

    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('re-probes once the cache has expired', async () => {
    const { service, pool } = build();
    const realNow = Date.now;
    let now = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      await service.readiness();
      now += 1_500;
      await service.readiness();
      expect(pool.query).toHaveBeenCalledTimes(2);
    } finally {
      vi.spyOn(Date, 'now').mockRestore();
    }
  });

  it('stringifies a non-Error identity provider failure', async () => {
    const { service } = build({ provider: () => Promise.reject(42) });
    const report = await service.readiness();
    expect(report.dependencies.find((d) => d.name === 'idp')?.detail).toBe('42');
  });

  it('reports readiness for a forced probe with no cache and no prior call', async () => {
    const { service, pool, redis, provider } = build();
    await service.readiness(true);
    expect(pool.query).toHaveBeenCalledOnce();
    expect(redis.ping).toHaveBeenCalledOnce();
    expect(provider.authConfig).toHaveBeenCalledOnce();
  });
});
