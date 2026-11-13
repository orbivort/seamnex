import { createPool } from './client';
import { loadRootEnv } from './env';
import { migrateDown, migrateUp, migrationStatus } from './migrate';

/**
 * `pnpm db:migrate` / `db:rollback` / `db:status`. Kept deliberately small: the only supported way
 * to change the schema is this runner (ADR-BE-04).
 */
async function main(): Promise<number> {
  loadRootEnv();

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    console.error(
      'DATABASE_URL is required. Copy .env.example to .env at the repository root and start the dev stack.',
    );
    return 1;
  }

  const pool = createPool({ connectionString, max: 2, applicationName: 'seamnex-migrate' });
  const command = process.argv[2] ?? 'status';
  const log = (line: string): void => console.log(line);

  try {
    switch (command) {
      case 'up': {
        const executed = await migrateUp({ pool, log });
        log(
          executed.length === 0
            ? 'schema is up to date'
            : `${executed.length} migration(s) applied`,
        );
        return 0;
      }
      case 'down': {
        const steps = Number.parseInt(process.argv[3] ?? '1', 10);
        const reverted = await migrateDown({
          pool,
          steps: Number.isFinite(steps) && steps > 0 ? steps : 1,
          log,
        });
        log(
          reverted.length === 0
            ? 'nothing to roll back'
            : `${reverted.length} migration(s) reverted`,
        );
        return 0;
      }
      case 'status': {
        const status = await migrationStatus(pool);
        log(`applied: ${status.applied.length}`);
        for (const migration of status.applied)
          log(`  ✓ ${migration.id} (${migration.durationMs} ms)`);
        log(`pending: ${status.pending.length}`);
        for (const migration of status.pending) log(`  · ${migration.id}`);
        return status.pending.length === 0 ? 0 : 2;
      }
      default: {
        console.error(`Unknown command "${command}". Expected up, down or status.`);
        return 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await pool.end();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
