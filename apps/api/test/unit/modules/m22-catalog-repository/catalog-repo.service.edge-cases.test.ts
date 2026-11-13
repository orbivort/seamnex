import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { WorkingTreeCatalogRepository } from '../../../../src/modules/m22-catalog-repository/catalog-repo.service';

/**
 * A document that is valid JSON but not an object at all — `null`, a list, a bare string. The schema
 * refusal then carries no field path, and the reload report must still say something a human can act
 * on: `"<root> ..."` names the document itself rather than printing an empty path.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): WorkingTreeCatalogRepository {
  const root = mkdtempSync(join(tmpdir(), 'seamnex-catalog-'));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return new WorkingTreeCatalogRepository(
    { SEAMNEX_CATALOG_REPO_PATH: root } as unknown as AppConfig,
    fakeDb().pool,
  );
}

describe('revision', () => {
  it('hashes environment schemas in entry-key order, whatever the reading order was', async () => {
    // The sort comparator is the whole point of the copy: `readdirSync` is lexical by filename, and
    // the revision must not depend on it, or two checkouts of the same tree disagree.
    const schema = (entryKey: string) =>
      JSON.stringify({ format: 'env-schema/v1', entryKey, variables: [] });
    const forward = tree({
      'catalog/D01-01.json': JSON.stringify({}),
      'catalog/env/D01-01.json': schema('D01-01'),
      'catalog/env/D02-01.json': schema('D02-01'),
    });
    const reverse = tree({
      'catalog/D01-01.json': JSON.stringify({}),
      'catalog/env/D02-01.json': schema('D02-01'),
      'catalog/env/D01-01.json': schema('D01-01'),
    });

    const first = await forward.load();
    const second = await reverse.load();

    expect(first.envSchemas.map((entry) => entry.entryKey)).toEqual(['D01-01', 'D02-01']);
    expect(first.revision).toMatch(/^content-[0-9a-f]{16}$/);
    expect(second.revision).toBe(first.revision);
  });
});

describe('load', () => {
  it.each(['null', '[]', '"espocrm"'])(
    'names the document itself when %s fails at the root',
    async (content) => {
      const repo = tree({ 'catalog/D01-01.json': content });

      const working = await repo.load();

      expect(working.documents).toEqual([]);
      expect(working.invalid).toEqual([
        {
          path: 'catalog/D01-01.json',
          scope: 'entry',
          key: 'D01-01',
          reason: expect.stringContaining('<root>'),
        },
      ]);
    },
  );
});
