import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CatalogEntrySchema,
  EnvSchemaFileSchema,
  computeCatalogCoverage,
  type CatalogCoverageEntry,
  type CatalogEntry,
} from '@seamnex/domain';
import { catalogRepoRoot } from '../src/catalog-root';
import { REPOSITORY_ROOT } from '../src/env';

/**
 * S-1 / S-2 / AC-01 — catalogue coverage gate.
 *
 * The review's finding was that three products declared an environment while no entry document
 * existed, so the catalogue advertised products that could never deploy, and the native floor was a
 * number in a screen that nothing compared. This script reconciles the two halves of the catalogue
 * and reports the floor, so `pnpm check:catalog` answers "is the catalogue internally consistent, and
 * how many native deployments does it prove?" without a database.
 *
 * **It reads the checkout, not this repository** (ADR-BE-42 §10.5). The platform holds no catalogue
 * content any more, so the two directories come from `SEAMNEX_CATALOG_REPO_PATH` — the same root the
 * loader reads — and their absence is a failure rather than a skip, because a gate that passes
 * vacuously would let a release ship with no catalogue at all. The key set is derived from the
 * documents instead of a vendored list, so the gate asserts the pairing in both directions without
 * carrying a second copy of which products exist.
 *
 * Two verdicts, deliberately different:
 *
 *   - **structural** (always enforced): every declaration has an entry document and every entry
 *     document has a declaration, every document declares its own key and a pinned image, and no two
 *     documents declare one identity. A failure here means a product that cannot be deployed.
 *   - **floor** (reported, enforced with `--require-floor`): the native/forward-auth/sign-in split of
 *     the documented deployments against S-2's floor. It is not enforced by default because a tag is
 *     a subset of any real catalogue: asserting the platform-wide floor against it would be a claim
 *     about data the tag does not carry. `GET /posture` is the surface that measures a live platform.
 *
 * It is TypeScript because the alternative is a `.mjs` that cannot import its own authorities: the
 * shape comes from `CatalogEntrySchema`, the coverage arithmetic from `computeCatalogCoverage`, which
 * the reload receipt and `GET /posture` already call. A gate that restates the rule it checks can
 * only disagree with it.
 */

const root = catalogRepoRoot(process.env.SEAMNEX_CATALOG_REPO_PATH);
const documentsDir = join(root, 'catalog');
const declarationsDir = join(documentsDir, 'env');

const requireFloor = process.argv.includes('--require-floor');
const problems: string[] = [];
const notes: string[] = [];

const documents = readDocuments();
const declarations = readDeclarations();
const coverage = reconcile();

report(coverage);

if (problems.length > 0) {
  console.error(
    `Catalog coverage check failed (${documents.length} documents, ${declarations.size} declarations in ${root}):`,
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  for (const note of notes) console.log(`  ${note}`);
  console.log(
    `Catalog coverage check passed (${documents.length} documents, ${declarations.size} declarations in ${root}).`,
  );
}

type Document = {
  readonly name: string;
  readonly path: string;
  /** `null` when the file does not parse as the served contract; the problem is already recorded. */
  readonly document: CatalogEntry | null;
};

function readDocuments(): Document[] {
  if (!existsSync(documentsDir)) {
    problems.push(
      `${relative(documentsDir)}: no catalogue checkout. The platform holds no catalogue content; ` +
        'fetch a tag with `pnpm catalog:sync --ref <tag>`, or place a checkout at SEAMNEX_CATALOG_REPO_PATH.',
    );
    return [];
  }
  const found: Document[] = [];
  for (const name of readdirSync(documentsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()) {
    const path = join(documentsDir, name);
    const parsed = readJson(path);
    if (parsed === null) continue;
    /*
     * The schema the loader serves, not a lighter check: a document this gate accepted but the API
     * refused would be projected as a row and then omitted by every catalogue screen. Reporting every
     * issue rather than the first is what makes one run enough to fix a file.
     */
    const validated = CatalogEntrySchema.safeParse(parsed);
    if (!validated.success) {
      problems.push(`${relative(path)}: ${issueText(validated.error.issues)}`);
      found.push({ name, path, document: null });
      continue;
    }
    validateDocument(path, validated.data);
    found.push({ name, path, document: validated.data });
  }
  return found;
}

function readDeclarations(): Map<string, string> {
  const declared = new Map<string, string>();
  if (!existsSync(declarationsDir)) {
    problems.push(`${relative(declarationsDir)}: the checkout declares no environment.`);
    return declared;
  }
  for (const name of readdirSync(declarationsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()) {
    const path = join(declarationsDir, name);
    const parsed = readJson(path);
    if (parsed === null) continue;
    const entryKey = typeof parsed.entryKey === 'string' ? parsed.entryKey : null;
    if (entryKey === null) {
      problems.push(`${relative(path)}: declares no entryKey, so it attaches to no entry.`);
      continue;
    }
    if (entryKey !== stemOf(name)) {
      problems.push(
        `${relative(path)}: declares entryKey "${entryKey}" but is named "${stemOf(name)}.json"; the loader refuses the mismatch.`,
      );
    }
    // Every declaration in the checkout is one the projector applies, so every one is held to the
    // schema the projector parses rather than to a presence check.
    const validated = EnvSchemaFileSchema.safeParse(parsed);
    if (!validated.success) {
      problems.push(`${relative(path)}: ${issueText(validated.error.issues)}`);
    }
    declared.set(entryKey, path);
  }
  return declared;
}

/** The reconciliation that makes a declaration without an entry document a failure, not a note. */
function reconcile() {
  const byKey = new Map<string, Document>();
  for (const entry of documents) {
    if (entry.document === null) continue;
    const key = entry.document.key;
    if (key !== stemOf(entry.name)) {
      problems.push(
        `${relative(entry.path)}: declares "${key}" but is named "${stemOf(entry.name)}.json"; the loader trusts the field.`,
      );
    }
    if (byKey.has(key)) {
      problems.push(`${relative(entry.path)}: a second document declares ${key}.`);
      continue;
    }
    byKey.set(key, entry);
  }

  /*
   * Both directions. A document without a declaration deploys with no variables, and a declaration
   * without a document can never be projected — the two findings this gate exists for, now derived
   * from the tag rather than from a list kept here.
   */
  for (const [key, entry] of byKey) {
    if (!declarations.has(key)) {
      problems.push(
        `${relative(entry.path)}: ${key} declares no environment at ${relative(declarationsDir)}/${key}.json; the product would deploy with no variables.`,
      );
    }
  }

  const refused: { key: string; reason: string }[] = [];
  for (const [key, path] of declarations) {
    if (!byKey.has(key)) {
      const reason = `${relative(path)}: ${key} declares an environment with no entry document; the declaration can never be projected.`;
      problems.push(reason);
      refused.push({ key, reason });
    }
  }

  const entries: CatalogCoverageEntry[] = [];
  for (const entry of byKey.values()) {
    const document = entry.document;
    if (document === null) continue;
    entries.push({
      key: document.key,
      guaranteeClass: document.guaranteeClass,
      primaryInstanceId: document.primaryInstanceId,
    });
  }

  return computeCatalogCoverage({
    entries,
    declaredEnvironments: declarations.size,
    refused,
  });
}

/**
 * The checks the schema cannot state, because they are policy rather than shape.
 *
 * Everything else the gate used to assert on its own — `guaranteeClass` in the enum, a known
 * `packaging`, a `domain`, a nullable `primaryInstanceId`, a non-empty `imageRef` — is refused by
 * `CatalogEntrySchema` above, with the same verdict and a better message. Only the pinning rule is
 * left: FR-1.5's pair is the pin, and the schema accepts any string for either half.
 */
function validateDocument(path: string, document: CatalogEntry): void {
  const where = relative(path);
  const tag = tagOf(document.imageRef);
  if (tag === null) {
    problems.push(`${where}: imageRef "${document.imageRef}" carries no version tag.`);
  } else if (tag === 'latest') {
    problems.push(`${where}: imageRef "${document.imageRef}" is a floating tag; pin the version.`);
  }
  if (!document.imageDigest.startsWith('sha256:')) {
    problems.push(`${where}: imageDigest is not a sha256 digest.`);
  }
}

function report(coverage: ReturnType<typeof computeCatalogCoverage>): void {
  const forwardAuth = coverage.byClass.fa_header + coverage.byClass.fa_delegated;
  console.log(
    `Catalog coverage: ${coverage.entries} documents, ${coverage.deployments} deployments ` +
      `(native ${coverage.nativeDeployments}, forward-auth ${forwardAuth}, sign-in required ${coverage.byClass.fa_gate})`,
  );
  console.log(
    `  class histogram: native ${coverage.byClass.native}, fa_header ${coverage.byClass.fa_header}, ` +
      `fa_delegated ${coverage.byClass.fa_delegated}, fa_gate ${coverage.byClass.fa_gate}`,
  );
  console.log(
    `  floor: ${coverage.floor} of ${coverage.baseline} native deployments required - ` +
      (coverage.floorMet ? 'met by the documented set' : `short by ${coverage.shortfall}`),
  );

  if (!coverage.floorMet) {
    const message =
      `the documented set proves ${coverage.nativeDeployments} native deployments, ${coverage.shortfall} short of the floor of ` +
      `${coverage.floor}. This gate sees one checkout only; GET /posture measures a live platform ` +
      'and serves the floor in force, including any recorded owner decision.';
    if (requireFloor) problems.push(message);
    else notes.push(`note: ${message} (run with --require-floor to fail on it)`);
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push(`${relative(path)}: not a JSON object.`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    problems.push(`${relative(path)}: ${messageOf(error)}`);
    return null;
  }
}

function stemOf(name: string): string {
  return name.replace(/\.json$/, '');
}

/** The tag of `registry/namespace/name:tag`, or `null` when the reference carries none. */
function tagOf(reference: string): string | null {
  const withoutDigest = reference.split('@')[0] ?? '';
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  if (colon <= slash) return null;
  const tag = withoutDigest.slice(colon + 1);
  return tag.length === 0 ? null : tag;
}

function issueText(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '(document)'}: ${issue.message}`)
    .join('; ');
}

/** A repository-relative path when it is one; the absolute path otherwise (a mounted root). */
function relative(path: string): string {
  if (!path.startsWith(REPOSITORY_ROOT)) return path;
  return path.slice(REPOSITORY_ROOT.length).replace(/^[\\/]/, '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
