import { describe, expect, it } from 'vitest';
import {
  compareEntryKeys,
  EntryKeySchema,
  isComposedEntryKey,
  LEGACY_KEY_ALIASES,
  resolveKey,
} from '../../src/schemas/common';

/**
 * ADR-BE-20 phase 1 accepts two grammars at once. The table below is the ADR's encoding rules,
 * asserted: a value must not be able to parse as both, because the loader reconciles by key and a
 * dual-read window that accepted two readings of one string would make the identity ambiguous.
 */

const ACCEPTED = [
  // legacy — every stored row and published bookmark still uses these
  'D1',
  'D9',
  'D14',
  'D999',
  // composed — domain 01–99, product 01–99, both zero-padded
  'D01-01',
  'D02-01',
  'D09-01',
  'D10-01',
  'D13-02',
  'D99-99',
];

const REJECTED = [
  'D0', // legacy: no leading zero
  'D01', // neither: a composed key needs its separator
  'd1', // lower case
  'D1-01', // domain part not padded
  'D1-1', // product part not padded
  'D01-1', // product part not padded
  'D001-01', // three-digit domain
  'D00-01', // domain ordinal 00
  'D01-00', // product ordinal 00 is reserved
  'D0101', // the concatenated alternative this ADR rejected
  'd01-01', // lower case
  'D01-001', // three-digit product
  'D01-01-01', // one separator only
  'D01 -01',
  ' D01-01',
  '',
];

describe('catalog entry key', () => {
  it.each(ACCEPTED)('accepts %s', (key) => {
    expect(EntryKeySchema.safeParse(key).success).toBe(true);
  });

  it.each(REJECTED)('refuses %s', (key) => {
    expect(EntryKeySchema.safeParse(key).success).toBe(false);
  });

  it('keeps the two grammars disjoint', () => {
    // The composed form always carries a hyphen and the legacy form never does, which is what makes
    // a dual-read window unambiguous. This pins the property rather than the implementation.
    for (const key of ACCEPTED) {
      expect(isComposedEntryKey(key)).toBe(key.includes('-'));
    }
    expect(isComposedEntryKey('D00-01')).toBe(false);
    expect(isComposedEntryKey('D01-00')).toBe(false);
    expect(isComposedEntryKey('D100-01')).toBe(false);
  });

  it('names both accepted forms in the refusal, so the fix is obvious', () => {
    const parsed = EntryKeySchema.safeParse('D1-1');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain('D01-01');
  });
});

describe('legacy aliases', () => {
  it('carries exactly the thirteen rows of the mapping table', () => {
    // The ADR's table, verbatim. A key that is missing here stops resolving on read, and a key that
    // is added without a row in that table is an identity nobody agreed to.
    expect(Object.entries(LEGACY_KEY_ALIASES)).toEqual([
      ['D1', 'D01-01'],
      ['D2', 'D02-01'],
      ['D3', 'D03-01'],
      ['D4', 'D04-01'],
      ['D5', 'D05-01'],
      ['D6', 'D06-01'],
      ['D7', 'D07-01'],
      ['D8', 'D08-01'],
      ['D9', 'D09-01'],
      ['D10', 'D10-01'],
      ['D11', 'D11-01'],
      ['D12', 'D12-01'],
      ['D13', 'D13-01'],
    ]);
  });

  it('resolves both spellings to the composed key, and is idempotent', () => {
    for (const [legacy, composed] of Object.entries(LEGACY_KEY_ALIASES)) {
      expect(EntryKeySchema.safeParse(legacy).success, legacy).toBe(true);
      expect(EntryKeySchema.safeParse(composed).success, composed).toBe(true);
      expect(resolveKey(legacy)).toBe(composed);
      // Idempotent: a caller may resolve a value it has already resolved.
      expect(resolveKey(composed)).toBe(composed);
      // The ADR's disjointness row: no legacy key can be mistaken for a composed one.
      expect(isComposedEntryKey(legacy), legacy).toBe(false);
    }
  });

  it('is a bijection, so phase 2 is reversible', () => {
    const successors = Object.values(LEGACY_KEY_ALIASES);
    expect(new Set(successors).size).toBe(successors.length);
    for (const successor of successors) expect(isComposedEntryKey(successor)).toBe(true);
  });

  it('leaves a value it does not know alone', () => {
    expect(resolveKey('D99-01')).toBe('D99-01');
    expect(resolveKey('not-a-key')).toBe('not-a-key');
  });
});

describe('entry key ordering', () => {
  const sort = (keys: string[]): string[] => [...keys].sort(compareEntryKeys);

  it('orders the catalog sequence as written, not as text', () => {
    // The grid's expected sequence: group first, product second, both numeric.
    expect(sort(['D09-01', 'D01-02', 'D13-02', 'D01-01', 'D02-01', 'D01-10'])).toEqual([
      'D01-01',
      'D01-02',
      'D01-10',
      'D02-01',
      'D09-01',
      'D13-02',
    ]);
  });

  it('reads both ordinals as numbers, which text order gets wrong', () => {
    // `D10` < `D9` as text. The catalog order is the other way round.
    expect(sort(['D10', 'D9', 'D2'])).toEqual(['D2', 'D9', 'D10']);
    expect(compareEntryKeys('D9', 'D10')).toBeLessThan(0);
    // Zero padding is a spelling rule; the comparison neither depends on it nor is broken by it.
    expect(compareEntryKeys('D09-01', 'D10-01')).toBeLessThan(0);
    expect(compareEntryKeys('D02-09', 'D02-10')).toBeLessThan(0);
  });

  it('places a legacy key where the product-01 it aliases belongs', () => {
    // `D3` is `D03-01`: after every earlier product of domain 03 and before product 02.
    expect(compareEntryKeys('D3', 'D02-99')).toBeGreaterThan(0);
    expect(compareEntryKeys('D3', 'D03-02')).toBeLessThan(0);
    // The two spellings are adjacent, and the raw text — not arrival order — says which comes first.
    expect(sort(['D03-02', 'D3', 'D03-01'])).toEqual(['D03-01', 'D3', 'D03-02']);
    for (const [legacy, composed] of Object.entries(LEGACY_KEY_ALIASES)) {
      // Never zero: two spellings must not tie, or a stable sort would fall back to arrival order.
      expect(Math.abs(compareEntryKeys(legacy, composed)), legacy).toBe(1);
      expect(Math.abs(compareEntryKeys(composed, legacy)), composed).toBe(1);
    }
  });

  it('keeps one sequence when both grammars are present', () => {
    // A half-renamed tree: the two spellings of one entry sit together, not in two blocks.
    expect(sort(['D10-01', 'D3', 'D02-01', 'D10', 'D1'])).toEqual([
      'D1',
      'D02-01',
      'D3',
      'D10',
      'D10-01',
    ]);
  });

  it('orders different prefixes by the letter, before any ordinal', () => {
    expect(compareEntryKeys('C99-99', 'D01-01')).toBeLessThan(0);
    expect(compareEntryKeys('D99-99', 'E01-01')).toBeLessThan(0);
    expect(sort(['E01-01', 'D01-01', 'C01-01'])).toEqual(['C01-01', 'D01-01', 'E01-01']);
  });

  it('treats the prefix letter as case-insensitive when it decides the order', () => {
    // A lower-case key is refused by the schema; ordering one must still place it by its ordinal
    // rather than by the case of its letter.
    expect(compareEntryKeys('d01-02', 'D01-01')).toBeGreaterThan(0);
    expect(compareEntryKeys('d01-01', 'D02-01')).toBeLessThan(0);
    expect(compareEntryKeys('d01-01', 'E01-01')).toBeLessThan(0);
  });

  it('sorts a malformed value after every catalog key, and by text among its own kind', () => {
    const keys = ['not-a-key', 'D01-01', 'D1-1', 'D05-01', '', 'D0101'];
    const ordered = sort(keys);

    expect(ordered.slice(0, 2)).toEqual(['D01-01', 'D05-01']);
    // Nothing catalog-shaped is displaced by the strays; they keep a stable order of their own.
    expect(ordered.slice(2)).toEqual(['', 'D0101', 'D1-1', 'not-a-key']);
    for (const key of ACCEPTED) expect(compareEntryKeys(key, 'not-a-key')).toBeLessThan(0);
    expect(compareEntryKeys('not-a-key', 'D01-01')).toBeGreaterThan(0);
  });

  it('is a total order: reversing the input cannot change the result', () => {
    const keys = ['D01-01', 'D9', 'D01-02', 'D2', 'nope', 'D10-01', 'D001-01', 'D1'];
    expect(sort([...keys].reverse())).toEqual(sort(keys));
    for (const left of keys) {
      for (const right of keys) {
        // Summed rather than compared with `-`: `Math.sign(0)` and its negation are both zero but
        // `-0` and `0` are not the same value to `toBe`.
        expect(
          Math.sign(compareEntryKeys(left, right)) + Math.sign(compareEntryKeys(right, left)),
        ).toBe(0);
        if (left === right) expect(compareEntryKeys(left, right)).toBe(0);
      }
    }
  });
});
