import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CATALOG_FIXTURES,
  DEFAULT_PRODUCT_KEYS,
  applyDefaultCatalogPlan,
  catalogRepoRoot,
  parseCatalogDocument,
  planDefaultCatalog,
  projectionColumns,
  requireCompleteDefaultSet,
  type DefaultCatalogPlan,
} from '../../../src/seed/default-catalog';

/**
 * The default set is a decision about a *directory*, so it is tested on a directory: what would be
 * written, what is deliberately not written, and what happens when the tree disagrees with the
 * fixtures. Document validity is the contract package's business and is asserted in
 * `catalog-fixtures.test.ts`.
 */

const trees: string[] = [];

function tree(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seamnex-default-catalog-'));
  trees.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of trees.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A declarations directory holding `keys`, with `entryKey` equal to the file stem. */
function declarations(keys: readonly string[], entryKey?: (key: string) => string): string {
  const directory = join(tree(), 'declarations');
  mkdirSync(directory, { recursive: true });
  for (const key of keys) {
    writeFileSync(
      join(directory, `${key}.json`),
      JSON.stringify({
        format: 'env-schema/v1',
        entryKey: entryKey?.(key) ?? key,
        variables: [{ name: 'SEEDED', type: 'string', required: false }],
      }),
      'utf8',
    );
  }
  return directory;
}

function writeTree(root: string, files: Record<string, unknown>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, 'catalog', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(content), 'utf8');
  }
}

// `resolveKey` — the identity comparison this module relies on — is the contract package's, and its
// mapping table is asserted in `packages/domain/test/unit/entry-key.test.ts`. Duplicating it here
// would be the second source of truth this module exists to avoid.

describe('catalogRepoRoot', () => {
  it('resolves the documented default to the repository temp directory', () => {
    const root = catalogRepoRoot('./temp/catalog-repo');
    expect(root.endsWith(join('temp', 'catalog-repo'))).toBe(true);
    expect(resolve(root)).toBe(root);
  });

  it('uses an absolute path verbatim, and keeps the default when nothing is configured', () => {
    expect(catalogRepoRoot('/var/lib/seamnex/catalog-repo')).toBe('/var/lib/seamnex/catalog-repo');
    expect(catalogRepoRoot(undefined).endsWith(join('temp', 'catalog-repo'))).toBe(true);
    expect(catalogRepoRoot('   ').endsWith(join('temp', 'catalog-repo'))).toBe(true);
  });
});

describe('planDefaultCatalog', () => {
  it('plans one document and one declaration per default product', () => {
    const root = tree();
    const plan = planDefaultCatalog({ root, declarations: declarations(DEFAULT_PRODUCT_KEYS) });

    expect(plan.entries.map((entry) => entry.key)).toEqual([...DEFAULT_PRODUCT_KEYS]);
    expect(plan.entries.map((entry) => entry.path)).toEqual(
      DEFAULT_PRODUCT_KEYS.map((key) => join(root, 'catalog', `${key}.json`)),
    );
    expect(plan.environments.map((entry) => entry.key)).toEqual([...DEFAULT_PRODUCT_KEYS]);
    // A document this run writes is also a row this run projects.
    expect(plan.projections.map((entry) => entry.key)).toEqual([...DEFAULT_PRODUCT_KEYS]);
    expect(plan.declarationsPresent).toBe(0);
    expect(plan.skipped).toEqual([]);
    // The plan writes nothing: the decision is inspectable before the tree changes.
    expect(existsSync(join(root, 'catalog'))).toBe(false);
  });

  it('skips a product the tree already declares under the other spelling', () => {
    const root = tree();
    writeTree(root, { 'D01-01.json': { key: 'D01-01' } });

    const plan = planDefaultCatalog({ root, declarations: declarations(DEFAULT_PRODUCT_KEYS) });

    expect(plan.entries.map((entry) => entry.key)).toEqual(['D07-01', 'D09-01']);
    // The declaration is still planned: the *entry* exists (the tree declares it), so the file the
    // loader validates against is there, and the projector has something to apply. Stopping at the
    // entry skip was how a tree-owned product silently ended up with no environment schema.
    expect(plan.environments.map((entry) => entry.key)).toEqual(['D01-01', 'D07-01', 'D09-01']);
    expect(plan.skipped[0]).toEqual({
      scope: 'entry',
      key: 'D01-01',
      blocking: false,
      reason: 'already declared by catalog/D01-01.json',
    });
  });

  it("treats a declaration the tree omits for its own entry as the tree owner's business", () => {
    const root = tree();
    // An operator-prepared tree: the entry document is there, the declaration is not. The seed must
    // not fail on somebody else's repository, and must not invent a declaration either.
    writeTree(root, { 'D01-01.json': { key: 'D01-01' } });

    const plan = planDefaultCatalog({ root, declarations: declarations(['D07-01', 'D09-01']) });

    expect(plan.entries.map((entry) => entry.key)).toEqual(['D07-01', 'D09-01']);
    expect(plan.environments.map((entry) => entry.key)).toEqual(['D07-01', 'D09-01']);
    expect(plan.skipped).toEqual([
      {
        scope: 'entry',
        key: 'D01-01',
        blocking: false,
        reason: 'already declared by catalog/D01-01.json',
      },
      {
        scope: 'environment',
        key: 'D01-01',
        blocking: false,
        reason: expect.stringContaining('no shipped declaration at'),
      },
    ]);
    expect(plan.skipped.some((skip) => skip.blocking)).toBe(false);
  });

  it('projects a document the tree already declares, without writing it again', () => {
    const root = tree();
    // The state a database reset leaves behind: the working tree survived, the projection did not.
    // Deriving rows from the writes made this tree project zero entries and refuse every declaration.
    const fixture = readFileSync(join(DEFAULT_CATALOG_FIXTURES, 'D01-01.json'), 'utf8');
    mkdirSync(join(root, 'catalog'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'D01-01.json'), fixture, 'utf8');

    const plan = planDefaultCatalog({ root, declarations: declarations(DEFAULT_PRODUCT_KEYS) });

    expect(plan.entries.map((entry) => entry.key)).toEqual(['D07-01', 'D09-01']);
    expect(plan.projections.map((entry) => entry.key)).toEqual([...DEFAULT_PRODUCT_KEYS]);
    // The row is built from the tree's own bytes, so the columns and the revision hash match a reload.
    expect(plan.projections[0]).toEqual({
      key: 'D01-01',
      path: join(root, 'catalog', 'D01-01.json'),
      text: fixture,
    });
  });

  it('does not project a tree document the served contract refuses', () => {
    const root = tree();
    writeTree(root, { 'D01-01.json': { key: 'D01-01' } });

    const plan = planDefaultCatalog({ root, declarations: declarations(DEFAULT_PRODUCT_KEYS) });

    // The loader reports it in `invalid[]` and the projector stops on that list, naming the file;
    // a row built from a document no schema accepted would be a projection of nothing.
    expect(plan.projections.map((entry) => entry.key)).toEqual(['D07-01', 'D09-01']);
  });

  it('skips a product the tree already declares under its own name', () => {
    const root = tree();
    writeTree(root, { 'D07-01.json': { key: 'D07-01' } });

    const plan = planDefaultCatalog({ root, declarations: declarations(DEFAULT_PRODUCT_KEYS) });

    expect(plan.entries.map((entry) => entry.key)).toEqual(['D01-01', 'D09-01']);
    expect(plan.skipped.map((skip) => skip.key)).toEqual(['D07-01']);
  });

  it('skips an environment file that is already declared', () => {
    const root = tree();
    writeTree(root, { 'env/D01-01.json': { entryKey: 'D01-01' } });

    const plan = planDefaultCatalog({ root, declarations: declarations(DEFAULT_PRODUCT_KEYS) });

    expect(plan.environments.map((entry) => entry.key)).toEqual(['D07-01', 'D09-01']);
    // The projector's half is already on disk, so the log line about the next step must still fire.
    expect(plan.declarationsPresent).toBe(1);
    expect(plan.skipped).toEqual([
      {
        scope: 'environment',
        key: 'D01-01',
        blocking: false,
        reason: 'already declared by catalog/env/D01-01.json',
      },
    ]);
  });

  it('still plans the entry when the shipped declaration is missing, and marks it blocking', () => {
    const root = tree();
    const plan = planDefaultCatalog({
      root,
      declarations: declarations(['D01-01', 'D09-01']),
    });

    expect(plan.entries).toHaveLength(3);
    expect(plan.environments.map((entry) => entry.key)).toEqual(['D01-01', 'D09-01']);
    // The seed was going to supply this product, so a declaration it cannot find is this build's
    // gap: `requireCompleteDefaultSet` refuses the plan rather than seeding an entry with no schema.
    expect(plan.skipped).toEqual([
      {
        scope: 'environment',
        key: 'D07-01',
        blocking: true,
        reason: expect.stringContaining('no shipped declaration at'),
      },
    ]);
  });

  it('skips a product whose vendored document is not in the checkout', () => {
    const root = tree();
    const fixtures = join(tree(), 'fixtures');
    mkdirSync(fixtures, { recursive: true });
    for (const key of DEFAULT_PRODUCT_KEYS.filter((key) => key !== 'D01-01')) {
      writeFileSync(
        join(fixtures, `${key}.json`),
        readFileSync(join(DEFAULT_CATALOG_FIXTURES, `${key}.json`), 'utf8'),
        'utf8',
      );
    }

    const plan = planDefaultCatalog({
      root,
      fixtures,
      declarations: declarations(DEFAULT_PRODUCT_KEYS),
    });

    // A product with no vendored document is not invented: nothing is written for it, and the
    // reason names the path an operator has to restore.
    expect(plan.entries.map((entry) => entry.key)).toEqual(['D07-01', 'D09-01']);
    expect(plan.skipped[0]).toEqual({
      scope: 'entry',
      key: 'D01-01',
      blocking: true,
      reason: expect.stringContaining('no vendored document at'),
    });
  });

  it('ignores a declaration whose identity is not a string', () => {
    const root = tree();
    writeTree(root, { 'D01-01.json': { key: 42 } });

    const plan = planDefaultCatalog({ root, declarations: declarations(DEFAULT_PRODUCT_KEYS) });

    // The loader reports this file as invalid and keeps it; it cannot claim an identity, so it
    // cannot block the default either.
    expect(plan.entries.map((entry) => entry.key)).toContain('D01-01');
    expect(plan.skipped).toEqual([]);
  });

  it('refuses a declaration whose entryKey disagrees with its filename', () => {
    const root = tree();
    const malformed = declarations(DEFAULT_PRODUCT_KEYS, (key) =>
      key === 'D09-01' ? 'D09-02' : key,
    );

    expect(() => planDefaultCatalog({ root, declarations: malformed })).toThrow(
      'declares entryKey "D09-02", expected "D09-01"',
    );
  });

  it('refuses a fixture that declares a different key than its filename', () => {
    const root = tree();
    const fixtures = join(tree(), 'fixtures');
    mkdirSync(fixtures, { recursive: true });
    // A *valid* entry under the wrong name: the schema cannot catch this one, and the loader trusts
    // the field, so this is the only place the mismatch is visible before it is projected.
    const entry = JSON.parse(
      readFileSync(join(DEFAULT_CATALOG_FIXTURES, 'D01-01.json'), 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      join(fixtures, 'D01-01.json'),
      JSON.stringify({ ...entry, key: 'D01-02' }),
      'utf8',
    );

    expect(() => planDefaultCatalog({ root, fixtures })).toThrow('declares "D01-02", not "D01-01"');
  });
});

describe('requireCompleteDefaultSet', () => {
  const plan = (skipped: DefaultCatalogPlan['skipped']): DefaultCatalogPlan => ({
    root: '/tmp/catalog-repo',
    entries: [],
    environments: [],
    projections: [],
    declarationsPresent: 0,
    skipped: [...skipped],
  });

  it("accepts a plan whose only skips are somebody else's artefacts", () => {
    expect(() =>
      requireCompleteDefaultSet(
        plan([
          { scope: 'entry', key: 'D01-01', blocking: false, reason: 'already declared by …' },
          { scope: 'environment', key: 'D01-01', blocking: false, reason: 'already declared by …' },
        ]),
      ),
    ).not.toThrow();
  });

  it('accepts a complete plan', () => {
    expect(() => requireCompleteDefaultSet(plan([]))).not.toThrow();
  });

  it('refuses the plan, naming every gap, when a blocking artefact is missing', () => {
    // The failure this replaces was a warning: the seed exited 0, `pnpm dev` started, and the console
    // reported "0 variables" for a product that declares thirty.
    expect(() =>
      requireCompleteDefaultSet(
        plan([
          {
            scope: 'environment',
            key: 'D07-01',
            blocking: true,
            reason: 'no shipped declaration at /x/platform/catalog/env/D07-01.json',
          },
          { scope: 'entry', key: 'D09-01', blocking: false, reason: 'already declared by …' },
        ]),
      ),
    ).toThrow(/incomplete, so nothing was written: environment D07-01 — no shipped declaration at/);
  });
});

describe('applyDefaultCatalogPlan', () => {
  it('creates the catalog tree and writes both artefact kinds', () => {
    const root = tree();
    const plan = planDefaultCatalog({ root, declarations: declarations(DEFAULT_PRODUCT_KEYS) });

    const written = applyDefaultCatalogPlan(plan);

    expect(written).toHaveLength(6);
    expect(existsSync(join(root, 'catalog', 'D01-01.json'))).toBe(true);
    expect(existsSync(join(root, 'catalog', 'env', 'D01-01.json'))).toBe(true);
    // What lands on disk is the fixture, byte for byte: a reload hashes these files.
    expect(JSON.parse(readFileSync(join(root, 'catalog', 'D01-01.json'), 'utf8')).key).toBe(
      'D01-01',
    );
  });

  it('never replaces a file that appeared after the plan was made', () => {
    const root = tree();
    const plan = planDefaultCatalog({ root, declarations: declarations(DEFAULT_PRODUCT_KEYS) });
    const target = join(root, 'catalog', 'D01-01.json');
    mkdirSync(join(root, 'catalog'), { recursive: true });
    writeFileSync(target, '{"key":"D01-01","edited":true}', 'utf8');

    const written = applyDefaultCatalogPlan(plan);

    expect(written).not.toContain(target);
    expect(readFileSync(target, 'utf8')).toContain('edited');
    // The declaration half of the same product is still written.
    expect(existsSync(join(root, 'catalog', 'env', 'D01-01.json'))).toBe(true);
  });

  it('propagates a write failure that is not a collision', () => {
    const root = tree();
    mkdirSync(join(root, 'catalog'), { recursive: true });
    // Only `EEXIST` is the local edit this function is meant to tolerate. A name the filesystem
    // cannot create is a different failure and must reach the caller rather than look like "the
    // operator already has this file".
    const plan: DefaultCatalogPlan = {
      root,
      entries: [
        {
          key: 'D01-01',
          path: join(root, 'catalog', `${'x'.repeat(300)}.json`),
          text: '{}',
        },
      ],
      environments: [],
      projections: [],
      declarationsPresent: 0,
      skipped: [],
    };

    expect(() => applyDefaultCatalogPlan(plan)).toThrow();
  });

  it('is idempotent: a second run against the same tree writes nothing', () => {
    const root = tree();
    const declared = declarations(DEFAULT_PRODUCT_KEYS);
    applyDefaultCatalogPlan(planDefaultCatalog({ root, declarations: declared }));

    const again = planDefaultCatalog({ root, declarations: declared });

    expect(again.entries).toEqual([]);
    expect(again.environments).toEqual([]);
    expect(applyDefaultCatalogPlan(again)).toEqual([]);
    // A warm tree writes nothing and still owes the projection every row: that is the whole point
    // of keeping the write list and the projection list apart.
    expect(again.projections.map((entry) => entry.key)).toEqual([...DEFAULT_PRODUCT_KEYS]);
  });
});

describe('parseCatalogDocument', () => {
  it('reads the columns of a document that satisfies the served contract', () => {
    const document = parseCatalogDocument(
      readFileSync(join(DEFAULT_CATALOG_FIXTURES, 'D01-01.json'), 'utf8'),
      'D01-01.json',
    );

    expect(projectionColumns(document)).toEqual({
      key: 'D01-01',
      domain: 'CRM & Sales Pipeline',
      product: 'EspoCRM',
      cluster: 'Revenue & Customer',
      packaging: 'compose',
      guaranteeClass: 'native',
      repoUrl: 'https://github.com/espocrm/espocrm',
      licenseId: 'AGPL-3.0',
    });
  });

  it('rejects an incomplete document and names the file', () => {
    // The seed writes what this function returns, so the only acceptable failure is a loud one: a
    // lighter check here would write a file the API re-parses and omits — visible only on a fresh
    // stack, as a catalogue screen that silently lacks a product.
    expect(() => parseCatalogDocument('{"key":"D01-01"}', 'fixture.json')).toThrow(
      'fixture.json is not a catalog entry:',
    );
  });

  it('refuses a file that is not a JSON object', () => {
    expect(() => parseCatalogDocument('[]', 'empty.json')).toThrow('is not a JSON object');
    expect(() => parseCatalogDocument('{', 'broken.json')).toThrow('is not valid JSON');
  });
});
