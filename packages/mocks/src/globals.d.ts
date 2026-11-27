/**
 * Vite's deployment base, always trailing-slashed (`/`, `/seamnex/`, …).
 *
 * Declared here rather than pulled in with `vite/client`: this package is compiled as source inside
 * the app that imports it and never type-checks against Vite's ambient types on its own.
 */
interface ImportMetaEnv {
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
