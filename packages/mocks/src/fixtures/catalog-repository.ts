import type { CatalogRepositoryView } from '@seamnex/domain';
import { at, daysAgo } from './context';

/**
 * The catalogue checkout the mock platform serves (ADR-BE-42).
 *
 * It is state rather than a literal in the handler because the console has two faces to show and a
 * test has to be able to reach both: a source that is configured (the action is offered) and one
 * that is not (the air-gapped install, AC-22). `staged` is part of that state for the same reason —
 * a mixed tree is a reported condition, and a mock that could never produce one would leave the
 * banner untested.
 */
export const CATALOG_SYNC_TAGS = ['catalog-2026.11.0'] as const;

export const CATALOG_REPOSITORY: CatalogRepositoryView = {
  revision: 'c47a1e0d9b7f2c53a1e8d4b6f0a2c9e7d5b3f1a8',
  source: {
    configured: true,
    host: 'github.com/orbivort/seamnex-catalog',
    ref: 'catalog-2026.11.0',
  },
  commit: {
    sha: 'c47a1e0d9b7f2c53a1e8d4b6f0a2c9e7d5b3f1a8',
    actor: 'marta.nowak',
    message: 'catalog sync catalog-2026.11.0 at c47a1e0d9b7f2c53a1e8d4b6f0a2c9e7d5b3f1a8',
    recordedAt: daysAgo(3),
  },
  staged: null,
};

/** The commit a successful mock sync reports; distinct from the seeded one so a sync is visible. */
export const CATALOG_SYNC_COMMIT = {
  sha: 'b20f7a91c3d84e6f5a0b9c2d1e8f7a6b4c3d2e10',
  recordedAt: at(0),
} as const;
