import { defineConfig } from 'vitest/config';
import { coverageConfig, testDefaults } from '@seamnex/config/vitest/base';

/**
 * The request pipeline is environment-agnostic on purpose (it guards `window`, `document` and
 * `sessionStorage` itself), so it is tested on Node with a stub transport rather than in a browser.
 *
 * `__SEAMNEX_CONTRACT_CHECKS__` mirrors the app builds: with request-side checks on, the guards that a
 * production bundle removes are the ones under test.
 */
export default defineConfig({
  define: { __SEAMNEX_CONTRACT_CHECKS__: 'true' },
  test: {
    ...testDefaults,
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    coverage: coverageConfig({
      // `.tsx` is included so a new component cannot be added to the package and stay silently
      // unmeasured; `provider.tsx` is the only one today and is excluded below.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // Barrels: re-export bindings only, no statements to measure. Their surface is tested by
        // `test/unit/barrels.test.ts`, which compares both entry points against the modules.
        'src/index.ts',
        'src/hooks/index.ts',
        // `ApiProvider` is a React component: covering it needs a DOM renderer and a renderer
        // dependency this Node suite does not carry. The app suites mount it, and a test that only
        // called the function would assert the element's shape, not the cache behaviour that makes
        // it worth having.
        'src/provider.tsx',
      ],
    }),
  },
});
