import { describe, expect, it } from 'vitest';
import { MASK } from '../../../src/common/logging/masking';
import { maskPersonalData, redactSample } from '../../../src/common/privacy/sample-redaction';

/**
 * FR-5.5 — the stored item exists so an author can name a path, not so the platform can keep a copy
 * of a customer's record. These cases are the guarantee: secrets never land, addresses are masked,
 * and the document has a ceiling.
 */
describe('redactSample', () => {
  it('masks e-mail addresses and phone numbers in place', () => {
    const result = redactSample({
      email: 'ops@northwind.example',
      phone: '+49 30 1234 5678',
      note: 'call ops@northwind.example before 17:00',
    });

    const item = result.item as Record<string, string>;
    expect(item['email']).toBe(MASK);
    expect(item['phone']).toBe(MASK);
    expect(item['note']).not.toContain('@');
    expect(result.truncated).toBe(false);
  });

  it('replaces credential-shaped keys with the mask rather than echoing the value', () => {
    const result = redactSample({
      name: 'Northwind',
      apiToken: 'seamnex_token_live_9f2',
      headers: { Authorization: 'Bearer abc', cookie: 'sid=1' },
      password: 'hunter2',
    });

    const item = result.item as Record<string, unknown>;
    expect(item['apiToken']).toBe(MASK);
    expect(item['password']).toBe(MASK);
    const headers = item['headers'] as Record<string, string>;
    expect(headers['Authorization']).toBe(MASK);
    expect(headers['cookie']).toBe(MASK);
    expect(JSON.stringify(item)).not.toContain('hunter2');
  });

  it('cuts long strings and says the stored item is truncated', () => {
    const result = redactSample({ description: 'x'.repeat(500) });

    const item = result.item as Record<string, string>;
    expect(item['description']?.endsWith('…')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('stops at the depth limit instead of walking a deep document', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };

    const result = redactSample(deep);
    expect(JSON.stringify(result.item)).toContain('depth-limit');
    expect(result.truncated).toBe(true);
  });

  it('keeps only the first entries of a long array', () => {
    const result = redactSample({ rows: Array.from({ length: 40 }, (_, index) => index) });

    const item = result.item as { rows: number[] };
    expect(item.rows.length).toBe(20);
    expect(result.truncated).toBe(true);
  });

  it('shrinks a document that exceeds the byte ceiling', () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) {
      wide[`field${index}`] = 'v'.repeat(110);
    }

    const result = redactSample(wide);
    expect(JSON.stringify(result.item).length).toBeLessThanOrEqual(4_096);
    expect(result.truncated).toBe(true);
  });

  it('shrinks an oversized array from its tail, keeping valid JSON', () => {
    const rows = Array.from({ length: 20 }, () => ({
      city: 'v'.repeat(120),
      street: 'v'.repeat(120),
      postcode: 'v'.repeat(120),
      country: 'v'.repeat(120),
    }));

    const result = redactSample(rows);
    const serialised = JSON.stringify(result.item);

    expect(Array.isArray(result.item)).toBe(true);
    expect((result.item as unknown[]).length).toBeLessThan(20);
    expect(serialised.length).toBeLessThanOrEqual(4_096);
    expect(result.truncated).toBe(true);
  });

  it('keeps only the first fifty keys and says so', () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 60; index += 1) wide[`field${index}`] = index;

    const result = redactSample(wide);
    const item = result.item as Record<string, number>;

    expect(Object.keys(item)).toHaveLength(50);
    expect(item['field49']).toBe(49);
    expect(item['field50']).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it('drops a value it cannot serialise a shape for, without failing the mirror', () => {
    const result = redactSample({
      nested: undefined,
      callback: () => 1,
      symbol: Symbol('not-serialisable'),
      count: 3,
      flag: false,
    });

    expect(result.item).toEqual({
      nested: null,
      callback: null,
      symbol: null,
      count: 3,
      flag: false,
    });
    expect(result.truncated).toBe(false);
  });

  it('answers a null item when the item itself cannot be walked', () => {
    const result = redactSample({
      get boom(): string {
        throw new Error('this getter is hostile');
      },
    });

    expect(result).toEqual({ item: null, truncated: false });
  });
});

describe('maskPersonalData', () => {
  it('leaves a value with nothing personal in it alone', () => {
    expect(maskPersonalData('Northwind')).toBe('Northwind');
  });

  it('keeps an ISO timestamp readable, because it identifies nobody', () => {
    // The phone shape matches `2026-11-12`, so every date field in the sample used to read
    // `********T08:41:00Z` — the one screen whose point is showing what the item looks like.
    expect(maskPersonalData('2026-11-12')).toBe('2026-11-12');
    expect(maskPersonalData('2026-11-12T08:41:00Z')).toBe('2026-11-12T08:41:00Z');
  });

  it('still masks a phone number written without a country code', () => {
    expect(maskPersonalData('030 1234 5678')).toBe(MASK);
  });

  it('leaves a local address and a scoped name alone, because neither identifies a person', () => {
    // `user@localhost` and `@scope` appear in real payloads; masking them destroys the field
    // without protecting anyone.
    expect(maskPersonalData('user@localhost')).toBe('user@localhost');
    expect(maskPersonalData('token@ns')).toBe('token@ns');
    // Two `@` is not an address the platform knows how to read.
    expect(maskPersonalData('first@second@third')).toBe('first@second@third');
    // A domain label with an underscore is a local name, not a mail domain.
    expect(maskPersonalData('ops@north_wind.example')).toBe('ops@north_wind.example');
  });

  it('masks an address in the middle of a sentence and keeps the rest readable', () => {
    expect(maskPersonalData('write to ops@northwind.example today')).toBe(`write to ${MASK} today`);
  });

  it('leaves a short number run alone when it cannot be a phone number', () => {
    expect(maskPersonalData('123-456')).toBe('123-456');
    expect(maskPersonalData('order 12345')).toBe('order 12345');
  });
});
