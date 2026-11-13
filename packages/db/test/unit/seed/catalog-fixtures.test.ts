import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CatalogEntrySchema, EnvSchemaFileSchema } from '@seamnex/domain';

/**
 * The vendored default set is checked-in data that a seed writes to a working tree, so it is held to
 * the contract the loader serves: a fixture that stopped parsing would be written by `pnpm db:seed`,
 * projected as a row, and then omitted by every catalogue screen when the API re-parsed it — a
 * failure that only shows up on a fresh stack.
 *
 * The declarations are read from `platform/catalog/env/` exactly as the seed reads them, because a
 * copy is what the seed writes: validating anything else would prove nothing about the artefact that
 * lands in `catalog/env/`.
 */

const PRODUCTS = ['D01-01', 'D07-01', 'D09-01'];

function read(relative: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));
}

describe('development default catalog', () => {
  it.each(PRODUCTS)('%s is a complete catalog entry', (key) => {
    const parsed = CatalogEntrySchema.safeParse(
      read(`../../../src/seed/default-catalog/${key}.json`),
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
    const parsed = EnvSchemaFileSchema.safeParse(
      read(`../../../../../platform/catalog/env/${key}.json`),
    );

    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    if (!parsed.success) return;
    // The seed writes this file under the same name, and the loader refuses a stem mismatch.
    expect(parsed.data.entryKey).toBe(key);
    expect(parsed.data.variables.length).toBeGreaterThan(0);
  });

  it('keeps the three products in different domains', () => {
    const domains = PRODUCTS.map((key) => {
      const parsed = CatalogEntrySchema.safeParse(
        read(`../../../src/seed/default-catalog/${key}.json`),
      );
      return parsed.success ? parsed.data.domain : `unparseable:${key}`;
    });

    expect(new Set(domains).size).toBe(PRODUCTS.length);
  });
});
