import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import { HealthService } from '../../../src/health/health.service';

/**
 * A Redis client rejects with an `Error` (a `ReplyError` carries `NOAUTH`, `LOADING`, `READONLY`),
 * while the main suite only covers the non-Error branch. Both halves of the detail line matter:
 * the readiness body is what an operator reads when a replica leaves the rotation.
 */
const CONFIG = { SEAMNEX_ROLE: 'api' } as unknown as AppConfig;

function build(redis: () => Promise<unknown>) {
  const pool = { query: vi.fn(async () => ({ rows: [] })) };
  const client = { ping: vi.fn(redis) };
  const provider = { authConfig: vi.fn(async () => ({ provider: 'stub', authorizeUrl: null })) };
  return {
    pool,
    client,
    service: new HealthService(pool as never, client as never, CONFIG, provider as never),
  };
}

describe('a dependency that fails with an Error', () => {
  it('reports the Redis message verbatim and keeps the database verdict', async () => {
    const { service, pool } = build(() =>
      Promise.reject(new Error('NOAUTH Authentication required')),
    );

    const report = await service.readiness();

    expect(report.ok).toBe(false);
    expect(report.dependencies.find((dependency) => dependency.name === 'redis')).toMatchObject({
      ok: false,
      detail: 'NOAUTH Authentication required',
    });
    // One failing dependency must not be reported as a failing database as well.
    expect(report.dependencies.find((dependency) => dependency.name === 'postgres')?.ok).toBe(true);
    expect(pool.query).toHaveBeenCalledOnce();
  });
});
