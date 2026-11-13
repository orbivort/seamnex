import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
  runWithRequestContext,
} from '../../../src/common/request-id';
import { currentRequestId } from '../../../src/common/logging/logger';

describe('request id resolution', () => {
  it('honours a client id that cannot forge a log line', () => {
    expect(resolveRequestId('abc-123_XYZ.9')).toBe('abc-123_XYZ.9');
  });

  it('takes the first value of a repeated header', () => {
    expect(resolveRequestId(['first-id-0001', 'second-id-0002'])).toBe('first-id-0001');
  });

  it('replaces an id that is too short, too long or contains separators', () => {
    for (const candidate of ['short', 'a'.repeat(129), 'has space in it', 'new\nline-abcdef', '']) {
      const resolved = resolveRequestId(candidate);
      expect(resolved).not.toBe(candidate);
      expect(resolved).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('mints a fresh uuid when the header is absent', () => {
    const resolved = resolveRequestId(undefined);
    expect(resolved).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved).not.toBe(resolveRequestId(undefined));
  });

  it('exposes the documented header name', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });

  it('binds the id and role to the code that runs inside it', () => {
    const seen = runWithRequestContext('rid-bound', 'api', () => currentRequestId());
    expect(seen).toBe('rid-bound');
  });

  it('does not leak the context outside the callback', () => {
    runWithRequestContext('rid-scoped', 'api', () => currentRequestId());
    expect(currentRequestId()).toBeUndefined();
  });

  it('propagates the callback result and its rejection', async () => {
    expect(runWithRequestContext('rid-1', 'api', () => 42)).toBe(42);
    await expect(
      runWithRequestContext('rid-2', 'api', async () => {
        throw new Error('inside');
      }),
    ).rejects.toThrow('inside');
  });

  it('generates distinct ids per request', () => {
    const ids = new Set(Array.from({ length: 20 }, () => resolveRequestId(undefined)));
    expect(ids.size).toBe(20);
    expect(ids.has(randomUUID())).toBe(false);
  });
});
