import { defineConfig } from 'vitest/config';
import { coverageConfig, testDefaults } from '@seamnex/config/vitest/base';

/**
 * Pure schema and state-machine tests: no datastore, no DOM. The package is the contract every
 * other package validates against, so its coverage is the one number worth watching — and the one
 * package where a floor can be enforced without a service being healthy.
 */
export default defineConfig({
  test: {
    ...testDefaults,
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    coverage: coverageConfig({
      include: ['src/**/*.ts'],
      // `src/index.ts` is a barrel: it compiles to re-export bindings and has no statements of its
      // own, so V8 reports 0/0 and there is nothing to measure — and a 0% line in the report reads
      // like an untested module. Its surface is tested by `test/unit/index.test.ts`, which compares
      // the barrel against the twenty-eight modules it re-exports, in both directions. If the
      // barrel ever gains a statement, drop it from this list instead of leaving it unmeasured.
      exclude: ['src/index.ts'],
      // The shared per-file floor applies here too: 90 % on statements, branches, functions and
      // lines, checked for every file rather than against the package average.
    }),
  },
});
