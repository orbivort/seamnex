import type { Pool, QueryResultRow } from 'pg';
import type { Queryable } from './transaction';

/**
 * The persistence seam for one module (ADR-BE-08).
 *
 * A service that issues `pool.query` directly cannot be tested without a database, and it cannot be
 * read without knowing which of `rows[0]`, `rows` and `rowCount` this particular statement happens
 * to be about. The three helpers below make the intent part of the call: `one` is a lookup, `many`
 * is a list, `execute` is a write.
 *
 * `tx` is optional everywhere and is the *first* thing a caller passes when one exists, so a
 * statement that must join a transaction cannot silently run on its own connection.
 */
export abstract class Repository {
  protected constructor(protected readonly pool: Pool) {}

  protected client(tx?: Queryable): Queryable {
    return tx ?? this.pool;
  }

  /** Every row. */
  protected async many<T extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
    tx?: Queryable,
  ): Promise<T[]> {
    const result = await this.client(tx).query<T>(sql, [...params]);
    return result.rows;
  }

  /** The first row, or `undefined` — never a throw for "no row", because absence is a decision. */
  protected async one<T extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
    tx?: Queryable,
  ): Promise<T | undefined> {
    const rows = await this.many<T>(sql, params, tx);
    return rows[0];
  }

  /** How many rows a write touched. */
  protected async execute(
    sql: string,
    params: readonly unknown[] = [],
    tx?: Queryable,
  ): Promise<number> {
    const result = await this.client(tx).query(sql, [...params]);
    return result.rowCount ?? 0;
  }
}
