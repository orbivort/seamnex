import { defineConfig } from 'vitest/config';
import { coverageConfig, testDefaults } from '@seamnex/config/vitest/base';

/**
 * Split by what the suite needs, not by directory: `db-schema` creates and drops a throwaway
 * database per file, so it must not run files in parallel; `db-unit` covers query and migration
 * helpers with no datastore and keeps the ordinary timeout.
 */
export default defineConfig({
  test: {
    ...testDefaults,
    environment: 'node',
    coverage: coverageConfig({
      include: ['src/**/*.ts'],
      exclude: [
        // Integration-test support, exercised by the suites that use it rather than by the unit
        // project, and only meaningful against a real database.
        'src/testing.ts',
        // A re-export barrel and a declarations-only module have no executable statements, so they
        // would report 0/0 forever. Naming them keeps the per-file threshold meaningful.
        'src/index.ts',
        'src/tables.ts',
      ],
      // The shared per-file floor applies to every package; for this one it is measured by
      // `db-unit`, because the schema suites are skipped unless a disposable database is
      // configured.
    }),
    projects: [
      {
        test: {
          name: 'db-unit',
          // `test/unit` mirrors `src`, so the unit suites sit in the test tree rather than beside
          // the modules they cover. `test/fakes.ts` and `test/helpers.ts` stay at the root of
          // `test` and are reached as `../fakes` / `../helpers`; `test/integration` belongs to
          // `db-schema`.
          include: ['test/unit/**/*.test.ts'],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'db-schema',
          // Integration tests are skipped unless SEAMNEX_TEST_DATABASE_URL points at a disposable
          // database, so they need the longer timeout when it does.
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
