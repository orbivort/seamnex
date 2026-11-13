import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase, skipUnlessDatabase, type TestDatabase } from '../helpers';

/**
 * Exit criterion 2 and invariant 6: the audit log is append-only, and the chain is a property of
 * the database rather than of one code path.
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

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function append(action: string, outcome = 'success'): Promise<void> {
  await pool.query(
    `INSERT INTO audit_event (actor_type, actor_id, action, target_type, target_id, outcome, detail)
     VALUES ('user', 'subject-1', $1, 'instance', 'i-1', $2, '{"secret": "canary-not-a-secret"}'::jsonb)`,
    [action, outcome],
  );
}

describe.skipIf(skipUnlessDatabase() !== false)('audit hash chain', () => {
  it('links every row to its predecessor and starts from a zero hash', async () => {
    await append('a.first');
    await append('a.second');
    await append('a.third', 'denied');

    const result = await pool.query<{ seq: string; prev_hash: string; hash: string }>(
      'SELECT seq, prev_hash, hash FROM audit_event ORDER BY seq',
    );

    expect(result.rows).toHaveLength(3);
    const [first, second, third] = result.rows;
    expect(first?.prev_hash).toBe('0'.repeat(64));
    expect(second?.prev_hash).toBe(first?.hash);
    expect(third?.prev_hash).toBe(second?.hash);

    for (const row of result.rows) {
      expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.hash).not.toBe(row.prev_hash);
    }
  });

  it('serialises concurrent appends into one chain', async () => {
    const actions = Array.from({ length: 5 }, (_, index) => `concurrent.${index}`);
    await Promise.all(actions.map((action) => append(action)));

    const result = await pool.query<{ seq: string; prev_hash: string; hash: string }>(
      'SELECT seq, prev_hash, hash FROM audit_event ORDER BY seq',
    );
    const linked = result.rows.every((row, index) => {
      if (index === 0) return row.prev_hash === '0'.repeat(64);
      return row.prev_hash === result.rows[index - 1]?.hash;
    });
    expect(linked, 'every row must link to the previous hash, even under concurrency').toBe(true);
  });

  it('rejects UPDATE, DELETE and TRUNCATE even for the schema owner', async () => {
    await expect(pool.query(`UPDATE audit_event SET action = 'rewritten'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('DELETE FROM audit_event')).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE audit_event')).rejects.toThrow(/append-only/);
  });

  it('denies UPDATE and DELETE to the application role at the grant level', async () => {
    const client = await (database as TestDatabase).appClient();
    try {
      await expect(client.query(`UPDATE audit_event SET action = 'rewritten'`)).rejects.toThrow(
        /permission denied|append-only/,
      );
      await expect(client.query('DELETE FROM audit_event')).rejects.toThrow(
        /permission denied|append-only/,
      );
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('ignores a caller-supplied seq so a writer cannot choose its position', async () => {
    // `seq` is assigned inside the trigger, under the chain lock. When it was merely defaulted,
    // any role with INSERT could place a row anywhere in the chain.
    const forced = await pool.query<{ seq: string }>(
      `INSERT INTO audit_event (seq, actor_type, actor_id, action, target_type, target_id, outcome)
       VALUES (999999, 'system', 'it', 'a.forced', 'platform', 'it', 'success')
       RETURNING seq`,
    );
    expect(forced.rows[0]?.seq).not.toBe('999999');

    const tip = await pool.query<{ seq: string; prev_hash: string; hash: string }>(
      'SELECT seq, prev_hash, hash FROM audit_event ORDER BY seq DESC LIMIT 1',
    );
    const previous = await pool.query<{ hash: string }>(
      'SELECT hash FROM audit_event ORDER BY seq DESC OFFSET 1 LIMIT 1',
    );
    expect(tip.rows[0]?.prev_hash).toBe(previous.rows[0]?.hash);
  });

  it('denies TRUNCATE and DELETE on a leaf partition to the application role', async () => {
    const child = await pool.query<{ name: string }>(
      `SELECT child.relname AS name
         FROM pg_inherits
         JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
         JOIN pg_class child ON child.oid = pg_inherits.inhrelid
        WHERE parent.relname = 'audit_event'
        ORDER BY child.relname
        LIMIT 1`,
    );
    const partition = quoteIdent(child.rows[0]?.name ?? '');
    const client = await (database as TestDatabase).appClient();
    try {
      // The grant was the gap: REVOKE on the parent does not reach its children.
      await expect(client.query(`DELETE FROM ${partition}`)).rejects.toThrow(
        /permission denied|append-only/,
      );
      await expect(client.query(`TRUNCATE ${partition}`)).rejects.toThrow(
        /permission denied|append-only/,
      );
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('creates a future partition through the definer function, still append-only for seamnex_app', async () => {
    const name = 'audit_event_p209901';
    await pool.query(
      'SELECT seamnex_ensure_partition($1::text, $2::text, $3::timestamptz, $4::timestamptz)',
      ['audit_event', name, '2099-01-01T00:00:00.000Z', '2099-02-01T00:00:00.000Z'],
    );

    const privileges = await pool.query<{ can_update: boolean; can_insert: boolean }>(
      `SELECT has_table_privilege('seamnex_app', $1, 'UPDATE') AS can_update,
              has_table_privilege('seamnex_app', $1, 'INSERT') AS can_insert`,
      [name],
    );
    // The scheduler used to create partitions itself, and whoever creates a table owns it — so
    // every partition it rolled forward was fully writable by the application role.
    expect(privileges.rows[0]?.can_update).toBe(false);
    expect(privileges.rows[0]?.can_insert).toBe(true);

    const owner = await pool.query<{ owner: string }>(
      `SELECT tableowner AS owner FROM pg_tables WHERE tablename = $1`,
      [name],
    );
    expect(owner.rows[0]?.owner).not.toBe('seamnex_app');
  });

  it('lets the application role append and read', async () => {
    const client = await (database as TestDatabase).appClient();
    try {
      await client.query(
        `INSERT INTO audit_event (actor_type, actor_id, action, target_type, target_id, outcome)
         VALUES ('service', 'seamnex-api', 'access.denied', 'route', '/instances', 'denied')`,
      );
      const result = await client.query(`SELECT 1 FROM audit_event WHERE action = 'access.denied'`);
      expect(result.rowCount).toBe(1);
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });
});
