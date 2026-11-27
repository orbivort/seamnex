import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogEntrySchema } from '@seamnex/domain';
import { planTreeProjection, requireProjectableTree } from '../../../src/seed/catalog-tree';
import { sampleEntry, writeCheckout } from './sample-entry';

/**
 * ADR-BE-42 §9.3 — the seed projects a checkout and writes no file.
 *
 * The three outcomes are the whole contract: an absent checkout must not fail a boot (AC-7), a
 * checkout that declares nothing must fail loudly (AC-8), and one unreadable document must not
 * discard the readable ones beside it (AC-10). Each case is a temporary directory, so nothing here
 * depends on a database or on the repository's own `temp/`.
 */
const trees: string[] = [];

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'seamnex-catalog-tree-'));
  trees.push(root);
  return root;
}

afterEach(() => {
  for (const root of trees.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('planTreeProjection', () => {
  it('reports an absent checkout without throwing', () => {
    const root = tree();

    const projection = planTreeProjection({ root });

    expect(projection.kind).toBe('absent');
    expect(readdirSync(root)).toEqual([]);
  });

  it('projects the documents a checkout declares and counts its declarations', () => {
    const root = tree();
    writeCheckout(root, ['D01-01', 'D02-01']);

    const projection = planTreeProjection({ root });

    expect(projection.kind).toBe('documents');
    if (projection.kind !== 'documents') return;
    expect(projection.documents.map((document) => document.key).sort()).toEqual([
      'D01-01',
      'D02-01',
    ]);
    expect(projection.invalid).toEqual([]);
    expect(projection.declarations).toBe(2);
  });

  it('refuses per file and still projects its neighbours', () => {
    const root = tree();
    writeCheckout(root, ['D01-01']);
    const catalogDir = join(root, 'catalog');
    writeFileSync(join(catalogDir, 'D02-01.json'), '{ not json', 'utf8');

    const projection = planTreeProjection({ root });

    expect(projection.kind).toBe('documents');
    if (projection.kind !== 'documents') return;
    expect(projection.documents.map((document) => document.key)).toEqual(['D01-01']);
    expect(projection.invalid).toHaveLength(1);
    expect(projection.invalid[0]?.path.endsWith('D02-01.json')).toBe(true);
    expect(projection.invalid[0]?.reason).toMatch(/not valid JSON/);
  });

  it('treats a directory with no document as empty rather than as a projection', () => {
    const root = tree();
    mkdirSync(join(root, 'catalog'), { recursive: true });

    const projection = planTreeProjection({ root });

    expect(projection.kind).toBe('empty');
    if (projection.kind !== 'empty') return;
    expect(projection.paths).toEqual([]);
    // A tag with no `env/` is not an error for this module: it projects what it has and says so.
    expect(projection.declarations).toBe(0);
  });

  it('reports a document that is not a JSON object and one the schema refuses', () => {
    const root = tree();
    writeCheckout(root, ['D01-01']);
    const catalogDir = join(root, 'catalog');
    writeFileSync(join(catalogDir, 'D02-01.json'), '[]', 'utf8');
    writeFileSync(join(catalogDir, 'D02-02.json'), 'null', 'utf8');
    writeFileSync(join(catalogDir, 'D03-01.json'), JSON.stringify({ key: 'D03-01' }), 'utf8');

    const projection = planTreeProjection({ root });

    expect(projection.kind).toBe('documents');
    if (projection.kind !== 'documents') return;
    expect(projection.documents.map((document) => document.key)).toEqual(['D01-01']);
    // Three distinct refusals, each naming its file: the reason is what tells an operator whether to
    // fix the tag or the transfer.
    expect(projection.invalid).toHaveLength(3);
    expect(projection.invalid.map((item) => item.reason).join(' ')).toMatch(/not a JSON object/);
    expect(projection.invalid.map((item) => item.reason).join(' ')).toMatch(/not a catalog entry/);
  });

  it('treats a directory of unreadable documents as empty and names them', () => {
    const root = tree();
    mkdirSync(join(root, 'catalog'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'notes.txt'), 'ignored', 'utf8');
    writeFileSync(join(root, 'catalog', 'D09-01.json'), '{}', 'utf8');

    const projection = planTreeProjection({ root });

    expect(projection.kind).toBe('empty');
    if (projection.kind !== 'empty') return;
    expect(projection.paths).toEqual([join(root, 'catalog', 'D09-01.json')]);
  });
});

describe('requireProjectableTree', () => {
  it('passes a checkout that declares documents through', () => {
    const root = tree();
    writeCheckout(root, ['D01-01']);

    expect(() => requireProjectableTree(planTreeProjection({ root }))).not.toThrow();
  });

  it('passes an absent checkout: it is the caller that decides to skip', () => {
    expect(() => requireProjectableTree(planTreeProjection({ root: tree() }))).not.toThrow();
  });

  it('names an empty directory as empty, and still names the acquisition step', () => {
    const root = tree();
    mkdirSync(join(root, 'catalog'), { recursive: true });

    expect(() => requireProjectableTree(planTreeProjection({ root }))).toThrow(
      /directory is empty.*pnpm catalog:sync/s,
    );
  });

  it('names the files and the acquisition step when nothing parses', () => {
    const root = tree();
    mkdirSync(join(root, 'catalog'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'D09-01.json'), '{}', 'utf8');

    // Path separators are platform-specific, so the assertion names the file and the remedy only.
    expect(() => requireProjectableTree(planTreeProjection({ root }))).toThrow(
      /D09-01\.json.*pnpm catalog:sync/s,
    );
  });
});

/**
 * The fixture builder is test data, so it is checked against the served schema here rather than
 * trusted: a helper that drifted from `CatalogEntrySchema` would make every test below pass while
 * proving nothing about a real document.
 */
describe('sample fixture', () => {
  it('is a complete catalog entry the loader would accept', () => {
    const parsed = CatalogEntrySchema.safeParse(sampleEntry('D01-01'));

    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });
});
