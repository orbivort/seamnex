import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config';
import { coverageConfig, testDefaults } from '@seamnex/config/vitest/base';
// The extension is required, not optional: Vite's `configLoader: 'native'` (the future default)
// cannot resolve an extensionless relative import, and it already warns about this one.
import viteConfig from './vite.config.ts';

/**
 * The test config is the app's Vite config plus a `test` block — never a second copy of it.
 *
 * Restating `define` and the React plugin here is how the two drifted: a new `__SEAMNEX_*` flag or a
 * resolver change had to be made twice, and `envDir` was never carried over, so `import.meta.env`
 * resolved differently under test than in dev. Merging the real config keeps one source of truth.
 *
 * `vite.config.ts` treats `mode: 'test'` as "mock platform on", so the flags and the
 * `@seamnex/mocks` alias arrive already correct; the block below only decides *how tests run*.
 *
 * Two projects run, because one build flag cannot have two values in a single module graph:
 *
 * - `console` — the ordinary suite, under the test build (`__SEAMNEX_MOCKS__` is `true`). It covers
 *   both kinds: `test/unit` (one module or component) and `test/integration` (the app's routes,
 *   mounted through `app.tsx`).
 * - `console-live` — the live-build seam (`api-mode.ts`'s fetch transport and server-session
 *   routing), where `__SEAMNEX_MOCKS__` is the literal `false` a production bundle sees. Without it
 *   those branches are unreachable dead code and the file can never be measured honestly. Its only
 *   suite lives in `test/integration/live`, below the kind it belongs to.
 *
 * Coverage stays at the root and is merged across both projects, so one report describes the whole
 * app rather than whichever build happened to run.
 */
export default defineConfig(async (env) => {
  const fromVite = (
    typeof viteConfig === 'function' ? await viteConfig(env) : await viteConfig
  ) as ViteUserConfig;

  return mergeConfig(
    fromVite,
    defineConfig({
      test: {
        ...testDefaults,
        environment: 'jsdom',
        setupFiles: ['./test/setup.ts'],
        testTimeout: 30_000,
        projects: [
          {
            test: {
              name: 'console',
              include: ['test/unit/**/*.test.{ts,tsx}', 'test/integration/**/*.test.{ts,tsx}'],
              // The live project owns these; running them twice would run the same assertions
              // under the wrong build flag.
              exclude: ['test/integration/live/**', '**/node_modules/**'],
            },
          },
          {
            // A per-project `define` is what makes the live branches reachable; the `@seamnex/mocks`
            // alias is deliberately *not* flipped, because the live suite still talks to the mock
            // platform over HTTP and `api-mode` imports nothing from it.
            define: { __SEAMNEX_MOCKS__: 'false' },
            test: {
              name: 'console-live',
              include: ['test/integration/live/**/*.test.{ts,tsx}'],
            },
          },
        ],
        coverage: coverageConfig({
          include: ['src/**/*.{ts,tsx}'],
          // Test harness, the build-time stub a production bundle aliases in, the React entry point
          // (mounted by main.tsx, never imported by a test) and the deploy wizard's type-only module
          // (interfaces and aliases, no runtime statement): none of them is shipped logic that a
          // test could meaningfully exercise.
          exclude: [
            'test/**',
            'src/production-mocks-stub.ts',
            'src/main.tsx',
            'src/features/deploy/steps/types.ts',
          ],
          // The per-file floor (statements, branches, functions, lines) is the shared one from
          // `@seamnex/config/vitest/base`, so a merged report cannot let an untested screen ride on the
          // well-covered rest.
        }),
      },
    }),
  );
});
