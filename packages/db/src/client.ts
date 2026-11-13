import { Pool, type PoolConfig } from 'pg';

/**
 * The only place a pool is created (ADR-BE-04). Modules receive a `ModuleDatabase`; they never
 * import `pg`, which is why the ESLint preset can forbid the driver everywhere else.
 */
export type PoolOptions = {
  /** Required. Read from `DATABASE_URL` by the config loader, never defaulted in code. */
  readonly connectionString: string;
  /**
   * Connections this pool may open. Sizing is the caller's decision, not this factory's: the API
   * role takes the configured ceiling and every worker role a quarter of it (design §13.1), which
   * `apps/api` derives in `poolMaxForRole` so the aggregate can be checked against the cluster's
   * `max_connections` before the process starts.
   */
  readonly max?: number;
  readonly applicationName?: string;
  readonly statementTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  /**
   * How long a caller waits for a free connection before failing. Must be set: `pg` defaults this
   * to `0`, which is "wait forever". With `0`, a saturated pool turns into an unbounded request
   * pile-up that `statement_timeout` cannot end, because no statement was ever issued.
   */
  readonly connectionTimeoutMs?: number;
  /** How long an unused pooled connection is kept before it is closed. */
  readonly idleTimeoutMs?: number;
  readonly ssl?: boolean;
  /**
   * Where an idle-client error goes (network reset, server restart). The pool discards the client
   * and reconnects, so the default is to swallow it — but a handler is how a reconnect storm becomes
   * visible instead of being inferred from slow queries.
   */
  readonly onError?: (error: Error) => void;
};

export const STATEMENT_TIMEOUT_MS = 15_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;
export const CONNECTION_TIMEOUT_MS = 5_000;
export const IDLE_TIMEOUT_MS = 30_000;

export function createPool(options: PoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'seamnex-api',
    statement_timeout: options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout:
      options.idleInTransactionTimeoutMs ?? IDLE_IN_TRANSACTION_TIMEOUT_MS,
    // Fail fast instead of queueing forever: an unreachable database and an exhausted pool are both
    // bounded errors an operator can see, not a request that hangs until the process restarts.
    connectionTimeoutMillis: options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: options.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
    // A pooling worker must not be held open by a half-dead client.
    keepAlive: true,
    allowExitOnIdle: false,
  };

  if (options.ssl === true) config.ssl = { rejectUnauthorized: true };

  const pool = new Pool(config);
  // An idle client erroring (network reset, server restart) must not crash the process: the pool
  // discards it and the next checkout reconnects. The error is still reported when a caller supplied
  // a sink, because a silent reconnect loop is indistinguishable from a slow database.
  pool.on('error', (error: Error) => options.onError?.(error));
  return pool;
}

/** Readiness probe. Bounded by the pool's statement timeout; never throws. */
export async function probeDatabase(
  pool: Pool,
): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const startedAt = process.hrtime.bigint();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: elapsedMs(startedAt) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: elapsedMs(startedAt),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
