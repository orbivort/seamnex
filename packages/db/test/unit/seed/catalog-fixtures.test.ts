import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogEntrySchema, EnvSchemaFileSchema } from '@seamnex/domain';
import {
  DEFAULT_CATALOG_FIXTURES,
  DEFAULT_PRODUCT_KEYS,
  SHIPPED_DECLARATIONS,
} from '../../../src/seed/default-catalog';

/**
 * The vendored default set is checked-in data that a seed writes to a working tree, so it is held to
 * the contract the loader serves: a fixture that stopped parsing would be written by `pnpm db:seed`,
 * projected as a row, and then omitted by every catalogue screen when the API re-parsed it — a
 * failure that only shows up on a fresh stack.
 *
 * The files are reached through the constants the seed plans with, not through a `../../..` of this
 * file's own: a second path would keep passing after the directory moved, which is the one thing this
 * test exists to notice.
 */

/**
 * `DEFAULT_PRODUCT_KEYS`, not a copy of it.
 *
 * The copy this replaces said a derived list would keep passing if a key were dropped from both. That
 * is true and it is not a defect in the test: dropping a key from the constant and the tree is how a
 * product leaves the default set, and "the set may not shrink silently" is `pnpm check:catalog`'s
 * verdict — it reports the count a lint cannot infer from a list. What the copy could not do is fail
 * when a key was *added* to the constant and the tree but not to the test, leaving that product
 * outside the contract check entirely.
 */
const PRODUCTS: readonly string[] = [...DEFAULT_PRODUCT_KEYS];

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('development default catalog', () => {
  it.each(PRODUCTS)('%s is a complete catalog entry', (key) => {
    const parsed = CatalogEntrySchema.safeParse(
      read(join(DEFAULT_CATALOG_FIXTURES, `${key}.json`)),
    );

    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    if (!parsed.success) return;
    expect(parsed.data.key).toBe(key);
    // The seed creates no instances, so a primary-instance reference would be a link to nothing.
    // The deployment that creates one writes it into the document.
    expect(parsed.data.primaryInstanceId).toBeNull();
    expect(parsed.data.packaging).toBe('compose');
  });

  it.each(PRODUCTS)('%s ships an environment declaration the seed can copy', (key) => {
    const parsed = EnvSchemaFileSchema.safeParse(read(join(SHIPPED_DECLARATIONS, `${key}.json`)));

    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    if (!parsed.success) return;
    // The seed writes this file under the same name, and the loader refuses a stem mismatch.
    expect(parsed.data.entryKey).toBe(key);
    expect(parsed.data.variables.length).toBeGreaterThan(0);
  });

  it('holds exactly the documents the default set claims', () => {
    // The reverse direction of the list above: a document in the directory that no key names would be
    // checked in, reviewed and then seeded into nobody's catalogue.
    const shipped = readdirSync(DEFAULT_CATALOG_FIXTURES)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();

    expect(shipped).toEqual([...PRODUCTS].sort());
  });

  it('keeps the six products in different domains', () => {
    const domains = PRODUCTS.map((key) => {
      const parsed = CatalogEntrySchema.safeParse(
        read(join(DEFAULT_CATALOG_FIXTURES, `${key}.json`)),
      );
      return parsed.success ? parsed.data.domain : `unparseable:${key}`;
    });

    expect(new Set(domains).size).toBe(PRODUCTS.length);
  });
});
