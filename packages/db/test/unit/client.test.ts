import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { FakePgPool } from '../fakes';
import {
  CONNECTION_TIMEOUT_MS,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  createPool,
  elapsedMs,
  probeDatabase,
} from '../../src/client';

/**
 * `pg` is replaced at the module boundary: `createPool` is the only place in the monorepo allowed
 * to construct a `Pool` (ADR-BE-04), so the socket never needs to exist to assert what it is
 * configured with.
 */
vi.mock('pg', async () => ({ Pool: (await import('../fakes')).FakePgPool }));

beforeEach(() => {
  FakePgPool.reset();
});

describe('createPool', () => {
  it('applies the documented timeouts and pool size when nothing is configured', () => {
    createPool({ connectionString: 'postgres://seamnex:seamnex@localhost:5432/seamnex' });

    expect(FakePgPool.instances).toHaveLength(1);
    expect(FakePgPool.last().config).toEqual({
      connectionString: 'postgres://seamnex:seamnex@localhost:5432/seamnex',
      max: 10,
      application_name: 'seamnex-api',
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
      // Fail fast: an unreachable database and an exhausted pool are bounded errors, not hangs.
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      keepAlive: true,
      allowExitOnIdle: false,
    });
    expect(FakePgPool.last().config).not.toHaveProperty('ssl');
  });

  it('passes overrides through, including a verified TLS connection', () => {
    createPool({
      connectionString: 'postgres://seamnex:seamnex@db:5432/seamnex',
      max: 3,
      applicationName: 'seamnex-worker',
      statementTimeoutMs: 1_000,
      idleInTransactionTimeoutMs: 2_000,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 4_000,
      ssl: true,
    });

    expect(FakePgPool.last().config).toEqual({
      connectionString: 'postgres://seamnex:seamnex@db:5432/seamnex',
      max: 3,
      application_name: 'seamnex-worker',
      statement_timeout: 1_000,
      idle_in_transaction_session_timeout: 2_000,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 4_000,
      keepAlive: true,
      allowExitOnIdle: false,
      ssl: { rejectUnauthorized: true },
    });
  });

  it('leaves TLS off when ssl is false rather than omitting it from the caller', () => {
    createPool({
      connectionString: 'postgres://seamnex:seamnex@localhost:5432/seamnex',
      ssl: false,
    });
    expect(FakePgPool.last().config).not.toHaveProperty('ssl');
  });

  it('forwards an idle-client error to the supplied sink and keeps the pool alive', () => {
    const onError = vi.fn();
    createPool({ connectionString: 'postgres://seamnex:seamnex@localhost:5432/seamnex', onError });

    FakePgPool.last().emitError(new Error('server closed the connection unexpectedly'));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
      'server closed the connection unexpectedly',
    );
    expect(FakePgPool.last().ended).toBe(false);
  });

  it('swallows an idle-client error when no sink was supplied', () => {
    createPool({ connectionString: 'postgres://seamnex:seamnex@localhost:5432/seamnex' });
    expect(() => FakePgPool.last().emitError(new Error('ECONNRESET'))).not.toThrow();
  });
});

describe('probeDatabase', () => {
  it('reports readiness and a latency for a reachable database', async () => {
    const pool = {
      query: vi.fn(() => Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })),
    } as unknown as Pool;

    const result = await probeDatabase(pool);

    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.detail).toBeUndefined();
  });

  it('reports not-ready and the message when the query throws an Error', async () => {
    const pool = {
      query: vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'))),
    } as unknown as Pool;

    const result = await probeDatabase(pool);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('connect ECONNREFUSED 127.0.0.1:5432');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('stringifies a thrown value that is not an Error', async () => {
    // A driver or a proxy can reject with a bare string; `probeDatabase` must never throw.
    const pool = {
      query: vi.fn(() => Promise.reject('terminating connection due to administrator command')),
    } as unknown as Pool;

    const result = await probeDatabase(pool);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('terminating connection due to administrator command');
  });
});

describe('elapsedMs', () => {
  it('measures a non-negative duration in milliseconds', () => {
    const startedAt = process.hrtime.bigint();
    const elapsed = elapsedMs(startedAt);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(elapsed)).toBe(true);
  });
});
