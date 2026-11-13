import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { clientKey, createRateLimiter, type RateLimiter } from '../../common/http/rate-limit';
import { AppError } from '../../common/problem/app-error';
import { REDIS } from '../../redis/redis.module';
import type { OperationGuard, OperationGuardContext } from './operation-guard';

/**
 * The contract-declared throttle: the bucket, limit and window come from the operation itself, so
 * a route cannot be rate-limited by accident or left unlimited by omission.
 *
 * Fail closed. The only limited operation is `POST /auth/session`, and an unthrottled sign-in
 * endpoint is a credential-stuffing oracle. Redis also holds every session, so during such an
 * outage nobody could sign in anyway — the honest answer is 503, not "go on".
 */
@Injectable()
export class RateLimitGuard implements OperationGuard {
  readonly phase = 'before-context' as const;
  private readonly logger = new Logger('rate-limit-guard');
  private readonly limiter: RateLimiter;

  constructor(@Inject(REDIS) redis: Redis) {
    this.limiter = createRateLimiter(
      redis,
      (error: unknown) => {
        this.logger.error(
          `rate limiter unavailable; refusing the rate-limited operation (${String(error)})`,
        );
      },
      { failClosed: true },
    );
  }

  async canActivate({ operation, request }: OperationGuardContext): Promise<void> {
    const rule = operation.rateLimit;
    if (rule === undefined) return;

    const decision = await this.limiter.consume(
      rule.bucket,
      clientKey(request.ip),
      rule.limit,
      rule.windowSeconds,
    );

    if (!decision.allowed && decision.degraded) {
      // The limiter itself is down. Refusing is the safe answer and it must not be disguised as
      // "too many attempts", which would send the user to wait for nothing.
      throw new AppError({
        code: 'UNAVAILABLE',
        detail: 'The sign-in attempt limiter cannot be reached, so no attempt is accepted.',
        remediation: 'Retry shortly. Readiness reports the failing dependency.',
      });
    }

    if (!decision.allowed) {
      this.logger.warn({
        msg: 'rate limit refused a request',
        operation: operation.path,
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      throw new AppError({
        code: 'RATE_LIMITED',
        detail: `Too many attempts for this operation. Retry after ${decision.retryAfterSeconds} seconds.`,
        // Carried on the error so the filter and the dispatcher write it through one path.
        headers: { 'retry-after': String(decision.retryAfterSeconds) },
      });
    }
  }
}
