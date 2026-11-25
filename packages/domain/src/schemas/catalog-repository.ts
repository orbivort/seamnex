import { z } from 'zod';
import { TimestampSchema } from './common';
import { CatalogReloadResultSchema } from './catalog';

/**
 * The catalogue tree the platform is serving, and the fetch that produced it (ADR-BE-42 §10.3).
 *
 * Two reads are modelled here rather than one: `GET /catalog/repository` answers "what am I serving
 * and is it intact", which the console cannot derive from a reload receipt — a receipt describes the
 * projection, not the checkout it came from, and it says nothing about whether a swap was
 * interrupted. `POST /catalog/sync` answers "what did the fetch do", and it is the reload receipt
 * plus the provenance of the tree that receipt describes.
 */

/**
 * The configured source, never a request field.
 *
 * `host` carries the host and path (`github.com/org/repo`) and never the scheme or any credentials:
 * a support screenshot of this screen must not leak a token, and a URL with an embedded credential
 * is refused before a fetch anyway.
 */
export const CatalogRepositorySourceSchema = z.object({
  /** False when `SEAMNEX_CATALOG_SOURCE_URL` is unset — the air-gapped configuration (AC-22). */
  configured: z.boolean(),
  host: z.string().min(1).nullable(),
  /** The configured default ref an operator may accept or override per run. */
  ref: z.string().min(1).nullable(),
});

/** The last commit a fetch recorded. `null` means this tree was never fetched through the platform. */
export const CatalogRepositoryCommitSchema = z.object({
  sha: z.string().min(1),
  actor: z.string().min(1),
  message: z.string().min(1),
  recordedAt: TimestampSchema,
});

/**
 * A swap that stopped between renames.
 *
 * `pending` names the children still holding their previous content, in the order the swap would
 * have applied them. It is not a warning: a mixed tree is new entries against old source trees until
 * the next successful sync at the same ref repairs it (ADR-BE-42 §10.2 rule 8).
 */
export const CatalogStagedSchema = z.object({
  pending: z.array(z.string().min(1)),
});

export const CatalogRepositoryViewSchema = z.object({
  /** The label the loader would produce now; `null` when no tree is present. */
  revision: z.string().min(1).nullable(),
  source: CatalogRepositorySourceSchema,
  commit: CatalogRepositoryCommitSchema.nullable(),
  staged: CatalogStagedSchema.nullable(),
});

/**
 * A fetch request carries a ref and nothing else.
 *
 * No URL field exists on purpose: the source is configuration, so the control plane never fetches a
 * host a request named (ADR-BE-42 §10.2 rule 1).
 */
export const CatalogSyncRequestSchema = z.object({
  ref: z.string().trim().min(1).max(255).optional(),
});

export const CatalogSyncResultSchema = CatalogReloadResultSchema.extend({
  source: z.object({
    /** Sanitised origin and path; the value the allow-list check accepted. */
    url: z.string().min(1),
    /** The ref that was requested, which may be the configured default. */
    ref: z.string().min(1),
    commit: z.string().min(1),
  }),
  staged: CatalogStagedSchema,
});

export type CatalogRepositorySource = z.infer<typeof CatalogRepositorySourceSchema>;
export type CatalogRepositoryCommit = z.infer<typeof CatalogRepositoryCommitSchema>;
export type CatalogStaged = z.infer<typeof CatalogStagedSchema>;
export type CatalogRepositoryView = z.infer<typeof CatalogRepositoryViewSchema>;
export type CatalogSyncRequest = z.infer<typeof CatalogSyncRequestSchema>;
export type CatalogSyncResult = z.infer<typeof CatalogSyncResultSchema>;
