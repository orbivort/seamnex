import { defineConfig } from 'vitest/config';
import { coverageConfig, testDefaults } from '@seamnex/config/vitest/base';

/** Pure formatting and pagination helpers: no DOM, no datastore. */
export default defineConfig({
  test: {
    ...testDefaults,
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    coverage: coverageConfig({
      include: ['src/**/*.ts'],
      // `src/index.ts` is a barrel: it compiles to re-export bindings and has no statements of its
      // own, so V8 reports 0/0 and there is nothing to measure. Its surface is still tested — by
      // `test/unit/index.test.ts`, which asserts every binding against the module publishing it.
      // If the barrel ever gains a statement, drop it from this list instead of leaving it
      // unmeasured.
      exclude: ['src/index.ts'],
    }),
  },
});
