import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { ApiOperation } from '@seamnex/domain';
import { RateLimitGuard } from '../../../../src/contract/guards/rate-limit.guard';
import { AppError } from '../../../../src/common/problem/app-error';
import { fakeRedis } from '../../../support/fakes';
import { operationOf, testContext } from '../../../support/operation-input';

const LIMITED = {
  ...operationOf('POST /auth/session'),
  rateLimit: { bucket: 'auth', limit: 5, windowSeconds: 60 },
} as unknown as ApiOperation;

function guardWith(redis: ReturnType<typeof fakeRedis>): RateLimitGuard {
  return new RateLimitGuard(redis as unknown as Redis);
}

function input(operation: ApiOperation = LIMITED, ip: string | undefined = '::ffff:10.0.0.1') {
  return {
    operation,
    request: { method: operation.method, ip, headers: {} } as never,
    cookies: {},
    context: testContext(),
  };
}

async function refuses(run: Promise<void>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the rate-limit guard to refuse');
}

describe('RateLimitGuard', () => {
  it('is a before-context guard', () => {
    expect(guardWith(fakeRedis()).phase).toBe('before-context');
  });

  it('does nothing for an operation that declares no throttle', async () => {
    const redis = fakeRedis();
    await expect(
      guardWith(redis).canActivate(input(operationOf('GET /jobs'))),
    ).resolves.toBeUndefined();
    expect(redis.commands).toEqual([]);
  });

  it('consumes the declared bucket, keyed by the normalised client address', async () => {
    const redis = fakeRedis({ count: 1, ttl: 30_000 });
    await expect(guardWith(redis).canActivate(input())).resolves.toBeUndefined();
    expect(redis.commands).toContain('incr');
  });

  it('refuses the attempt over the limit with retry-after on the error', async () => {
    const redis = fakeRedis({ count: 6, ttl: 12_000 });
    const error = await refuses(guardWith(redis).canActivate(input()));

    expect(error.code).toBe('RATE_LIMITED');
    expect(error.detail).toContain('12 seconds');
    expect(error.headers?.['retry-after']).toBe('12');
  });

  it('answers UNAVAILABLE, not RATE_LIMITED, when the limiter itself is down', async () => {
    const redis = fakeRedis({ fail: new Error('redis down') });
    const error = await refuses(guardWith(redis).canActivate(input()));

    expect(error.code).toBe('UNAVAILABLE');
    expect(error.detail).toContain('cannot be reached');
    expect(error.remediation).toContain('Readiness');
  });

  it('keys an absent client address as unknown rather than sharing a bucket with a real ip', async () => {
    const redis = fakeRedis({ count: 1, ttl: 1_000 });
    await guardWith(redis).canActivate(input(LIMITED, undefined));
    expect(redis.commands).toContain('incr');
  });

  it('does not throttle a safe request that carries no rule', async () => {
    const redis = fakeRedis();
    await guardWith(redis).canActivate(input(operationOf('GET /jobs/:id/stream')));
    expect(redis.commands).toEqual([]);
  });
});
