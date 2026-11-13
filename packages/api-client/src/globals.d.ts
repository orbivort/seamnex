/**
 * Build-time flags this package reads. Each app injects them with Vite `define` (and its test
 * config does the same), so the branches they guard are removed from a production bundle instead
 * of being evaluated at runtime.
 *
 * Declared here as well as in each app's `env.d.ts` because this package is compiled as source
 * inside the app that imports it, and both programs need the global to be known.
 */

/**
 * Request-side contract validation (body and query) is enabled in development, test and demo
 * builds and disabled in production, where the API performs the same validation.
 */
declare const __SEAMNEX_CONTRACT_CHECKS__: boolean;
