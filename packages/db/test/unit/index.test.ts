import { describe, expect, it } from 'vitest';
import * as db from '../../src/index';

/**
 * The package entry point. A re-export that goes missing is invisible to the module that used to
 * import it until that module is loaded, so the public surface is asserted in one place.
 */
describe('@seamnex/db public surface', () => {
  it('exposes the pool factory, the readiness probe and the timeout constants', () => {
    expect(typeof db.createPool).toBe('function');
    expect(typeof db.probeDatabase).toBe('function');
    expect(typeof db.elapsedMs).toBe('function');
    expect(db.STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(db.IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(30_000);
    expect(db.CONNECTION_TIMEOUT_MS).toBe(5_000);
    expect(db.IDLE_TIMEOUT_MS).toBe(30_000);
  });

  it('exposes the transaction, audited-mutation and advisory-lock helpers', () => {
    expect(typeof db.withTransaction).toBe('function');
    expect(typeof db.withAuditedMutation).toBe('function');
    expect(typeof db.withAdvisoryLock).toBe('function');
  });

  it('exposes the migration runner', () => {
    expect(typeof db.discoverMigrations).toBe('function');
    expect(typeof db.migrateUp).toBe('function');
    expect(typeof db.migrateDown).toBe('function');
    expect(typeof db.migrationStatus).toBe('function');
    expect(db.MIGRATION_LOCK_KEY).toBe(918_273_647);
    expect(db.DEFAULT_MIGRATIONS_DIR).toMatch(/migrations$/);
    expect(new db.MigrationError('x')).toBeInstanceOf(Error);
  });

  it('exposes the boundary manifest and the repository seam', () => {
    expect(typeof db.loadBoundaries).toBe('function');
    expect(typeof db.tablesByModule).toBe('function');
    expect(typeof db.ownerOfTable).toBe('function');
    expect(typeof db.moduleByDir).toBe('function');
    expect(typeof db.readersOfTable).toBe('function');
    expect(db.MANIFEST_PATH).toMatch(/module-boundaries\.json$/);
    expect(typeof db.Repository).toBe('function');
  });
});
