import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { withAdvisoryLock, withAuditedMutation, withTransaction } from '../../src/transaction';

type PoolDouble = {
  readonly pool: Pool;
  readonly statements: string[];
  readonly release: ReturnType<typeof vi.fn>;
  readonly client: PoolClient;
};

/** A pool whose single client records statements and can be told to fail on any of them. */
function poolDouble(onQuery: (sql: string) => void = () => undefined): PoolDouble {
  const statements: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn((sql: string) => {
      statements.push(sql);
      onQuery(sql);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release,
  } as unknown as PoolClient;

  return {
    pool: { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool,
    statements,
    release,
    client,
  };
}

describe('withTransaction', () => {
  it('commits, returns the callback value and releases the connection', async () => {
    const { pool, statements, release } = poolDouble();

    const value = await withTransaction(pool, async (tx) => {
      await tx.query('UPDATE instance SET state = $1', ['ready']);
      return 'committed';
    });

    expect(value).toBe('committed');
    expect(statements).toEqual(['BEGIN', 'UPDATE instance SET state = $1', 'COMMIT']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows when the callback throws', async () => {
    const { pool, statements, release } = poolDouble();
    const failure = new Error('mutation rejected');

    await expect(withTransaction(pool, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('still releases and rethrows when ROLLBACK itself fails', async () => {
    const { pool, statements, release } = poolDouble((sql) => {
      if (sql === 'ROLLBACK') throw new Error('server closed the connection unexpectedly');
    });
    const failure = new Error('mutation rejected');

    await expect(withTransaction(pool, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases when BEGIN itself fails', async () => {
    const beginFailure = new Error('could not start transaction');
    const { pool, statements, release } = poolDouble((sql) => {
      if (sql === 'BEGIN') throw beginFailure;
    });

    await expect(withTransaction(pool, () => Promise.resolve('unreachable'))).rejects.toBe(
      beginFailure,
    );

    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('withAuditedMutation', () => {
  it('appends the audit row before the mutation, in one transaction', async () => {
    const { pool, statements } = poolDouble();
    const order: string[] = [];

    const value = await withAuditedMutation(
      pool,
      async (tx) => {
        order.push('audit');
        await tx.query('INSERT INTO audit_event (action) VALUES ($1)', ['instance.start']);
      },
      async (tx) => {
        order.push('mutate');
        await tx.query('UPDATE instance SET state = $1', ['running']);
        return 42;
      },
    );

    expect(value).toBe(42);
    expect(order).toEqual(['audit', 'mutate']);
    expect(statements).toEqual([
      'BEGIN',
      'INSERT INTO audit_event (action) VALUES ($1)',
      'UPDATE instance SET state = $1',
      'COMMIT',
    ]);
  });

  it('refuses the mutation when the audit append fails', async () => {
    const { pool, statements, release } = poolDouble();
    const mutate = vi.fn(() => Promise.resolve('never'));
    const auditFailure = new Error('audit chain unavailable');

    await expect(
      withAuditedMutation(pool, () => Promise.reject(auditFailure), mutate),
    ).rejects.toBe(auditFailure);

    expect(mutate).not.toHaveBeenCalled();
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back the audit row when the mutation fails', async () => {
    const { pool, statements } = poolDouble();
    const mutateFailure = new Error('trigger refused the update');

    await expect(
      withAuditedMutation(
        pool,
        async (tx) => {
          await tx.query('INSERT INTO audit_event (action) VALUES ($1)', ['instance.start']);
        },
        () => Promise.reject(mutateFailure),
      ),
    ).rejects.toBe(mutateFailure);

    expect(statements).toEqual([
      'BEGIN',
      'INSERT INTO audit_event (action) VALUES ($1)',
      'ROLLBACK',
    ]);
  });
});

describe('withAdvisoryLock', () => {
  it('runs the callback on the locked connection and unlocks afterwards', async () => {
    const { pool, statements, release, client } = poolDouble();

    const value = await withAdvisoryLock(pool, 918_273_647, async (tx) => {
      expect(tx).toBe(client);
      await tx.query('SELECT seamnex_reconcile()');
      return 'done';
    });

    expect(value).toBe('done');
    expect(statements).toEqual([
      'SELECT pg_advisory_lock($1)',
      'SELECT seamnex_reconcile()',
      'SELECT pg_advisory_unlock($1)',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('unlocks and releases when the callback throws', async () => {
    const { pool, statements, release } = poolDouble();
    const failure = new Error('reconcile failed');

    await expect(withAdvisoryLock(pool, 1, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(statements).toEqual(['SELECT pg_advisory_lock($1)', 'SELECT pg_advisory_unlock($1)']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the connection when the unlock statement fails', async () => {
    const unlockFailure = new Error('connection terminated');
    const { pool, release } = poolDouble((sql) => {
      if (sql === 'SELECT pg_advisory_unlock($1)') throw unlockFailure;
    });

    await expect(withAdvisoryLock(pool, 1, () => Promise.resolve('locked'))).rejects.toBe(
      unlockFailure,
    );

    expect(release).toHaveBeenCalledTimes(1);
  });
});
