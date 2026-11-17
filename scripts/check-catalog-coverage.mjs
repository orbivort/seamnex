#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S-1 / S-2 / AC-01 - catalogue coverage gate.
 *
 * The review's finding was that three products declared an environment while no entry document
 * existed, so the catalogue advertised products that could never deploy, and the native floor was a
 * number in a screen that nothing compared. This script reconciles the two halves of the default set
 * and reports the floor, so `pnpm check:catalog` answers "is the catalogue internally consistent, and
 * how many native deployments does it prove?" without a database.
 *
 * Two verdicts, deliberately different:
 *
 *   - **structural** (always enforced): every declaration has an entry document, every default entry
 *     has a declaration, every document declares its own key and a pinned image, and the default key
 *     list matches the files on disk. A failure here means a product that cannot be deployed.
 *   - **floor** (reported, enforced with `--require-floor`): the native/forward-auth/sign-in split of
 *     the documented deployments against S-2's floor. It is not enforced by default because this
 *     repository holds the *default set*, which is a subset of any real catalogue: asserting the
 *     platform-wide floor against six documents would be a claim about data the repository does not
 *     carry. `GET /posture` is the surface that measures a live platform.
 *
 * The floor and baseline are copies of `NATIVE_FLOOR_DEPLOYMENTS` / `NATIVE_BASELINE_DEPLOYMENTS` in
 * `packages/domain/src/posture.ts`. A `.mjs` cannot import TypeScript, so the numbers are restated
 * here and the drift is caught by `packages/domain` tests asserting the same values.
 */

const FLOOR_DEPLOYMENTS = 6;
const BASELINE_DEPLOYMENTS = 12;
const GUARANTEE_CLASSES = ['native', 'fa_header', 'fa_delegated', 'fa_gate'];

const root = fileURLToPath(new URL('..', import.meta.url));
const documentsDir = join(root, 'packages', 'db', 'src', 'seed', 'default-catalog');
const declarationsDir = join(root, 'platform', 'catalog', 'env');
const seedSource = join(root, 'packages', 'db', 'src', 'seed', 'default-catalog.ts');

const requireFloor = process.argv.includes('--require-floor');
const problems = [];
const notes = [];

const keys = defaultProductKeys();
const documents = readDocuments();
const declarations = readDeclarations();

if (keys === null) {
  problems.push(
    `${relative(seedSource)}: DEFAULT_PRODUCT_KEYS could not be read; the gate cannot tell which products the default set claims.`,
  );
} else {
  reconcile(keys);
}

const coverage = summarise(documents);
report(coverage);

if (problems.length > 0) {
  console.error(
    `Catalog coverage check failed (${documents.length} documents, ${declarations.size} declarations):`,
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  for (const note of notes) console.log(`  ${note}`);
  console.log(
    `Catalog coverage check passed (${documents.length} documents, ${declarations.size} declarations).`,
  );
}

/** `DEFAULT_PRODUCT_KEYS` from the seed module, or `null` when the const has moved. */
function defaultProductKeys() {
  if (!existsSync(seedSource)) return null;
  const text = readFileSync(seedSource, 'utf8');
  const block = /DEFAULT_PRODUCT_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(text);
  if (block === null) return null;
  const keys = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return keys.length === 0 ? null : keys;
}

function readDocuments() {
  if (!existsSync(documentsDir)) {
    problems.push(`${relative(documentsDir)}: the vendored default set is missing.`);
    return [];
  }
  const documents = [];
  for (const name of readdirSync(documentsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()) {
    const path = join(documentsDir, name);
    const parsed = readJson(path);
    if (parsed === null) continue;
    documents.push({ name, path, document: parsed });
  }
  return documents;
}

function readDeclarations() {
  const declared = new Map();
  if (!existsSync(declarationsDir)) {
    problems.push(`${relative(declarationsDir)}: the shipped declarations are missing.`);
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
    declared.set(entryKey, path);
  }
  return declared;
}

/** The reconciliation that makes a declaration without an entry document a failure rather than a note. */
function reconcile(keyList) {
  const byKey = new Map();
  for (const entry of documents) {
    const key = typeof entry.document.key === 'string' ? entry.document.key : null;
    if (key === null) {
      problems.push(`${relative(entry.path)}: declares no key.`);
      continue;
    }
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

  const claimed = new Set(keyList);
  for (const key of keyList) {
    const entry = byKey.get(key);
    if (entry === undefined) {
      problems.push(
        `DEFAULT_PRODUCT_KEYS names ${key} but no document exists at ${relative(documentsDir)}/${key}.json.`,
      );
    } else {
      validateDocument(key, entry);
    }
    if (!declarations.has(key)) {
      problems.push(
        `DEFAULT_PRODUCT_KEYS names ${key} but ${relative(declarationsDir)}/${key}.json declares no environment; the product would deploy with no variables.`,
      );
    }
  }

  for (const entry of documents) {
    const key = typeof entry.document.key === 'string' ? entry.document.key : null;
    if (key !== null && !claimed.has(key)) {
      problems.push(
        `${relative(entry.path)}: ${key} is documented but absent from DEFAULT_PRODUCT_KEYS.`,
      );
    }
  }
  for (const [key, path] of declarations) {
    if (!byKey.has(key)) {
      problems.push(
        `${relative(path)}: ${key} declares an environment with no entry document; the declaration can never be projected.`,
      );
    }
  }
}

function validateDocument(key, entry) {
  const document = entry.document;
  const where = relative(entry.path);
  if (!GUARANTEE_CLASSES.includes(document.guaranteeClass)) {
    problems.push(
      `${where}: guaranteeClass "${String(document.guaranteeClass)}" is not one of ${GUARANTEE_CLASSES.join(', ')}.`,
    );
  }
  if (typeof document.packaging !== 'string' || document.packaging.length === 0) {
    problems.push(`${where}: packaging is missing, so nothing can decide how to deploy it.`);
  }
  /*
   * FR-1.5: the pair is the pin. `imageRef` carries the explicit version tag an operator reads and
   * `imageDigest` carries the immutable identity the platform deploys; a floating `latest` with no
   * digest is what lets a redeploy change the product underneath a running instance.
   */
  const tag = tagOf(document.imageRef);
  if (tag === null) {
    problems.push(`${where}: imageRef "${String(document.imageRef)}" carries no version tag.`);
  } else if (tag === 'latest') {
    problems.push(`${where}: imageRef "${document.imageRef}" is a floating tag; pin the version.`);
  }
  if (typeof document.imageDigest !== 'string' || !document.imageDigest.startsWith('sha256:')) {
    problems.push(`${where}: imageDigest is not a sha256 digest.`);
  }
  if (
    document.primaryInstanceId !== null &&
    document.primaryInstanceId !== undefined &&
    typeof document.primaryInstanceId !== 'string'
  ) {
    problems.push(`${where}: primaryInstanceId must be a string or null.`);
  }
  if (key.startsWith('D') && document.domain === undefined) {
    problems.push(`${where}: domain is missing.`);
  }
}

/** Deployments, not entries: two entries sharing a `primaryInstanceId` are one deployment (S-2). */
function summarise(list) {
  const deployments = new Map();
  for (const entry of list) {
    const key = typeof entry.document.key === 'string' ? entry.document.key : entry.name;
    const primary =
      typeof entry.document.primaryInstanceId === 'string'
        ? entry.document.primaryInstanceId
        : null;
    const deployment = primary ?? `entry:${key}`;
    if (!deployments.has(deployment)) {
      deployments.set(deployment, entry.document.guaranteeClass);
    }
  }

  const byClass = { native: 0, fa_header: 0, fa_delegated: 0, fa_gate: 0 };
  for (const guaranteeClass of deployments.values()) {
    if (guaranteeClass in byClass) byClass[guaranteeClass] += 1;
  }
  const native = byClass.native;
  return {
    documents: list.length,
    deployments: deployments.size,
    byClass,
    native,
    forwardAuth: byClass.fa_header + byClass.fa_delegated,
    signInRequired: byClass.fa_gate,
    floor: FLOOR_DEPLOYMENTS,
    baseline: BASELINE_DEPLOYMENTS,
    met: native >= FLOOR_DEPLOYMENTS,
    shortfall: Math.max(0, FLOOR_DEPLOYMENTS - native),
  };
}

function report(coverage) {
  console.log(
    `Catalog coverage: ${coverage.documents} documents, ${coverage.deployments} deployments ` +
      `(native ${coverage.native}, forward-auth ${coverage.forwardAuth}, sign-in required ${coverage.signInRequired})`,
  );
  console.log(
    `  class histogram: native ${coverage.byClass.native}, fa_header ${coverage.byClass.fa_header}, ` +
      `fa_delegated ${coverage.byClass.fa_delegated}, fa_gate ${coverage.byClass.fa_gate}`,
  );
  console.log(
    `  floor: ${coverage.floor} of ${coverage.baseline} native deployments required - ` +
      (coverage.met ? 'met by the documented set' : `short by ${coverage.shortfall}`),
  );

  if (!coverage.met) {
    const message =
      `the documented set proves ${coverage.native} native deployments, ${coverage.shortfall} short of the floor of ` +
      `${coverage.floor}. This gate sees the repository's default set only; GET /posture measures a live platform ` +
      'and serves the floor in force, including any recorded owner decision.';
    if (requireFloor) problems.push(message);
    else notes.push(`note: ${message} (run with --require-floor to fail on it)`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${relative(path)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function stemOf(name) {
  return name.replace(/\.json$/, '');
}

/** The tag of `registry/namespace/name:tag`, or `null` when the reference carries none. */
function tagOf(reference) {
  if (typeof reference !== 'string') return null;
  const withoutDigest = reference.split('@')[0];
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  if (colon <= slash) return null;
  const tag = withoutDigest.slice(colon + 1);
  return tag.length === 0 ? null : tag;
}

function relative(path) {
  return path.slice(root.length).replace(/^[\\/]/, '');
}
