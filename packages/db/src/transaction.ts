import type { Pool, PoolClient } from 'pg';

/** Anything that can run a parameterised statement inside the current transaction. */
export type Queryable = Pick<PoolClient, 'query'>;

export type AuditAppend = (tx: Queryable) => Promise<void>;

/**
 * Runs `fn` inside a transaction and commits, or rolls back on a throw.
 * A connection is always released, including when `BEGIN` itself fails.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A failed rollback means the connection is unusable; the pool discards it on release.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * AD-20 / exit criterion 6: a state change whose audit row cannot be written is refused.
 *
 * The audit append and the mutation share one transaction, so "fail closed" is a property of the
 * commit, not a convention a handler can forget. Order matters: the audit row is appended first,
 * so a trigger that rejects the mutation still leaves an audit trail of the attempt — and a
 * failing audit append prevents the mutation from ever running.
 */
export async function withAuditedMutation<T>(
  pool: Pool,
  appendAudit: AuditAppend,
  mutate: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (tx) => {
    await appendAudit(tx);
    return mutate(tx);
  });
}

/**
 * Serialised, short-lived work that must not interleave across replicas.
 *
 * `fn` receives the locked client and **must** use it. `pg_advisory_lock` is session-scoped, so a
 * statement issued on `pool` inside `fn` runs on a different connection that does not hold the lock
 * — mutual exclusion that silently is not there. The callback used to take no argument, which made
 * that mistake the only thing the signature allowed.
 *
 * Prefer `pg_advisory_xact_lock` inside `withTransaction` where the work is transactional: it is
 * released by the commit, so a crash cannot leave the lock pinned.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  key: number,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [key]);
    return await fn(client);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    } finally {
      client.release();
    }
  }
}
