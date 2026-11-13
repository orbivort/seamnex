import type { Redis } from 'ioredis';

/**
 * Redis-backed fixed-window limiter (deliverable 3.2, amended by ADR-BE-13).
 *
 * `express-rate-limit` keeps counters in process memory, so behind two API replicas the effective
 * limit is `max × replicas`. Sign-in attempts are the one place where that difference is a security
 * property rather than a performance detail, so the counter lives in Redis from the start.
 *
 * Failure mode is a choice, not an accident:
 *   - **fail open** (the default) for a cheap guard on a read path: refusing traffic because a cache
 *     is down converts an incident into an outage;
 *   - **fail closed** (`failClosed: true`) for the sign-in bucket: an unthrottled sign-in endpoint is
 *     an oracle for credential stuffing, so the limiter reports `degraded` and the caller answers
 *     `503 UNAVAILABLE` — the same dependency already holds every session, so nobody could sign in
 *     during that outage anyway.
 */
export type RateLimitDecision = {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  /** True when the decision was produced by the failure path, not by a count. */
  readonly degraded: boolean;
};

export type RateLimitOptions = {
  /** Refuse when the counter cannot be read. Only an authentication gate should set this. */
  readonly failClosed?: boolean;
};

export type RateLimiter = {
  consume(
    bucket: string,
    identity: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision>;
};

export function createRateLimiter(
  redis: Redis,
  onError: (error: unknown) => void,
  options: RateLimitOptions = {},
): RateLimiter {
  const failClosed = options.failClosed === true;
  return {
    async consume(bucket, identity, limit, windowSeconds) {
      const key = `seamnex:rl:${bucket}:${identity}`;
      const milliseconds = Math.max(1_000, windowSeconds * 1_000);
      try {
        const [[, count]] = (await redis
          .multi()
          .incr(key)
          .pexpire(key, milliseconds, 'NX')
          .exec()) as [[Error | null, number]];
        const used = Number(count ?? 0);
        const ttl = await redis.pttl(key);
        return {
          allowed: used <= limit,
          remaining: Math.max(0, limit - used),
          retryAfterSeconds: Math.max(1, Math.ceil((ttl > 0 ? ttl : milliseconds) / 1_000)),
          degraded: false,
        };
      } catch (error) {
        onError(error);
        return failClosed
          ? { allowed: false, remaining: 0, retryAfterSeconds: 30, degraded: true }
          : { allowed: true, remaining: limit, retryAfterSeconds: 0, degraded: true };
      }
    },
  };
}

/**
 * The key part for a client. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalised so the same client
 * cannot double its allowance by switching representation.
 *
 * `request.ip` is only as trustworthy as `TRUST_PROXY` (ADR-BE-13): with Fastify's `trustProxy` off
 * — the default — it is the socket address and `X-Forwarded-For` is ignored, so a client cannot
 * mint a new bucket per attempt. That header is never read here directly.
 */
export function clientKey(ip: string | undefined): string {
  const address = ip ?? 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/**
 * The key part for the account being authenticated, so a distributed attack on one identity is
 * bounded even when every attempt comes from a different address. Derived from the presented
 * authorization code, never from a claim the caller could vary freely: only `stub:` codes name a
 * directory user, and a non-stub code is collapsed into one bucket rather than trusted.
 */
export function subjectKey(code: string): string {
  const trimmed = code.trim();
  return trimmed.startsWith('stub:')
    ? `stub:${trimmed.slice('stub:'.length).trim().toLowerCase()}`
    : 'external';
}
