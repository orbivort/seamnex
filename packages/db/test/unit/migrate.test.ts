import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  MIGRATION_LOCK_KEY,
  MigrationError,
  discoverMigrations,
  migrateDown,
  migrateUp,
  migrationStatus,
} from '../../src/migrate';
import {
  createLedgerPool,
  firstOf,
  type LedgerEntry,
  type LedgerPoolHandle,
  type LedgerPoolOptions,
} from '../fakes';

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Writes a directory of migration files and returns its path. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-migrations-'));
  scratch.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function ledgerPool(
  entries: readonly LedgerEntry[] = [],
  failWith?: LedgerPoolOptions['failWith'],
): LedgerPoolHandle {
  return createLedgerPool(failWith === undefined ? { entries } : { entries, failWith });
}

/** The checksum a file's content must produce, computed independently of the implementation. */
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const ALPHA_UP = 'CREATE TABLE alpha (id integer PRIMARY KEY);';
const ALPHA_DOWN = 'DROP TABLE alpha;';
const BETA_UP = 'ALTER TABLE alpha ADD COLUMN beta text;';
const BETA_DOWN = 'ALTER TABLE alpha DROP COLUMN beta;';

describe('discoverMigrations', () => {
  it('pairs up and down files, keeps the order and checksums only the up file', () => {
    const dir = fixture({
      '0002_add_beta.up.sql': BETA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
      '0002_add_beta.down.sql': BETA_DOWN,
      '0001_create_alpha.up.sql': ALPHA_UP,
    });

    const migrations = discoverMigrations(dir);

    expect(migrations.map((migration) => migration.id)).toEqual([
      '0001_create_alpha',
      '0002_add_beta',
    ]);
    expect(migrations.map((migration) => migration.name)).toEqual(['create_alpha', 'add_beta']);
    expect(firstOf(migrations).upPath).toBe(join(dir, '0001_create_alpha.up.sql'));
    expect(firstOf(migrations).downPath).toBe(join(dir, '0001_create_alpha.down.sql'));
    expect(firstOf(migrations).checksum).toBe(sha256(ALPHA_UP));
    // A rollback file edited afterwards must not change what counts as applied.
    expect(migrations[1]?.checksum).not.toBe(sha256(BETA_DOWN));
  });

  it('ignores files that are not a numbered up/down pair', () => {
    const dir = fixture({
      'README.md': 'how migrations work',
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
      '0001_create_alpha.up.sql.bak': 'stale copy',
      '001_short_number.up.sql': 'SELECT 1;',
      '0002_UPPERCASE.up.sql': 'SELECT 1;',
    });

    expect(discoverMigrations(dir).map((migration) => migration.id)).toEqual(['0001_create_alpha']);
  });

  it('refuses a directory that does not exist', () => {
    expect(() => discoverMigrations(join(tmpdir(), 'seamnex-migrations-does-not-exist'))).toThrow(
      /Migrations directory not found/,
    );
  });

  it('refuses an up file with no down file', () => {
    const dir = fixture({ '0001_create_alpha.up.sql': ALPHA_UP });

    expect(() => discoverMigrations(dir)).toThrow(/is missing its down file/);
  });

  it('refuses a down file with no up file', () => {
    const dir = fixture({ '0001_create_alpha.down.sql': ALPHA_DOWN });

    expect(() => discoverMigrations(dir)).toThrow(/is missing its up file/);
  });

  it('refuses a gap in the sequence instead of applying 0003 after 0001', () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
      '0003_add_beta.up.sql': BETA_UP,
      '0003_add_beta.down.sql': BETA_DOWN,
    });

    expect(() => discoverMigrations(dir)).toThrow(/breaks the sequence: expected prefix 0002_/);
  });

  it('reads the schema shipped with the package by default', () => {
    const migrations = discoverMigrations();

    expect(DEFAULT_MIGRATIONS_DIR).toMatch(/migrations$/);
    expect(migrations.length).toBeGreaterThanOrEqual(10);
    migrations.forEach((migration, index) => {
      expect(migration.id.startsWith(String(index + 1).padStart(4, '0'))).toBe(true);
      expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it('names the error type so a caller can distinguish a schema defect from a driver failure', () => {
    expect(new MigrationError('x')).toMatchObject({ name: 'MigrationError', message: 'x' });
    expect(new MigrationError('x')).toBeInstanceOf(Error);
  });
});

describe('migrateUp', () => {
  it('applies every pending migration in order and records each in the ledger', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
      '0002_add_beta.up.sql': BETA_UP,
      '0002_add_beta.down.sql': BETA_DOWN,
    });
    const { pool, ledger, statements } = ledgerPool();
    const logged: string[] = [];

    const executed = await migrateUp({ pool, dir, log: (line) => logged.push(line) });

    expect(executed).toEqual(['0001_create_alpha', '0002_add_beta']);
    expect([...ledger.keys()]).toEqual(['0001_create_alpha', '0002_add_beta']);
    expect(ledger.get('0001_create_alpha')?.checksum).toBe(sha256(ALPHA_UP));

    // Each migration is its own transaction, issued while the run holds the advisory lock.
    const lock = statements.indexOf('SELECT pg_advisory_lock($1)');
    const unlock = statements.indexOf('SELECT pg_advisory_unlock($1)');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(unlock).toBeGreaterThan(lock);
    expect(statements.filter((sql) => sql === 'BEGIN')).toHaveLength(2);
    expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(2);
    expect(statements).toContain(ALPHA_UP);
    expect(statements).toContain(BETA_UP);
    expect(statements.indexOf(ALPHA_UP)).toBeLessThan(statements.indexOf(BETA_UP));

    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatch(/^applied 0001_create_alpha \(\d+ ms\)$/);
    expect(logged[1]).toMatch(/^applied 0002_add_beta \(\d+ ms\)$/);
    expect(MIGRATION_LOCK_KEY).toBeGreaterThan(0);
  });

  it('does nothing when the ledger already records every file with a matching checksum', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
    });
    const only = firstOf(discoverMigrations(dir));
    const logged: string[] = [];
    const { pool, statements } = ledgerPool([{ id: only.id, checksum: only.checksum }]);

    await expect(migrateUp({ pool, dir, log: (line) => logged.push(line) })).resolves.toEqual([]);

    expect(statements).not.toContain(ALPHA_UP);
    expect(logged).toEqual([]);
  });

  it('refuses to continue when an applied migration was edited afterwards', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
    });
    const { pool } = ledgerPool([{ id: '0001_create_alpha', checksum: 'tampered' }]);

    await expect(migrateUp({ pool, dir })).rejects.toThrow(
      /0001_create_alpha was modified after it was applied \(ledger tampered…, file [a-f0-9]{12}…\)/,
    );
  });

  it('stops after the requested migration, inclusive', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
      '0002_add_beta.up.sql': BETA_UP,
      '0002_add_beta.down.sql': BETA_DOWN,
      '0003_add_gamma.up.sql': 'CREATE TABLE gamma (id integer);',
      '0003_add_gamma.down.sql': 'DROP TABLE gamma;',
    });
    const { pool, ledger } = ledgerPool();

    const executed = await migrateUp({ pool, dir, to: '0002_add_beta' });

    expect(executed).toEqual(['0001_create_alpha', '0002_add_beta']);
    expect(ledger.has('0003_add_gamma')).toBe(false);
  });

  it('rolls the migration back and names it when the SQL fails', async () => {
    const dir = fixture({
      '0001_boom.up.sql': 'CREATE TABLE boom (id integer) FAIL;',
      '0001_boom.down.sql': 'DROP TABLE boom;',
    });
    const { pool, ledger, statements } = ledgerPool([], (sql) =>
      sql.includes('FAIL') ? new Error('syntax error at or near "FAIL"') : undefined,
    );

    await expect(migrateUp({ pool, dir })).rejects.toThrow(
      /Migration 0001_boom failed: syntax error at or near "FAIL"/,
    );

    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(ledger.size).toBe(0);
  });

  it('reports a non-Error thrown by the server as text', async () => {
    const dir = fixture({
      '0001_boom.up.sql': 'CREATE TABLE boom (id integer) FAIL;',
      '0001_boom.down.sql': 'DROP TABLE boom;',
    });
    const { pool } = ledgerPool([], (sql) =>
      sql.includes('FAIL') ? 'connection terminated unexpectedly' : undefined,
    );

    await expect(migrateUp({ pool, dir })).rejects.toThrow(
      /Migration 0001_boom failed: connection terminated unexpectedly/,
    );
  });

  it('keeps the original failure when ROLLBACK is not possible either', async () => {
    const dir = fixture({
      '0001_boom.up.sql': 'CREATE TABLE boom (id integer) FAIL;',
      '0001_boom.down.sql': 'DROP TABLE boom;',
    });
    const { pool, statements } = ledgerPool([], (sql) => {
      if (sql.includes('FAIL')) return new Error('syntax error');
      if (sql === 'ROLLBACK') return new Error('server closed the connection');
      return undefined;
    });

    await expect(migrateUp({ pool, dir })).rejects.toThrow(
      /Migration 0001_boom failed: syntax error/,
    );
    expect(statements).toContain('ROLLBACK');
  });
});

describe('migrateDown', () => {
  it('reverts one migration by default, in reverse order', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
      '0002_add_beta.up.sql': BETA_UP,
      '0002_add_beta.down.sql': BETA_DOWN,
    });
    const migrations = discoverMigrations(dir);
    const { pool, ledger, statements } = ledgerPool(
      migrations.map((migration) => ({ id: migration.id, checksum: migration.checksum })),
    );
    const logged: string[] = [];

    const reverted = await migrateDown({ pool, dir, log: (line) => logged.push(line) });

    expect(reverted).toEqual(['0002_add_beta']);
    expect([...ledger.keys()]).toEqual(['0001_create_alpha']);
    expect(statements).toContain(BETA_DOWN);
    expect(statements).not.toContain(ALPHA_DOWN);
    expect(logged).toEqual(['reverted 0002_add_beta']);
  });

  it('reverts the requested number of migrations', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
      '0002_add_beta.up.sql': BETA_UP,
      '0002_add_beta.down.sql': BETA_DOWN,
    });
    const migrations = discoverMigrations(dir);
    const { pool, ledger } = ledgerPool(
      migrations.map((migration) => ({ id: migration.id, checksum: migration.checksum })),
    );

    const reverted = await migrateDown({ pool, dir, steps: 2 });

    expect(reverted).toEqual(['0002_add_beta', '0001_create_alpha']);
    expect(ledger.size).toBe(0);
  });

  it('reverts nothing when the ledger is empty', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
    });
    const { pool, statements } = ledgerPool();

    await expect(migrateDown({ pool, dir, steps: 5 })).resolves.toEqual([]);
    expect(statements).not.toContain(ALPHA_DOWN);
  });

  it('refuses to roll back a migration whose file has disappeared', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
    });
    const { pool } = ledgerPool([{ id: '0099_orphan', checksum: sha256('gone') }]);

    await expect(migrateDown({ pool, dir })).rejects.toThrow(
      /Applied migration 0099_orphan has no file; cannot roll it back safely/,
    );
  });

  it('reports a failing down file and rolls back that statement', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': 'DROP TABLE alpha FAIL;',
    });
    const { pool, ledger, statements } = ledgerPool(
      [{ id: '0001_create_alpha', checksum: sha256(ALPHA_UP) }],
      (sql) => (sql.includes('FAIL') ? new Error('cannot drop table alpha') : undefined),
    );

    await expect(migrateDown({ pool, dir })).rejects.toThrow(
      /Rollback of 0001_create_alpha failed: cannot drop table alpha/,
    );

    expect(statements).toContain('ROLLBACK');
    expect(ledger.has('0001_create_alpha')).toBe(true);
  });

  it('keeps the original failure when the failed rollback cannot be rolled back either', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': 'DROP TABLE alpha FAIL;',
    });
    const { pool, statements } = ledgerPool(
      [{ id: '0001_create_alpha', checksum: sha256(ALPHA_UP) }],
      (sql) => {
        if (sql.includes('FAIL')) return new Error('cannot drop table alpha');
        if (sql === 'ROLLBACK') return new Error('connection already closed');
        return undefined;
      },
    );

    await expect(migrateDown({ pool, dir })).rejects.toThrow(
      /Rollback of 0001_create_alpha failed: cannot drop table alpha/,
    );
    expect(statements).toContain('ROLLBACK');
  });

  it('reports a non-Error thrown by a down file as text', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': 'DROP TABLE alpha FAIL;',
    });
    const { pool } = ledgerPool([{ id: '0001_create_alpha', checksum: sha256(ALPHA_UP) }], (sql) =>
      sql.includes('FAIL') ? 'cannot drop table alpha' : undefined,
    );

    await expect(migrateDown({ pool, dir })).rejects.toThrow(
      /Rollback of 0001_create_alpha failed: cannot drop table alpha/,
    );
  });
});

describe('migrationStatus', () => {
  it('lists what has been applied, with timestamps, and what is still pending', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
      '0002_add_beta.up.sql': BETA_UP,
      '0002_add_beta.down.sql': BETA_DOWN,
    });
    const { pool } = ledgerPool([
      {
        id: '0001_create_alpha',
        checksum: sha256(ALPHA_UP),
        appliedAt: new Date('2025-02-03T04:05:06.000Z'),
        durationMs: 12,
      },
    ]);

    const status = await migrationStatus(pool, dir);

    expect(status.applied).toEqual([
      { id: '0001_create_alpha', appliedAt: '2025-02-03T04:05:06.000Z', durationMs: 12 },
    ]);
    expect(status.pending.map((migration) => migration.id)).toEqual(['0002_add_beta']);
  });

  it('reports every file as pending on a database that has never been migrated', async () => {
    const dir = fixture({
      '0001_create_alpha.up.sql': ALPHA_UP,
      '0001_create_alpha.down.sql': ALPHA_DOWN,
    });
    const { pool } = ledgerPool();

    const status = await migrationStatus(pool, dir);

    expect(status.applied).toEqual([]);
    expect(status.pending.map((migration) => migration.id)).toEqual(['0001_create_alpha']);
  });
});
