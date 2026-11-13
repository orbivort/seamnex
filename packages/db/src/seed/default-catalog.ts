import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CatalogEntrySchema, resolveKey, type CatalogEntry } from '@seamnex/domain';

/**
 * The catalogue a virgin development stack starts with.
 *
 * Three facts decide this module's shape, and each one is a constraint the platform already enforces
 * elsewhere:
 *
 *   1. **The working tree is the authority, the database is a projection.** So the defaults are
 *      written as `catalog/<KEY>.json` + `catalog/env/<KEY>.json` into `SEAMNEX_CATALOG_REPO_PATH`
 *      *first*, and only then projected. A later `POST /catalog/reload` re-reads the same files and
 *      finds them unchanged instead of treating the projection as deleted.
 *   2. **The seed runs against a stack nobody has configured yet.** The default set is therefore
 *      applied only when `catalog_entry` is empty. An operator's own catalogue is never touched,
 *      merged into, or topped up: "default" means "nothing has been chosen", not "something is
 *      missing".
 *   3. **Identity is the key, and two spellings name one product.** ADR-BE-20 maps `D1` to `D01-01`,
 *      so a tree that already declares either form blocks the other. Without that check this module
 *      would add a second document for a product that is already declared, and the loader resolves
 *      duplicate identities last-file-wins — a silent replacement, not an addition.
 *
 * **The entry documents are vendored here, under `packages/db/src/seed/default-catalog/`.** They are
 * deliberately *not* copied into `platform/catalog/`: that directory is the shipped mirror of an
 * operator's catalogue (`platform/catalog/env/<KEY>.json` declarations, `platform/upstream/<KEY>/`
 * source trees), the API never reads it, and entry documents there would turn it into a catalog root
 * whose first reload projects three entries as if they were the whole catalogue and deletes the
 * rest. The seed owns what the seed starts; `platform/` stays what the operator ships.
 *
 * The env *declarations* are read from `platform/catalog/env/<KEY>.json` rather than duplicated
 * here, because they already live there as reviewed, tested artefacts. One owner per artefact.
 */

/** Repository root from `packages/db/src/seed`; the same four levels `../env.ts` uses from `src`. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** The vendored entry documents, one per member of the default set. */
export const DEFAULT_CATALOG_FIXTURES = join(import.meta.dirname, 'default-catalog');

/**
 * The default set, in the order the console renders it.
 *
 * Selection is explicit rather than derived from the tree: these are the three products whose source
 * is vendored (`platform/upstream/<KEY>/`) *and* whose environment is declared
 * (`platform/catalog/env/<KEY>.json`), so a virgin stack can catalog, configure and deploy all three
 * without a network. `planDefaultCatalog` refuses to guess: a missing fixture or declaration is
 * reported per product, never silently substituted from somewhere else.
 */
export const DEFAULT_PRODUCT_KEYS = ['D01-01', 'D07-01', 'D09-01'] as const;

export type DefaultProductKey = (typeof DEFAULT_PRODUCT_KEYS)[number];

/** Where the catalogue working tree lives for this process. */
export const SHIPPED_DECLARATIONS = join(REPO_ROOT, 'platform', 'catalog', 'env');

export type DefaultCatalogWrite = {
  readonly key: string;
  readonly path: string;
  readonly text: string;
};

/**
 * One entry document that must exist as a `catalog_entry` row.
 *
 * Deliberately not the same list as `DefaultCatalogWrite`: "which files must this run create?" and
 * "which rows must the projection hold?" are different questions. A tree that already carries
 * `catalog/D01-01.json` needs no write and still needs the row — deriving the second from the first
 * is how a reset database met an intact tree, inserted nothing, reported success, and left the
 * projector refusing every declaration against an entry nobody had projected.
 */
export type DefaultCatalogProjection = {
  readonly key: string;
  /** The file the text came from: the write this run made, or the document already in the tree. */
  readonly path: string;
  readonly text: string;
};

export type DefaultCatalogSkip = {
  /** `entry` is `catalog/<KEY>.json`; `environment` is `catalog/env/<KEY>.json`. */
  readonly scope: 'entry' | 'environment';
  readonly key: string;
  /**
   * `true` when the *default set itself* is incomplete, and `pnpm db:seed` must therefore fail rather
   * than report success.
   *
   * The distinction is the difference between "somebody else owns this" and "this build is missing a
   * file": a product the tree already declares is not the seed's business (`false`), while a vendored
   * document or a shipped declaration the default set needs but the checkout lacks is a broken build
   * (`true`). Reporting the second as a warning is what let a seeded stack show "0 variables" on
   * every catalogue screen while the seed log said it had succeeded.
   */
  readonly blocking: boolean;
  readonly reason: string;
};

export type DefaultCatalogPlan = {
  readonly root: string;
  readonly entries: readonly DefaultCatalogWrite[];
  readonly environments: readonly DefaultCatalogWrite[];
  /**
   * Every default entry the tree declares, whether this run wrote the file or found it already
   * there. This is what the seed projects; `entries` is only what it writes.
   */
  readonly projections: readonly DefaultCatalogProjection[];
  /** Declarations the tree already holds — the half the projector applies, for the log line. */
  readonly declarationsPresent: number;
  readonly skipped: readonly DefaultCatalogSkip[];
};

/**
 * `SEAMNEX_CATALOG_REPO_PATH`, resolved.
 *
 * A relative value is resolved against the repository root, not against `process.cwd()`: pnpm starts
 * this script inside `packages/db`, and `./temp/catalog-repo` in the root `.env` means the
 * repository's own `temp/`. The API resolves it the same way (`loadConfig`), which is what keeps the
 * seed and the loader looking at one directory instead of two.
 */
export function catalogRepoRoot(configured: string | undefined): string {
  const value = (configured ?? '').trim();
  if (value.length === 0) return join(REPO_ROOT, 'temp', 'catalog-repo');
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}

/**
 * What the seed would write, without writing it.
 *
 * Split from `applyDefaultCatalogPlan` so the decision ("is this product already declared?") is
 * testable on a temporary directory and reviewable in one place.
 */
export function planDefaultCatalog(input: {
  readonly root: string;
  readonly fixtures?: string;
  readonly declarations?: string;
}): DefaultCatalogPlan {
  const fixtures = input.fixtures ?? DEFAULT_CATALOG_FIXTURES;
  const declarations = input.declarations ?? SHIPPED_DECLARATIONS;
  const catalogDir = join(input.root, 'catalog');
  const envDir = join(catalogDir, 'env');

  // No conflict can take down the plan: a file the loader would reject cannot declare an identity,
  // so it is ignored here for the same reason it is ignored there.
  const declaredEntries = declaredIdentities(catalogDir, 'key');
  const declaredEnvironments = declaredIdentities(envDir, 'entryKey');

  const entries: DefaultCatalogWrite[] = [];
  const environments: DefaultCatalogWrite[] = [];
  const projections: DefaultCatalogProjection[] = [];
  const skipped: DefaultCatalogSkip[] = [];

  for (const key of DEFAULT_PRODUCT_KEYS) {
    const identity = resolveKey(key);
    const entryOwner = declaredEntries.get(identity);

    /*
     * The two halves are decided independently, and the entry only gates the environment on
     * *existence*, not on authorship. The previous shape stopped at the first entry skip, so a tree
     * that already declared `catalog/D01-01.json` never got `catalog/env/D01-01.json` either — the
     * declaration was silently absent and the projector had nothing to apply.
     */
    let entryAvailable = entryOwner !== undefined;
    if (entryOwner !== undefined) {
      skipped.push({
        scope: 'entry',
        key,
        blocking: false,
        reason: `already declared by catalog/${entryOwner}`,
      });
      /*
       * A document this run does not write is still an entry the projection must hold. Deriving the
       * projection from the writes is what turned a reset database plus an intact tree into an empty
       * `catalog_entry` and a projector refusing every declaration.
       */
      const documentPath = join(catalogDir, entryOwner);
      try {
        const text = readFileSync(documentPath, 'utf8');
        parseCatalogDocument(text, documentPath);
        projections.push({ key, path: documentPath, text });
      } catch {
        // A document the served contract refuses declares no row: the loader reports it through
        // `invalid[]` and the projector stops on that list, naming the file. Inventing a row here
        // would project a document no schema accepted.
      }
    } else {
      const fixture = join(fixtures, `${key}.json`);
      if (!existsSync(fixture)) {
        skipped.push({
          scope: 'entry',
          key,
          blocking: true,
          reason: `no vendored document at ${fixture}`,
        });
      } else {
        const text = readFileSync(fixture, 'utf8');
        const document = parseCatalogDocument(text, fixture);
        if (document.key !== key) {
          throw new Error(
            `${fixture} declares "${document.key}", not "${key}": the loader trusts the field, so this ` +
              'would project one identity from a file named for another.',
          );
        }
        const documentPath = join(catalogDir, `${key}.json`);
        entries.push({ key, path: documentPath, text });
        projections.push({ key, path: documentPath, text });
        entryAvailable = true;
      }
    }

    const envOwner = declaredEnvironments.get(identity);
    if (envOwner !== undefined) {
      skipped.push({
        scope: 'environment',
        key,
        blocking: false,
        reason: `already declared by catalog/env/${envOwner}`,
      });
      continue;
    }

    if (!entryAvailable) {
      // A declaration without its entry document is an artefact the loader refuses with "no catalog
      // entry … is projected". The missing entry above is already blocking; this is the explanation,
      // not a second failure.
      skipped.push({
        scope: 'environment',
        key,
        blocking: false,
        reason: `no entry document for ${key} to attach the declaration to`,
      });
      continue;
    }

    const declaration = join(declarations, `${key}.json`);
    if (!existsSync(declaration)) {
      /*
       * Blocking only when the seed was going to supply this product's entry itself. A tree the
       * operator prepared may legitimately declare entries without environment declarations, and
       * failing the seed for that would be a verdict on somebody else's repository.
       */
      skipped.push({
        scope: 'environment',
        key,
        blocking: entryOwner === undefined,
        reason: `no shipped declaration at ${declaration}`,
      });
      continue;
    }
    const envText = readFileSync(declaration, 'utf8');
    const envDocument = readJsonObject(envText, declaration);
    // The loader refuses a file whose `entryKey` disagrees with its stem, so a mismatch here would
    // write an artefact that is invalid on arrival — better to fail while the cause is still visible.
    if (envDocument.entryKey !== key) {
      throw new Error(
        `${declaration} declares entryKey "${String(envDocument.entryKey)}", expected "${key}".`,
      );
    }
    environments.push({ key, path: join(envDir, `${key}.json`), text: envText });
  }

  return {
    root: input.root,
    entries,
    environments,
    projections,
    declarationsPresent: declaredEnvironments.size,
    skipped,
  };
}

/**
 * Refuses a plan the seed must not act on.
 *
 * `planDefaultCatalog` tolerates a gap so the gap is *inspectable* — a caller can print what is
 * missing and decide. `pnpm db:seed` is not such a caller: it runs at startup, its exit code is the
 * only thing `scripts/dev.mjs` reads, and a warning it ignored once let a stack come up with every
 * catalogue screen reporting "0 variables" for a product that declares thirty. Throwing here is what
 * turns that into a failed startup instead of a wrong one.
 */
export function requireCompleteDefaultSet(plan: DefaultCatalogPlan): void {
  const incomplete = plan.skipped.filter((skip) => skip.blocking);
  if (incomplete.length === 0) return;

  throw new Error(
    `the default catalog is incomplete, so nothing was written: ${incomplete
      .map((skip) => `${skip.scope} ${skip.key} — ${skip.reason}`)
      .join('; ')}.`,
  );
}

/**
 * Writes the plan, never replacing anything.
 *
 * `flag: 'wx'` rather than an `existsSync` check: an editor, a reload or a second seed can create the
 * file between the check and the write, and the working tree is operator-owned state. A file that
 * appears in that window is kept, which is the only outcome that cannot destroy a local edit.
 *
 * The directory is created on the way (`catalog/` itself included): its absence is the documented
 * "no catalogue" state, and the seed's job is to leave it present and valid.
 */
export function applyDefaultCatalogPlan(plan: DefaultCatalogPlan): string[] {
  const written: string[] = [];
  for (const write of [...plan.entries, ...plan.environments]) {
    mkdirSync(dirname(write.path), { recursive: true });
    try {
      writeFileSync(write.path, write.text, { encoding: 'utf8', flag: 'wx' });
      written.push(write.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return written;
}

/**
 * Parses one entry document with the schema the loader serves.
 *
 * The same `CatalogEntrySchema`, not a lighter check: a fixture that only *this* module accepted
 * would be written to the tree, projected as a row, and then omitted by every catalogue screen when
 * the API re-parsed it — a failure that only shows up on a fresh stack. Naming the file is the one
 * thing the loader cannot do, because it reports the path in `invalid[]` rather than throwing.
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

/** Content hash of a file as written, recorded as the revision the projection came from. */
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

/** Every identity a directory declares, mapped to the file that declared it. */
function declaredIdentities(directory: string, field: string): Map<string, string> {
  const declared = new Map<string, string>();
  if (!existsSync(directory)) return declared;

  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    try {
      const document = readJsonObject(readFileSync(join(directory, name), 'utf8'), name);
      const value = document[field];
      if (typeof value === 'string') declared.set(resolveKey(value), name);
    } catch {
      // A malformed or unreadable file declares nothing: the loader reports it as invalid and the
      // invalid list protects its key from removal, so it must not block a default either.
    }
  }
  return declared;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
