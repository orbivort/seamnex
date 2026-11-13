import { defineConfig } from 'vitest/config';
import { coverageConfig, testDefaults } from '@seamnex/config/vitest/base';

/**
 * Two projects, because they are two kinds of test with opposite resource needs:
 *
 * - `api-unit` — pure handlers, filters and services. Fast, parallel, no service required.
 * - `api-integration` — the audit/jobs/secrets suites against a real Postgres and Redis. Gated on
 *   `SEAMNEX_TEST_DATABASE_URL`, serialised, and given a timeout that a container start can fit inside.
 *
 * Splitting them means the relaxed timeout and the serialisation apply only where they are earned,
 * and CI can select one with `--project api-integration` instead of relying on env-gated skips.
 */
export default defineConfig({
  test: {
    ...testDefaults,
    environment: 'node',
    // The per-file floor applies here like anywhere else, but the integration suites are gated on
    // `SEAMNEX_TEST_DATABASE_URL`: without a datastore they are skipped, and the modules only they
    // exercise are reported at 0 %. Run `test:coverage` with the stack up (the CI `database` job
    // does) so the numbers the gate sees describe the whole app rather than the unit project.
    coverage: coverageConfig({
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.contract.ts',
        /*
         * Declaration-only modules: every export is a `type`, so the compiler erases the file and
         * there is no statement, branch or function to execute. Measuring them reports 0 % for a
         * file with no code, which is a number that cannot be improved — and a gate nobody can
         * satisfy is a gate that gets switched off. They are still compile-checked, and each is
         * loaded by a test — `test/unit/type-only-modules.test.ts` for the first two,
         * `provisioning-adapter.test.ts` for the port — to prove the modules resolve.
         */
        'src/roles/role.ts',
        'src/contract/operation-handler.ts',
        'src/modules/m24-sign-in-relay/provisioning-adapter.ts',
      ],
    }),
    projects: [
      {
        test: {
          name: 'api-unit',
          // `test/unit` holds every datastore-free test: the per-module suites, mirrored from `src`
          // so no test file ships inside the source tree, plus the static gates (route parity,
          // handler coverage, wiring). None of them needs a datastore, so they belong with the unit
          // project rather than inheriting the integration project's serialisation and 60 s
          // timeouts.
          include: ['test/unit/**/*.ts'],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'api-integration',
          // The two folders are disjoint, so no exclusion is needed to keep a suite in one project.
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // The suites share one Postgres/Redis stack; running files together makes them contend
          // for connections and rate-limit buckets rather than test the code.
          fileParallelism: false,
        },
      },
    ],
  },
});
