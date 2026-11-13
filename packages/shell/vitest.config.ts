import { defineConfig } from 'vitest/config';
import { coverageConfig, testDefaults } from '@seamnex/config/vitest/base';

/**
 * The shared shell is React and DOM-facing (sign-in, session gate, async panels), so it uses the
 * same jsdom environment as the apps that mount it.
 */
export default defineConfig({
  test: {
    ...testDefaults,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/unit/**/*.test.{ts,tsx}'],
    coverage: coverageConfig({
      include: ['src/**/*.{ts,tsx}'],
      // `src/index.ts` is a barrel: re-export bindings only, no statements to measure. Its surface
      // is tested by `test/unit/index.test.ts`, which pins the exact set of runtime symbols.
      exclude: ['test/**', 'src/index.ts'],
    }),
  },
});
