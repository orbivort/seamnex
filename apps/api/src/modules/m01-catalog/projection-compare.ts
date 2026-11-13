import type { CatalogEntry } from '@seamnex/domain';

/** The stored side of a reload comparison: revision hash, document and overlay columns. */
export type StoredProjection = {
  contentHash: string;
  document: Record<string, unknown>;
  columns: {
    domain: string;
    product: string;
    cluster: string | null;
    packaging: CatalogEntry['packaging'];
    guaranteeClass: CatalogEntry['guaranteeClass'];
    repoUrl: string | null;
    licenseId: string | null;
  };
};

/**
 * JSON with object keys in a stable order.
 *
 * `jsonb` does not preserve key order, so a byte comparison of the stored payload against the parsed
 * file would report every entry as changed on every reload. Sorting both sides makes the comparison
 * about content instead of about serialisation.
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, canonical(source[key])]),
  );
}

/**
 * Does the stored row still say what the repository says?
 *
 * Both halves matter: the document is what the screens render (image digest, review dates, operation
 * inventory) and the columns are what `project()` overlays on top of it (domain, product, cluster,
 * packaging, guarantee class). Either one being stale is a stale entry — and a stale entry tells the
 * deploy wizard to pull an image digest that does not exist.
 *
 * A revision hash alone cannot answer this: `catalog_entry` can be rewritten without appending a
 * revision (`pnpm db:seed` does it on every run), after which "the hash matches" is true and the row
 * is still wrong.
 */
export function sameProjection(stored: StoredProjection, document: CatalogEntry): boolean {
  if (JSON.stringify(canonical(stored.document)) !== JSON.stringify(canonical(document)))
    return false;
  return (
    stored.columns.domain === document.domain &&
    stored.columns.product === document.product &&
    // `cluster` may be NULL on a row written before the column was populated; `project()` falls back
    // to the document there, so the null form is not drift.
    (stored.columns.cluster === null || stored.columns.cluster === document.cluster) &&
    stored.columns.packaging === document.packaging &&
    stored.columns.guaranteeClass === document.guaranteeClass &&
    stored.columns.repoUrl === document.repoUrl &&
    stored.columns.licenseId === document.licenseId
  );
}

/**
 * FR-2.14: "verified values supersede catalog assumptions".
 *
 * A reload re-projects the repository document. That document describes what the *upstream project*
 * claims; it cannot know what an operator verified against the running product. Overwriting the
 * review block on every reload made a verification last only until the next commit to the
 * repository: `verifiedAt` was reset, `nextReviewAt` recomputed from it, `stale` cleared and a
 * corrected `credentialGranularity` reverted — which silently restored write eligibility for a
 * product an operator had just declared write-ineligible.
 *
 * Only the verified block is carried forward. Everything else (image digest, operation inventory,
 * event modes, upstream versions) still comes from the repository, because those are the facts the
 * repository owns and a reload exists to pick them up.
 */
export function preserveVerifiedFacts(
  document: CatalogEntry,
  stored: Record<string, unknown>,
): CatalogEntry {
  const previous = (stored as { integration?: Partial<CatalogEntry['integration']> }).integration;
  // No verification yet: the repository document is the only record there is.
  if (previous === undefined || typeof previous.verifiedAt !== 'string') return document;

  const integration: CatalogEntry['integration'] = {
    ...document.integration,
    credentialGranularity:
      previous.credentialGranularity ?? document.integration.credentialGranularity,
    ...(previous.sessionMaxMinutes === undefined || previous.sessionMaxMinutes === null
      ? {}
      : { sessionMaxMinutes: previous.sessionMaxMinutes }),
    verifiedBy: previous.verifiedBy ?? document.integration.verifiedBy,
    verifiedAt: previous.verifiedAt,
    nextReviewAt: previous.nextReviewAt ?? document.integration.nextReviewAt,
    // Recomputed from the clock, never inherited: a stored `stale: true` must not outlive the review.
    stale: false,
  };
  return { ...document, integration };
}
