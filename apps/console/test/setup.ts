/**
 * The console's vitest setup is the shared harness (`@seamnex/mocks/vitest/setup`) verbatim.
 *
 * `vitest.config.ts` still points at `./test/setup.ts`, so the app keeps one obvious place
 * to add console-only bootstrapping; if that is ever needed, it goes below this re-export.
 */
export * from '@seamnex/mocks/vitest/setup';
