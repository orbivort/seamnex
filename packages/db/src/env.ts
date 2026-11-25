import { resolve } from 'node:path';

/**
 * The monorepo root, from `packages/db/src`.
 *
 * This package resolves two things against it — the root `.env` here and the catalogue checkout path
 * (`catalog-root.ts`, `./temp/catalog-repo`) — so the depth is stated once. A second
 * `'../../../..'` next to a caller's own path would be one move away from reading a different
 * directory. The catalogue documents themselves are not here: they are a checkout (ADR-BE-42).
 */
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Loads the monorepo root `.env` for the standalone entry points (`pnpm db:migrate`,
 * `pnpm db:rollback`, `pnpm db:status`, `pnpm db:seed`) and for the API role lifecycle, which
 * calls it before validating the environment.
 *
 * `tsx` never reads a `.env` file and pnpm starts these scripts with the package as cwd, so
 * without this a process only sees variables exported by the caller. `pnpm dev` used to hide the
 * problem by injecting `DATABASE_URL` from `scripts/dev.mjs`, which left `pnpm dev:api` broken.
 *
 * Variables already present in the environment win: Node's env-file loader does not overwrite
 * them, so CI and an explicit `--env-file` stay authoritative, and a container's environment is
 * never overridden by a stray file.
 */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(resolve(REPOSITORY_ROOT, '.env'));
  } catch (error) {
    // A missing root `.env` is not fatal: the caller may supply the variables itself.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
