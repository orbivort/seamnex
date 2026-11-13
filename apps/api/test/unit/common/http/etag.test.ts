import { describe, expect, it } from 'vitest';
import { assertIfMatch, etagFor, ifMatchSatisfied } from '../../../../src/common/http/etag';
import { AppError } from '../../../../src/common/problem/app-error';

describe('etag derivation', () => {
  it('derives a quoted, stable validator from the version parts', () => {
    const first = etagFor(['instance', 1, '2026-01-01T00:00:00.000Z', null, undefined]);
    const second = etagFor(['instance', 1, '2026-01-01T00:00:00.000Z', null, undefined]);
    expect(first).toBe(second);
    expect(first).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('changes when any part changes, including a Date that serialises differently', () => {
    const base = etagFor(['instance', 1, new Date('2026-01-01T00:00:00.000Z')]);
    expect(etagFor(['instance', 2, new Date('2026-01-01T00:00:00.000Z')])).not.toBe(base);
    expect(etagFor(['instance', 1, new Date('2026-01-02T00:00:00.000Z')])).not.toBe(base);
  });

  it('renders null and undefined distinctly from the strings "null" and "undefined"', () => {
    expect(etagFor([null])).not.toBe(etagFor(['null']));
    expect(etagFor([undefined])).not.toBe(etagFor(['undefined']));
    expect(etagFor([null])).toBe(etagFor([undefined]));
  });
});

describe('If-Match evaluation', () => {
  const etag = '"0123456789abcdef0123456789abcdef"';

  it('refuses an absent header', () => {
    expect(ifMatchSatisfied(undefined, etag)).toBe(false);
  });

  it('accepts the exact validator, a comma-separated list and the wildcard', () => {
    expect(ifMatchSatisfied(etag, etag)).toBe(true);
    expect(ifMatchSatisfied(`"other", ${etag}`, etag)).toBe(true);
    expect(ifMatchSatisfied(`"other",${etag} `, etag)).toBe(true);
    expect(ifMatchSatisfied('*', etag)).toBe(true);
  });

  it('compares a weak validator by value', () => {
    expect(ifMatchSatisfied(`W/${etag}`, etag)).toBe(true);
    expect(ifMatchSatisfied(`"other"`, etag)).toBe(false);
    expect(ifMatchSatisfied('', etag)).toBe(false);
  });
});

describe('assertIfMatch', () => {
  const etag = etagFor(['instance', 'abc']);

  it('lets an optional request without a header proceed', () => {
    expect(() =>
      assertIfMatch({ header: undefined, etag, required: false, detail: 'stale' }),
    ).not.toThrow();
  });

  it('refuses a required request without a header as a precondition failure', () => {
    let error: unknown;
    try {
      assertIfMatch({ header: undefined, etag, required: true, detail: 'Reload and retry.' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PRECONDITION_FAILED');
    expect((error as AppError).detail).toBe('Reload and retry.');
    expect((error as AppError).remediation).toContain('Reload the resource');
  });

  it('refuses a mismatched validator and accepts a match', () => {
    expect(() =>
      assertIfMatch({ header: '"wrong"', etag, required: true, detail: 'stale' }),
    ).toThrow(AppError);
    expect(() =>
      assertIfMatch({ header: etag, etag, required: false, detail: 'stale' }),
    ).not.toThrow();
  });
});
