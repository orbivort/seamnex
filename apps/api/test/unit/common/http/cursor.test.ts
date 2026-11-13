import { describe, expect, it } from 'vitest';
import {
  buildPage,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  encodeCursor,
  MAX_PAGE_LIMIT,
  readLimit,
} from '../../../../src/common/http/cursor';
import { AppError } from '../../../../src/common/problem/app-error';

describe('page limit', () => {
  it('uses the default for an absent or empty value', () => {
    expect(readLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(readLimit('')).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('parses a positive integer and clamps above the maximum', () => {
    expect(readLimit('7')).toBe(7);
    expect(readLimit('1')).toBe(1);
    expect(readLimit(String(MAX_PAGE_LIMIT + 500))).toBe(MAX_PAGE_LIMIT);
    // `parseInt` truncates, so a decimal is a client convenience rather than a refusal.
    expect(readLimit('2.5')).toBe(2);
  });

  it('refuses a value that is not a positive integer', () => {
    for (const raw of ['zero', '0', '-1', ' ', 'NaN']) {
      let error: unknown;
      try {
        readLimit(raw);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).status).toBe(422);
      expect((error as AppError).fieldErrors).toEqual([
        expect.objectContaining({ field: 'limit', code: 'invalid_type' }),
      ]);
    }
  });
});

describe('cursor codec', () => {
  it('round-trips a createdAt/id cursor', () => {
    const cursor = { createdAt: '2026-01-02T03:04:05.000Z', id: '018f-abc' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips a seq cursor', () => {
    expect(decodeCursor(encodeCursor({ seq: '42' }))).toEqual({ seq: '42' });
  });

  it('prefers seq when both shapes are present', () => {
    const raw = Buffer.from(
      JSON.stringify({ seq: '9', createdAt: '2026-01-01T00:00:00.000Z', id: 'x' }),
      'utf8',
    ).toString('base64url');
    expect(decodeCursor(raw)).toEqual({ seq: '9' });
  });

  it('returns undefined for an absent or empty cursor', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
  });

  it('refuses a cursor it did not issue', () => {
    const malformed = [
      'not-base64-json',
      Buffer.from('null', 'utf8').toString('base64url'),
      Buffer.from('42', 'utf8').toString('base64url'),
      Buffer.from('"a string"', 'utf8').toString('base64url'),
      Buffer.from('{}', 'utf8').toString('base64url'),
      Buffer.from('{"seq":""}', 'utf8').toString('base64url'),
      Buffer.from('{"createdAt":"x"}', 'utf8').toString('base64url'),
      Buffer.from('{"id":"x"}', 'utf8').toString('base64url'),
      Buffer.from('{"seq":5}', 'utf8').toString('base64url'),
    ];
    for (const raw of malformed) {
      let error: unknown;
      try {
        decodeCursor(raw);
      } catch (caught) {
        error = caught;
      }
      expect(error, raw).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).fieldErrors[0]?.field).toBe('cursor');
    }
  });
});

describe('buildPage', () => {
  const cursorOf = (row: { id: string }) => ({ createdAt: '2026-01-01T00:00:00.000Z', id: row.id });

  it('trims the over-fetched row and derives a next cursor from the last kept item', () => {
    const page = buildPage([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2, 10, cursorOf);
    expect(page.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(page.total).toBe(10);
    expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({
      createdAt: '2026-01-01T00:00:00.000Z',
      id: 'b',
    });
  });

  it('reports no next cursor when the page is not over-fetched', () => {
    const page = buildPage([{ id: 'a' }], 2, 1, cursorOf);
    expect(page.items).toEqual([{ id: 'a' }]);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    const page = buildPage<{ id: string }>([], 2, 0, cursorOf);
    expect(page).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it('copies rather than aliases the rows when the page is complete', () => {
    const rows = [{ id: 'a' }];
    const page = buildPage(rows, 5, 1, cursorOf);
    expect(page.items).not.toBe(rows);
    expect(page.items).toEqual(rows);
  });
});
