import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createTestDatabase, skipUnlessDatabase, type TestDatabase } from '../helpers';

/**
 * Why `seamnex/no-multi-statement-parameterised-query` exists.
 *
 * `node-postgres` switches to the extended query protocol as soon as a `values` array is passed, and
 * that protocol accepts exactly **one** command per message. A parameterised string containing two
 * statements therefore fails at runtime with `42601` while reading as ordinary SQL in review — which
 * is how workflow activation shipped broken.
 *
 * These cases pin the behaviour, not our workaround: if `createPool` ever sets `queryMode: 'simple'`
 * the first expectation fails, which is the point at which the lint rule's premise changed.
 */
let database: TestDatabase | undefined;
let pool: Pool;

beforeAll(async () => {
  if (!skipUnlessDatabase()) {
    database = await createTestDatabase();
    pool = database.pool;
    await pool.query(
      `CREATE TABLE it_two_statement (
         id integer PRIMARY KEY,
         a text,
         b text
       )`,
    );
    await pool.query(`INSERT INTO it_two_statement (id) VALUES (1)`);
  }
});

afterAll(async () => {
  await database?.drop();
});

describe.skipIf(skipUnlessDatabase() !== false)(
  'parameterised statements and the extended protocol',
  () => {
    it('rejects two statements when a values array is supplied', async () => {
      await expect(
        pool.query(
          `UPDATE it_two_statement SET a = $1 WHERE id = 1;
         UPDATE it_two_statement SET b = $2 WHERE id = 1`,
          ['a-value', 'b-value'],
        ),
      ).rejects.toMatchObject({ code: '42601' });

      // The rejection is the whole statement, not half of it: neither UPDATE ran.
      const row = await pool.query<{ a: string | null; b: string | null }>(
        'SELECT a, b FROM it_two_statement WHERE id = 1',
      );
      expect(row.rows[0]).toEqual({ a: null, b: null });
    });

    it('accepts the same work as two calls inside one transaction', async () => {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE it_two_statement SET a = $1 WHERE id = 1`, ['a-value']);
        await client.query(`UPDATE it_two_statement SET b = $1 WHERE id = 1`, ['b-value']);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const row = await pool.query<{ a: string | null; b: string | null }>(
        'SELECT a, b FROM it_two_statement WHERE id = 1',
      );
      expect(row.rows[0]).toEqual({ a: 'a-value', b: 'b-value' });
    });

    it('does accept two statements on the simple protocol, which is not the protocol we use', async () => {
      // Same text, no values array: the driver has no reason to prepare anything, so PostgreSQL runs
      // both. This is why the defect is invisible in a psql session and only appears in the API.
      await expect(
        pool.query(`UPDATE it_two_statement SET a = 'x' WHERE id = 1; SELECT 1`),
      ).resolves.toBeDefined();
    });
  },
);
