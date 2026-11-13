import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_HEADER, readIdempotencyKey } from '../../../../src/common/http/idempotency';
import { AppError } from '../../../../src/common/problem/app-error';

describe('Idempotency-Key header', () => {
  it('names the header the transport uses', () => {
    expect(IDEMPOTENCY_HEADER).toBe('idempotency-key');
  });

  it('returns an absent key for a missing, repeated-empty or non-string header', () => {
    expect(readIdempotencyKey({})).toBeUndefined();
    expect(readIdempotencyKey({ [IDEMPOTENCY_HEADER]: [] })).toBeUndefined();
    expect(readIdempotencyKey({ [IDEMPOTENCY_HEADER]: [42 as unknown as string] })).toBeUndefined();
    expect(readIdempotencyKey({ [IDEMPOTENCY_HEADER]: '   ' })).toBeUndefined();
  });

  it('takes the first value when the header repeats', () => {
    expect(readIdempotencyKey({ [IDEMPOTENCY_HEADER]: ['key-one', 'key-two'] })).toBe('key-one');
  });

  it('trims a usable key', () => {
    expect(readIdempotencyKey({ [IDEMPOTENCY_HEADER]: '  deploy-42  ' })).toBe('deploy-42');
  });

  it('accepts a key at the length boundary', () => {
    const key = 'k'.repeat(255);
    expect(readIdempotencyKey({ [IDEMPOTENCY_HEADER]: key })).toBe(key);
  });

  it('refuses a key beyond the accepted length with a field error', () => {
    let error: unknown;
    try {
      readIdempotencyKey({ [IDEMPOTENCY_HEADER]: 'k'.repeat(256) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION_FAILED');
    expect((error as AppError).status).toBe(422);
    expect((error as AppError).fieldErrors).toEqual([
      expect.objectContaining({ field: 'Idempotency-Key', code: 'too_big' }),
    ]);
  });
});
