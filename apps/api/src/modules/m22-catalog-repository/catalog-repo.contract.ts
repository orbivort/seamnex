import type { CatalogEntry, EnvSchemaFile, ReloadInvalidArtefact } from '@seamnex/domain';

export const CATALOG_REPOSITORY = Symbol('seamnex.m22.catalog-repository');

/**
 * Everything one read of the working tree proved.
 *
 * `invalid` is part of the contract rather than a log line: a file that exists but failed validation
 * is **not** a deleted file, and the reload must be able to tell the two apart before it removes a
 * projection. Collecting the reason here and swallowing it at the call site is what made a typo in
 * `catalog/D1.json` read as "the operator deleted D1".
 */
export type CatalogWorkingTree = {
  /** `git rev-parse HEAD`, or a content hash when the path is not a repository. */
  readonly revision: string;
  readonly documents: readonly CatalogEntry[];
  /** `catalog/env/<KEY>.json`, validated and grouped by the key they declare. */
  readonly envSchemas: readonly EnvSchemaFile[];
  readonly invalid: readonly ReloadInvalidArtefact[];
};

/**
 * ADR-BE-08 / ADR-BE-09 D5. The repository is authoritative; this adapter is the only code that
 * reads the working tree. Phase 2 loads and validates; Phase 4A commits.
 */
export interface CatalogRepositoryService {
  load(): Promise<CatalogWorkingTree>;
  /** Records that the projected hash and the repository hash diverged (ADR-BE-08 point 4). */
  recordDrift(entryKey: string, expectedHash: string | null, observedHash: string): Promise<void>;
  /**
   * Records a commit the platform itself made into the working tree — a confirmed scaffold draft.
   *
   * `catalog_commit` is owned here. M02 used to `INSERT INTO catalog_commit` directly, which the
   * boundary test could not see: it only knows "this module may name this table", so a foreign
   * write and a legitimate read looked identical.
   */
  recordCommit(input: {
    readonly sha: string;
    readonly kind: string;
    readonly actor: string;
    readonly message: string;
  }): Promise<void>;
}
