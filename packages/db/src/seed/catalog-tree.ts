import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogEntrySchema, type CatalogEntry } from '@seamnex/domain';

/**
 * The catalogue checkout, read as a projection source (ADR-BE-42 §9.3).
 *
 * `pnpm db:seed` used to *write* the catalogue: six entry documents and six declarations vendored in
 * this repository, copied into `SEAMNEX_CATALOG_REPO_PATH` on a virgin stack. That made the platform
 * an author of deployable product content. It is now a projector over whatever checkout is there,
 * and this module is the whole of its decision-making — pure, so the three outcomes an operator can
 * meet are unit-testable without a database:
 *
 *   - **absent** — no `catalog/` at all. Skip with exit 0 and a sentence naming the acquisition step,
 *     because a fresh host with no network is a supported state and a failed seed would stop `dev`.
 *   - **empty** — `catalog/` exists but yields no parseable document. Fail: a checkout that declares
 *     nothing is either the wrong tag or a broken transfer, and projecting nothing looks identical to
 *     a database nobody seeded.
 *   - **documents** — project the parseable ones and report the rest per file. One unreadable
 *     document must not discard the five beside it, and must not be silently skipped either.
 */

export type TreeDocument = {
  readonly key: string;
  readonly path: string;
  readonly text: string;
};

export type TreeProjection =
  | { readonly kind: 'absent'; readonly root: string }
  | {
      readonly kind: 'empty';
      readonly root: string;
      /** The files that were there and could not be used, so the failure can name them. */
      readonly paths: readonly string[];
      readonly declarations: number;
    }
  | {
      readonly kind: 'documents';
      readonly root: string;
      readonly documents: readonly TreeDocument[];
      readonly invalid: readonly { readonly path: string; readonly reason: string }[];
      /** `catalog/env/*.json` present: `applySchemas` owns them, so this is only for the log line. */
      readonly declarations: number;
    };

/**
 * What the tree declares, without writing anything.
 *
 * The revision label is not computed here: the seed records a per-file `content-…` hash, and the API
 * reports the checkout's real `git rev-parse HEAD`. Inventing a third label would be a second answer
 * to "which revision is this" that no command could reconcile.
 */
export function planTreeProjection(input: { readonly root: string }): TreeProjection {
  const catalogDir = join(input.root, 'catalog');
  if (!existsSync(catalogDir)) return { kind: 'absent', root: input.root };

  const declarations = countDeclarations(join(catalogDir, 'env'));
  const names = readdirSync(catalogDir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  const documents: TreeDocument[] = [];
  const invalid: { path: string; reason: string }[] = [];

  for (const name of names) {
    const path = join(catalogDir, name);
    try {
      const text = readFileSync(path, 'utf8');
      documents.push({ key: parseCatalogDocument(text, path).key, path, text });
    } catch (error) {
      invalid.push({ path, reason: messageOf(error) });
    }
  }

  if (documents.length === 0) {
    return {
      kind: 'empty',
      root: input.root,
      paths: names.map((name) => join(catalogDir, name)),
      declarations,
    };
  }
  return { kind: 'documents', root: input.root, documents, invalid, declarations };
}

/**
 * Refuses a tree that exists and declares nothing.
 *
 * `planTreeProjection` tolerates it so a caller can print the files and decide; the seed is not such
 * a caller. Its exit code is the only thing `scripts/dev.mjs` reads, and a seed that exited `0` over
 * an unreadable checkout is how a stack came up serving zero products.
 */
export function requireProjectableTree(
  projection: TreeProjection,
): asserts projection is Extract<TreeProjection, { kind: 'documents' }> {
  if (projection.kind !== 'empty') return;
  throw new Error(
    `${projection.root}/catalog declares no readable entry document` +
      (projection.paths.length === 0
        ? ' (the directory is empty).'
        : `: ${projection.paths.join(', ')}.`) +
      ' Nothing was projected. Check the tag the checkout was fetched from, then run `pnpm catalog:sync --ref <tag>`.',
  );
}

function countDeclarations(directory: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((name) => name.endsWith('.json')).length;
}

/**
 * Parses one entry document with the schema the loader serves.
 *
 * The same `CatalogEntrySchema`, not a lighter check: a document only this module accepted would be
 * projected as a row and then omitted by every catalogue screen when the API re-read it. Naming the
 * file is the one thing the loader cannot do, because it reports the path in `invalid[]` rather than
 * throwing.
 */
export function parseCatalogDocument(text: string, source: string): CatalogEntry {
  const parsed = CatalogEntrySchema.safeParse(readJsonObject(text, source));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(document)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${source} is not a catalog entry: ${issues}`);
  }
  return parsed.data;
}

/** The columns the projection stores beside the document (M01's `reload` writes the same set). */
export type CatalogEntryColumns = {
  readonly key: string;
  readonly domain: string;
  readonly product: string;
  readonly cluster: string | null;
  readonly packaging: string;
  readonly guaranteeClass: string;
  readonly repoUrl: string | null;
  readonly licenseId: string | null;
};

/**
 * The columns of a validated document.
 *
 * No shape checks: `CatalogEntry` has already been through `CatalogEntrySchema`, so this is a
 * projection, not a second validation. Every value here is what `reload` would have written.
 */
export function projectionColumns(document: CatalogEntry): CatalogEntryColumns {
  return {
    key: document.key,
    domain: document.domain,
    product: document.product,
    cluster: document.cluster,
    packaging: document.packaging,
    guaranteeClass: document.guaranteeClass,
    repoUrl: document.repoUrl,
    licenseId: document.licenseId,
  };
}

/** Content hash of a file as read, recorded as the revision the projection came from. */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function readJsonObject(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${messageOf(error)}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
