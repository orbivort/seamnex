import { defineConfig } from 'vitest/config';
import { coverageConfig, testDefaults } from '@seamnex/config/vitest/base';

/**
 * Component tests, in jsdom. The primitives render no CSS: they compose class strings, which is
 * what a test can assert about them — layout itself is the browser's job, not jsdom's.
 *
 * The threshold is per file, not per project: an aggregate number lets a well-tested primitive
 * hide a module nobody ever rendered.
 *
 * The barrels are excluded from measurement rather than reported at 0%: they compile to re-export
 * bindings with no statements of their own, so V8 reports 0/0 and the entry in the report is noise.
 * They are not untested — `test/unit/barrels.test.ts` asserts that every name a subpath publishes is
 * the same binding the root barrel publishes. If a barrel ever gains a statement, drop it from the
 * exclusion list and let the per-file gate see it.
 */
export default defineConfig({
  test: {
    ...testDefaults,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/unit/**/*.test.{ts,tsx}'],
    coverage: coverageConfig({
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['test/**', 'src/index.ts', 'src/*/index.ts'],
    }),
  },
});
