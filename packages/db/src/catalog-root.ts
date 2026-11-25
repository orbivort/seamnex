import { isAbsolute, join, resolve } from 'node:path';
import { REPOSITORY_ROOT } from './env';

/**
 * `SEAMNEX_CATALOG_REPO_PATH`, resolved.
 *
 * A relative value is resolved against the repository root, not against `process.cwd()`: pnpm starts
 * these scripts inside `packages/db`, and `./temp/catalog-repo` in the root `.env` means the
 * repository's own `temp/`. The API resolves it the same way (`loadConfig`), which is what keeps the
 * seed, the coverage gate and the loader looking at one directory instead of three.
 *
 * Lives here rather than in the seed because the gate is not the seed's caller and must not import
 * the projector's module to learn where the tree is (ADR-BE-42 §10.5).
 */
export function catalogRepoRoot(configured: string | undefined): string {
  const value = (configured ?? '').trim();
  if (value.length === 0) return join(REPOSITORY_ROOT, 'temp', 'catalog-repo');
  return isAbsolute(value) ? value : resolve(REPOSITORY_ROOT, value);
}
