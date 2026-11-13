import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { clientKey, createRateLimiter, subjectKey } from '../../../../src/common/http/rate-limit';
import { fakeRedis } from '../../../support/fakes';

function limiterWith(redis: ReturnType<typeof fakeRedis>, options?: { failClosed?: boolean }) {
  const onError = vi.fn();
  const limiter = createRateLimiter(redis as unknown as Redis, onError, options);
  return { limiter, onError };
}

describe('rate limiter', () => {
  it('counts with INCR + PEXPIRE NX and allows up to the limit', async () => {
    const redis = fakeRedis({ count: 3, ttl: 4_200 });
    const { limiter } = limiterWith(redis);

    const decision = await limiter.consume('auth', 'client-1', 5, 10);

    expect(decision).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 5,
      degraded: false,
    });
    expect(redis.commands).toEqual(['multi', 'incr', 'pexpire', 'exec', 'pttl']);
  });

  it('refuses the request that exceeds the limit but keeps no negative remainder', async () => {
    const redis = fakeRedis({ count: 6, ttl: 1_000 });
    const { limiter } = limiterWith(redis);

    const decision = await limiter.consume('auth', 'client-1', 5, 10);

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.degraded).toBe(false);
  });

  it('allows exactly the limit-th request', async () => {
    const redis = fakeRedis({ count: 5, ttl: 2_000 });
    const { limiter } = limiterWith(redis);
    const decision = await limiter.consume('auth', 'client-1', 5, 10);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(0);
  });

  it('reports at least one second even when the counter has no ttl left', async () => {
    const redis = fakeRedis({ count: 1, ttl: -1 });
    const { limiter } = limiterWith(redis);
    const decision = await limiter.consume('auth', 'client-1', 5, 0);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('clamps a sub-second window to one second on the expiry', async () => {
    const redis = fakeRedis({ count: 1, ttl: 100 });
    const { limiter } = limiterWith(redis);
    const decision = await limiter.consume('read', 'client-1', 5, 0);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('fails open for a read path and reports itself degraded', async () => {
    const redis = fakeRedis({ fail: new Error('redis down') });
    const { limiter, onError } = limiterWith(redis);

    const decision = await limiter.consume('read', 'client-1', 5, 10);

    expect(decision).toEqual({
      allowed: true,
      remaining: 5,
      retryAfterSeconds: 0,
      degraded: true,
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('fails closed for the sign-in bucket', async () => {
    const redis = fakeRedis({ fail: new Error('redis down') });
    const { limiter, onError } = limiterWith(redis, { failClosed: true });

    const decision = await limiter.consume('auth', 'client-1', 5, 10);

    expect(decision.allowed).toBe(false);
    expect(decision.degraded).toBe(true);
    expect(decision.retryAfterSeconds).toBe(30);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('treats an empty exec result as a count of zero', async () => {
    const redis = {
      multi: () => redis,
      incr: () => redis,
      pexpire: () => redis,
      exec: () => Promise.resolve([[null, undefined]]),
      pttl: () => Promise.resolve(500),
    } as unknown as ReturnType<typeof fakeRedis>;
    const { limiter } = limiterWith(redis);

    const decision = await limiter.consume('read', 'client-1', 2, 10);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(2);
    expect(decision.degraded).toBe(false);
  });
});

describe('rate-limit keys', () => {
  it('normalises an IPv4-mapped IPv6 address so it cannot double its allowance', () => {
    expect(clientKey('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(clientKey('::ffff:10.0.0.7')).toBe('10.0.0.7');
  });

  it('leaves a plain address alone and names an absent one', () => {
    expect(clientKey('192.168.1.5')).toBe('192.168.1.5');
    expect(clientKey('2001:db8::1')).toBe('2001:db8::1');
    expect(clientKey(undefined)).toBe('unknown');
  });

  it('derives a stable key for a stub directory subject', () => {
    expect(subjectKey('  stub:Alice  ')).toBe('stub:alice');
    expect(subjectKey('stub:alice')).toBe('stub:alice');
  });

  it('collapses a non-stub code into one bucket rather than trusting its text', () => {
    expect(subjectKey('opaque-code')).toBe('external');
    expect(subjectKey('')).toBe('external');
    expect(subjectKey('STUB:upper')).toBe('external');
  });
});
