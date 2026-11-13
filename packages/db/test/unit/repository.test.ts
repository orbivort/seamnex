import { describe, expect, it, vi } from 'vitest';
import type { Pool, QueryResultRow } from 'pg';
import type { Queryable } from '../../src/transaction';
import { Repository } from '../../src/repository';

/** The base class is abstract and its helpers are protected: a subclass is how a module uses it. */
class DemoRepository extends Repository {
  constructor(pool: Pool) {
    super(pool);
  }

  list<T extends QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
    tx?: Queryable,
  ): Promise<T[]> {
    return this.many<T>(sql, params, tx);
  }

  find<T extends QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
    tx?: Queryable,
  ): Promise<T | undefined> {
    return this.one<T>(sql, params, tx);
  }

  write(sql: string, params?: readonly unknown[], tx?: Queryable): Promise<number> {
    return this.execute(sql, params, tx);
  }

  connection(tx?: Queryable): Queryable {
    return this.client(tx);
  }
}

const poolQuery = (
  rows: unknown[] = [],
  rowCount: number | null = rows.length,
): ReturnType<typeof vi.fn> => vi.fn(() => Promise.resolve({ rows, rowCount }));

describe('Repository', () => {
  it('returns every row and forwards the statement with a copy of the parameters', async () => {
    const query = poolQuery([{ id: 'a' }, { id: 'b' }]);
    const repository = new DemoRepository({ query } as unknown as Pool);
    const params = ['ready'];

    const rows = await repository.list('SELECT id FROM instance WHERE state = $1', params);

    expect(rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toBe('SELECT id FROM instance WHERE state = $1');
    // A caller that keeps mutating its array must not change the statement already issued.
    expect(query.mock.calls[0]?.[1]).toEqual(['ready']);
    expect(query.mock.calls[0]?.[1]).not.toBe(params);
  });

  it('defaults the parameters to an empty array', async () => {
    const query = poolQuery([{ id: 'a' }]);
    const repository = new DemoRepository({ query } as unknown as Pool);

    await repository.list('SELECT id FROM instance');

    expect(query.mock.calls[0]?.[1]).toEqual([]);
  });

  it('returns the first row for a lookup and undefined when the lookup finds nothing', async () => {
    const found = new DemoRepository({
      query: poolQuery([{ id: 'first' }, { id: 'second' }]),
    } as unknown as Pool);
    const missing = new DemoRepository({ query: poolQuery([]) } as unknown as Pool);

    await expect(found.find('SELECT id FROM instance LIMIT 1')).resolves.toEqual({ id: 'first' });
    // Absence is a decision the caller makes, so it is not an exception.
    await expect(missing.find('SELECT id FROM instance LIMIT 1')).resolves.toBeUndefined();
  });

  it('reports how many rows a write touched, and treats a null count as zero', async () => {
    const touched = new DemoRepository({ query: poolQuery([], 3) } as unknown as Pool);
    const noCount = new DemoRepository({ query: poolQuery([], null) } as unknown as Pool);

    await expect(touched.write('UPDATE instance SET state = $1', ['ready'])).resolves.toBe(3);
    await expect(noCount.write('UPDATE instance SET state = $1', ['ready'])).resolves.toBe(0);
  });

  it('runs on the transaction client when one is supplied', async () => {
    const pool = { query: poolQuery([{ id: 'pool' }]) } as unknown as Pool;
    const txQuery = poolQuery([{ id: 'tx' }]);
    const tx = { query: txQuery } as unknown as Queryable;
    const repository = new DemoRepository(pool);

    await expect(repository.list('SELECT id FROM instance', [], tx)).resolves.toEqual([
      { id: 'tx' },
    ]);
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(pool.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('defaults to the pool when no transaction is in scope', () => {
    const pool = { query: poolQuery() } as unknown as Pool;
    const repository = new DemoRepository(pool);

    const tx = { query: poolQuery() } as unknown as Queryable;

    expect(repository.connection()).toBe(pool);
    expect(repository.connection(tx)).toBe(tx);
  });
});
