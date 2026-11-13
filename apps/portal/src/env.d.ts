/// <reference types="vite/client" />

/**
 * The `VITE_*` contract this app reads. Declared rather than left to `vite/client`'s index
 * signature, which types every name as `string | boolean | undefined`: a typo is then a type error
 * at the read site instead of an API base URL that silently resolves to `undefined`.
 *
 * The values come from the root `.env` (`envDir` in `@seamnex/config/vite/app`); `.env.example` is the
 * list of what a developer sets.
 */
interface ImportMetaEnv {
  /** Dev proxy target, and the API origin a production build talks to; see `api-mode.ts`. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Replaced at build time by Vite (`define`). `true` in dev/test/demo, `false` in a
 * production build, so the mock bootstrap is removed by dead-code elimination.
 */
declare const __SEAMNEX_MOCKS__: boolean;

/**
 * Replaced at build time by Vite (`define`). `true` in dev/test/demo, `false` in production,
 * where the API repeats the request-side contract validation this flag guards.
 */
declare const __SEAMNEX_CONTRACT_CHECKS__: boolean;

/**
 * Replaced at build time by Vite (`define`) with the `version` field of the root `package.json`.
 * `unknown` when the manifest could not be read; `ProductVersion` in `@seamnex/shell` renders that
 * case rather than printing a number nobody can trust.
 */
declare const __SEAMNEX_VERSION__: string;
