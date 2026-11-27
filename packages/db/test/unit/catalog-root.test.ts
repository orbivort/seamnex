import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogRepoRoot } from '../../src/catalog-root';
import { REPOSITORY_ROOT } from '../../src/env';

/**
 * One rule, resolved once (ADR-BE-42 §10.5).
 *
 * The seed, the coverage gate and the API all have to agree on which directory is the catalogue
 * checkout; three copies of "relative to what?" is how a gate ends up checking a directory nothing
 * serves. These cases pin the three inputs `.env` can actually produce.
 */
describe('catalogRepoRoot', () => {
  it('falls back to the repository-owned default when unset or empty', () => {
    const fallback = join(REPOSITORY_ROOT, 'temp', 'catalog-repo');

    expect(catalogRepoRoot(undefined)).toBe(fallback);
    expect(catalogRepoRoot('')).toBe(fallback);
    // Whitespace is not a path: `.env` files routinely carry a trailing space after `=`.
    expect(catalogRepoRoot('   ')).toBe(fallback);
  });

  it('resolves a relative value against the repository root, not the process cwd', () => {
    // The scripts run inside `packages/db`, so `./temp/catalog-repo` in the root `.env` has to mean
    // the repository's own `temp/` — the same directory the API resolves.
    expect(catalogRepoRoot('./temp/catalog-repo')).toBe(
      join(REPOSITORY_ROOT, 'temp', 'catalog-repo'),
    );
    expect(catalogRepoRoot('temp/catalog-repo')).toBe(
      join(REPOSITORY_ROOT, 'temp', 'catalog-repo'),
    );
    expect(catalogRepoRoot('./temp/catalog-repo')).toBe(
      resolve(REPOSITORY_ROOT, 'temp/catalog-repo'),
    );
  });

  it('leaves an absolute value alone, which is how a mounted checkout is named', () => {
    const mounted = join(REPOSITORY_ROOT, 'mounted', 'catalog');

    expect(isAbsolute(mounted)).toBe(true);
    expect(catalogRepoRoot(mounted)).toBe(mounted);
  });
});
