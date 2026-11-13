import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * ADR-BE-04 migration runner.
 *
 * Properties that matter, and why:
 *   - paired `.up.sql`/`.down.sql` — exit criterion 2 requires a real rollback;
 *   - checksum per file — an applied migration that is edited afterwards is a defect, not a fix;
 *   - one advisory lock for the whole run — two hosts migrating at once is how schemas diverge;
 *   - one transaction per migration — a failed statement leaves no half-applied group.
 */

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
export const MIGRATION_LOCK_KEY = 918_273_647;

const LEDGER = 'schema_migration';
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

export type MigrationFile = {
  readonly id: string;
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string;
  readonly checksum: string;
};

export type MigrationStatus = {
  readonly applied: { id: string; appliedAt: string; durationMs: number }[];
  readonly pending: MigrationFile[];
};

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function checksumOf(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}

/** Reads the directory, verifies pairing and ordering, and returns migrations by id. */
export function discoverMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  if (!existsSync(dir)) throw new MigrationError(`Migrations directory not found: ${dir}`);

  const found = new Map<string, { name: string; up?: string; down?: string }>();
  for (const file of readdirSync(dir).sort()) {
    const match = FILE_PATTERN.exec(file);
    if (match === null) continue;
    const [, number, name, direction] = match;
    if (number === undefined || name === undefined || direction === undefined) continue;
    const id = `${number}_${name}`;
    const entry = found.get(id) ?? { name };
    if (direction === 'up') entry.up = join(dir, file);
    else entry.down = join(dir, file);
    found.set(id, entry);
  }

  const migrations = [...found.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, entry]) => {
      if (entry.up === undefined || entry.down === undefined) {
        throw new MigrationError(
          `Migration ${id} is missing its ${entry.up === undefined ? 'up' : 'down'} file`,
        );
      }
      return {
        id,
        name: entry.name,
        upPath: entry.up,
        downPath: entry.down,
        checksum: checksumOf(entry.up),
      } satisfies MigrationFile;
    });

  migrations.forEach((migration, index) => {
    const expected = `${String(index + 1).padStart(4, '0')}_`;
    if (!migration.id.startsWith(expected)) {
      throw new MigrationError(
        `Migration ${migration.id} breaks the sequence: expected prefix ${expected}. Renumber rather than leaving a gap.`,
      );
    }
  });

  return migrations;
}

async function ensureLedger(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER} (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )
  `);
}

async function appliedRows(pool: Pool): Promise<Map<string, string>> {
  const result = await pool.query<{ id: string; checksum: string }>(
    `SELECT id, checksum FROM ${LEDGER}`,
  );
  return new Map(result.rows.map((row) => [row.id, row.checksum]));
}

async function withLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

export type MigrateOptions = {
  readonly pool: Pool;
  readonly dir?: string;
  /** Stop after this migration id (inclusive). Used by tests and by `seamnexctl` upgrades. */
  readonly to?: string;
  readonly log?: (line: string) => void;
};

export async function migrateUp(options: MigrateOptions): Promise<string[]> {
  const { pool, dir, to, log } = options;
  const migrations = discoverMigrations(dir);

  return withLock(pool, async () => {
    await ensureLedger(pool);
    const applied = await appliedRows(pool);
    const executed: string[] = [];

    for (const migration of migrations) {
      const previousChecksum = applied.get(migration.id);
      if (previousChecksum !== undefined) {
        if (previousChecksum !== migration.checksum) {
          throw new MigrationError(
            `Migration ${migration.id} was modified after it was applied ` +
              `(ledger ${previousChecksum.slice(0, 12)}…, file ${migration.checksum.slice(0, 12)}…). ` +
              'Add a new migration instead of editing history. ' +
              'A development database created before the change can be rebuilt with ' +
              '`pnpm db:rollback` followed by `pnpm db:migrate`.',
          );
        }
        continue;
      }

      const sql = readFileSync(migration.upPath, 'utf8');
      const startedAt = Date.now();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO ${LEDGER} (id, checksum, duration_ms) VALUES ($1, $2, $3)`,
          [migration.id, migration.checksum, Date.now() - startedAt],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationError(
          `Migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        client.release();
      }

      executed.push(migration.id);
      log?.(`applied ${migration.id} (${Date.now() - startedAt} ms)`);

      if (to !== undefined && migration.id === to) break;
    }

    return executed;
  });
}

export type RollbackOptions = {
  readonly pool: Pool;
  readonly dir?: string;
  /** Number of migrations to revert. Defaults to 1 — a full rollback must be explicit. */
  readonly steps?: number;
  readonly log?: (line: string) => void;
};

export async function migrateDown(options: RollbackOptions): Promise<string[]> {
  const { pool, dir, log } = options;
  const steps = options.steps ?? 1;
  const migrations = new Map(discoverMigrations(dir).map((migration) => [migration.id, migration]));

  return withLock(pool, async () => {
    await ensureLedger(pool);
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM ${LEDGER} ORDER BY id DESC LIMIT $1`,
      [steps],
    );
    const reverted: string[] = [];

    for (const { id } of result.rows) {
      const migration = migrations.get(id);
      if (migration === undefined) {
        throw new MigrationError(`Applied migration ${id} has no file; cannot roll it back safely`);
      }

      const sql = readFileSync(migration.downPath, 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`DELETE FROM ${LEDGER} WHERE id = $1`, [id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationError(
          `Rollback of ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        client.release();
      }

      reverted.push(id);
      log?.(`reverted ${id}`);
    }

    return reverted;
  });
}

export async function migrationStatus(pool: Pool, dir?: string): Promise<MigrationStatus> {
  await ensureLedger(pool);
  const result = await pool.query<{ id: string; applied_at: Date; duration_ms: number }>(
    `SELECT id, applied_at, duration_ms FROM ${LEDGER} ORDER BY id`,
  );
  const appliedIds = new Set(result.rows.map((row) => row.id));

  return {
    applied: result.rows.map((row) => ({
      id: row.id,
      appliedAt: row.applied_at.toISOString(),
      durationMs: row.duration_ms,
    })),
    pending: discoverMigrations(dir).filter((migration) => !appliedIds.has(migration.id)),
  };
}
