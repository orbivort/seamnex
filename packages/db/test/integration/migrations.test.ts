import { afterAll, describe, expect, it } from 'vitest';
import { discoverMigrations, migrateDown, migrateUp, migrationStatus } from '../../src/migrate';
import { loadBoundaries, tablesByModule } from '../../src/ownership';
import { createTestDatabase, skipUnlessDatabase, type TestDatabase } from '../helpers';

/**
 * Exit criterion 2: "Schema v1 migrates up and down on an empty database."
 *
 * These tests run against a throwaway database created per suite, so they are safe to run next to
 * a development stack.
 */
let database: TestDatabase | undefined;

afterAll(async () => {
  await database?.drop();
});

describe('migration files', () => {
  it('pairs every up migration with a down migration and numbers them without gaps', () => {
    const migrations = discoverMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(10);
    migrations.forEach((migration, index) => {
      expect(migration.id.startsWith(String(index + 1).padStart(4, '0'))).toBe(true);
      expect(migration.downPath).toContain('_');
    });
  });

  it('owns every table in the boundary manifest exactly once', () => {
    const tables = tablesByModule(loadBoundaries());
    expect(tables.size).toBeGreaterThanOrEqual(70);
    const duplicated = [...tables.keys()].filter((table) => table.trim().length === 0);
    expect(duplicated).toEqual([]);
  });
});

describe.skipIf(skipUnlessDatabase() !== false)('schema v1 on an empty database', () => {
  it('migrates up, rolls back completely, and migrates up again', async () => {
    database = await createTestDatabase();
    const { pool } = database;

    const manifestTables = [...tablesByModule(loadBoundaries()).keys()];

    const present = async (): Promise<Set<string>> => {
      const result = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      return new Set(result.rows.map((row) => row.table_name));
    };

    const afterUp = await present();
    const missing = manifestTables.filter((table) => !afterUp.has(table));
    expect(missing, 'tables declared in module-boundaries.json but absent from schema v1').toEqual(
      [],
    );

    const status = await migrationStatus(pool);
    expect(status.pending).toEqual([]);

    const reverted = await migrateDown({ pool, steps: status.applied.length });
    expect(reverted).toHaveLength(status.applied.length);

    const afterDown = await present();
    const leftovers = manifestTables.filter((table) => afterDown.has(table));
    expect(leftovers, 'tables still present after a full rollback').toEqual([]);
    expect(afterDown.has('schema_migration')).toBe(true);

    const reapplied = await migrateUp({ pool });
    expect(reapplied).toHaveLength(status.applied.length);
    expect((await present()).has('audit_event')).toBe(true);
  });

  it('refuses to re-apply a migration whose file changed after it ran', async () => {
    const { pool } = database as TestDatabase;
    await pool.query(
      `UPDATE schema_migration SET checksum = 'tampered' WHERE id = '0002_catalog_definition'`,
    );
    await expect(migrateUp({ pool })).rejects.toThrow(/was modified after it was applied/);
    // Restore the ledger so later suites see a consistent schema.
    await pool.query(
      `UPDATE schema_migration SET checksum = $1 WHERE id = '0002_catalog_definition'`,
      [
        discoverMigrations().find((migration) => migration.id === '0002_catalog_definition')
          ?.checksum,
      ],
    );
  });
});
