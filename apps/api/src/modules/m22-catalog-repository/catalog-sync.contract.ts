import type { CatalogRepositoryView } from '@seamnex/domain';

export const CATALOG_SYNC = Symbol('seamnex.m22.catalog-sync');

/**
 * What one fetch proved. The reload receipt is added by the handler, not here.
 *
 * `url` is the sanitised form (`host/path`, no scheme, never a credential) so the value can be shown
 * on a screen and written into an audit row without a second redaction step.
 */
export type CatalogSyncOutcome = {
  readonly url: string;
  /** The ref the caller asked for, or the configured default. */
  readonly ref: string;
  readonly commit: string;
  /** Non-null only when the swap stopped between renames; names the children still holding old content. */
  readonly staged: { readonly pending: readonly string[] } | null;
};

/**
 * ADR-BE-42 §10.2 — the eight rules this service exists to keep.
 *
 *   1. The source URL is configuration, never a request field.
 *   2. The clone is staged inside the root and only children are swapped; the root is a bind mount.
 *   3. `assertAllowedSourceUrl` gates the fetch: https, allow-listed host, no credentials.
 *   4. `cloneAtRevision` — shallow, size-bounded by the shallow depth, and time-bounded.
 *   5. The ref is a tag or a commit, never a branch.
 *   6. Both the requested ref and the resolved commit are returned.
 *   7. One writer: an advisory lock plus a per-actor cooldown.
 *   8. The swap is not atomic, and the marker says what is still pending.
 *
 * The consequence of rule 8 is deliberately visible in the contract rather than hidden behind a
 * boolean: a caller that receives `staged` must report it, not retry silently.
 */
export interface CatalogSyncService {
  /** The checkout the platform is serving, without projecting anything. */
  read(): Promise<CatalogRepositoryView>;
  /** Fetch, validate and swap. The caller reloads afterwards; this never writes the projection. */
  sync(input: { readonly ref?: string; readonly actorId: string }): Promise<CatalogSyncOutcome>;
}
