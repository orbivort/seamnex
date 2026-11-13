import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  createTestDatabase,
  insertInstance,
  skipUnlessDatabase,
  type TestDatabase,
} from '../helpers';

/**
 * Migration 0023 — a host must not hold two live reservations for one instance.
 *
 * The defect this guards is a *concurrency* one, so the test performs the concurrent write rather
 * than asserting the DDL: two transactions that each close the previous hold and insert a new one.
 * Before the unique partial index, both committed and admission counted the instance twice; the
 * second now fails on the index instead of silently inflating the ledger.
 */
let database: TestDatabase | undefined;
let pool: Pool;

beforeAll(async () => {
  if (!skipUnlessDatabase()) {
    database = await createTestDatabase();
    pool = database.pool;
  }
});

afterAll(async () => {
  await database?.drop();
});

async function newInstance(): Promise<string> {
  const id = randomUUID();
  await insertInstance(pool, id);
  return id;
}

/** The shape `PostgresCapacityService.reserve()` issues, on a caller-controlled client. */
async function reserveInOwnTransaction(instanceId: string, cpuMilli: number): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE capacity_reservation SET released_at = now()
        WHERE instance_id = $1 AND released_at IS NULL`,
      [instanceId],
    );
    await client.query(
      `INSERT INTO capacity_reservation (instance_id, cpu_milli, memory_mb, disk_mb)
       VALUES ($1, $2, 512, 1024)`,
      [instanceId, cpuMilli],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function liveCount(instanceId: string): Promise<number> {
  const result = await pool.query<{ live: number }>(
    `SELECT count(*)::int AS live FROM capacity_reservation
      WHERE instance_id = $1 AND released_at IS NULL`,
    [instanceId],
  );
  return result.rows[0]?.live ?? 0;
}

describe.skipIf(skipUnlessDatabase() !== false)(
  'one live capacity reservation per instance',
  () => {
    it('lets exactly one of two concurrent reserves win', async () => {
      const instanceId = await newInstance();

      const outcomes = await Promise.allSettled([
        reserveInOwnTransaction(instanceId, 1_000),
        reserveInOwnTransaction(instanceId, 2_000),
      ]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(fulfilled, 'a duplicate live hold must not commit').toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // A unique violation on the partial index is the mechanism; anything else would mean the
      // conflict was resolved by timing rather than by the database.
      const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
      expect(reason.code).toBe('23505');

      expect(await liveCount(instanceId)).toBe(1);
    });

    it('accepts a new hold once the previous one is released', async () => {
      const instanceId = await newInstance();
      await reserveInOwnTransaction(instanceId, 1_000);
      expect(await liveCount(instanceId)).toBe(1);

      // The second call inside `reserve()` closes the live row and inserts; the index allows it
      // precisely because the closure is in the same transaction.
      await reserveInOwnTransaction(instanceId, 2_000);
      expect(await liveCount(instanceId)).toBe(1);

      const rows = await pool.query<{ cpu_milli: number }>(
        `SELECT cpu_milli FROM capacity_reservation
        WHERE instance_id = $1 AND released_at IS NULL`,
        [instanceId],
      );
      expect(rows.rows[0]?.cpu_milli).toBe(2_000);
      // History is kept, not deleted: the released hold is still readable.
      const all = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM capacity_reservation WHERE instance_id = $1`,
        [instanceId],
      );
      expect(all.rows[0]?.n).toBe(2);
    });

    it('keeps platform-level holds (no instance) independent of the unique index', async () => {
      // `instance_id` is nullable and NULLS DISTINCT is what makes this legal. If the index were
      // created with NULLS NOT DISTINCT, the second platform reservation would be refused.
      for (const cpuMilli of [1_000, 2_000]) {
        await pool.query(
          `INSERT INTO capacity_reservation (instance_id, cpu_milli, memory_mb, disk_mb)
         VALUES (NULL, $1, 512, 1024)`,
          [cpuMilli],
        );
      }
      const result = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM capacity_reservation
        WHERE instance_id IS NULL AND released_at IS NULL`,
      );
      expect(result.rows[0]?.n).toBeGreaterThanOrEqual(2);
    });
  },
);
