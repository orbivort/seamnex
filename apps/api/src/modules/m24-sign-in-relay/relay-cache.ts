import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * ADR-BE-22 — the product session cache and the single-flight lock, as keys and nothing else.
 *
 * Three properties are the whole design:
 *
 *   * **Per subject, per instance.** The key carries both. A cache keyed on the instance would hand
 *     one person's product session to another, which turns per-user attribution into fiction.
 *   * **Shorter than the product's own session.** The platform's ceiling is
 *     `SEAMNEX_RELAY_SESSION_TTL_SECONDS`; the product's declared maximum (if any) minus a minute
 *     wins when it is lower. A cache that outlives the product session plants cookies the next
 *     request throws away and looks, to the user, like a sign-in that did not take.
 *   * **Nothing is cached when the bound is unknowable-safe.** A product that declares a session
 *     shorter than the safety margin yields no entry at all rather than a floor value that exceeds
 *     it.
 *
 * A cached value is a bearer credential for the product: it is the same material the browser holds
 * as a cookie. Redis is therefore a credential store for this feature, not a scratch cache — it
 * needs authentication and transport protection outside the development stack, and its TTL is the
 * revocation window the ADR names.
 */

const CACHE_PREFIX = 'relay:';
/**
 * Deliberately not `relay:lock:`: `relaySubjectPattern` matches `relay:*:<subject>`, so a lock filed
 * under the cache namespace would be collected by a sign-out walk and release a lock a live launch is
 * still holding. A different separator keeps the two namespaces unconfusable.
 */
const LOCK_PREFIX = 'relay-lock:';
const MIN_TTL_SECONDS = 60;
/**
 * What to assume when the catalogue declares no session maximum. The ADR's prerequisite
 * (`OPENPROJECT_SESSION__TTL__ENABLED=true`) is not enforced by code, so the undeclared case must
 * not silently take the 30-minute platform ceiling.
 */
const UNDECLARED_PRODUCT_TTL_SECONDS = 600;

export function relaySessionKey(instanceId: string, subjectIdpId: string): string {
  return `${CACHE_PREFIX}${instanceId}:${subjectIdpId}`;
}

export function relayLockKey(instanceId: string, subjectIdpId: string): string {
  return `${LOCK_PREFIX}${instanceId}:${subjectIdpId}`;
}

/**
 * Every cached instance for one subject; used on sign-out and revocation.
 *
 * Only the subject is escaped. The `*` before the instance component is the point of the pattern, and
 * escaping the whole string — as the first version did — turned it into a literal that matched no key
 * the relay ever writes, so sign-out and offboarding silently revoked nothing.
 */
export function relaySubjectPattern(subjectIdpId: string): string {
  return `${CACHE_PREFIX}*:${escapeGlob(subjectIdpId)}`;
}

/**
 * `productTtlSeconds` is the product's declared session maximum (`integration_metadata
 * .session_max_minutes`), or `null` when the catalog entry declares none.
 *
 * Returns `0` when no safe lifetime exists — the caller then skips the cache. The previous
 * implementation floored at one minute, which could exceed a product session shorter than that and
 * defeat the bound it was computing.
 */
export function relayTtlSeconds(
  productTtlSeconds: number | null,
  platformTtlSeconds: number,
): number {
  const productCeiling =
    productTtlSeconds === null
      ? UNDECLARED_PRODUCT_TTL_SECONDS
      : productTtlSeconds - MIN_TTL_SECONDS;
  const bounded = Math.min(platformTtlSeconds, productCeiling);
  return bounded < MIN_TTL_SECONDS ? 0 : bounded;
}

export type CachedProductSession = {
  /** The product's own `name=value` cookie pairs, exactly as the product set them. */
  readonly cookies: readonly string[];
  readonly cachedAt: number;
};

export async function readCachedSession(
  redis: Redis,
  instanceId: string,
  subjectIdpId: string,
): Promise<CachedProductSession | null> {
  const raw = await redis.get(relaySessionKey(instanceId, subjectIdpId)).catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedProductSession>;
    // A value written by another version, or by anything else that reached this key, must not be
    // able to throw out of the launch hop. Anything that is not a `name=value` string is dropped.
    const cookies = Array.isArray(parsed.cookies)
      ? parsed.cookies.filter((cookie): cookie is string => typeof cookie === 'string')
      : [];
    if (cookies.length === 0) return null;
    return { cookies, cachedAt: typeof parsed.cachedAt === 'number' ? parsed.cachedAt : 0 };
  } catch {
    return null;
  }
}

export async function writeCachedSession(
  redis: Redis,
  instanceId: string,
  subjectIdpId: string,
  cookies: readonly string[],
  ttlSeconds: number,
): Promise<void> {
  // `0` is the "no safe lifetime" answer from `relayTtlSeconds`; `EX 0` is an error in Redis and a
  // session that outlives its product session is worse than a cold launch.
  if (ttlSeconds <= 0 || cookies.length === 0) return;
  const payload: CachedProductSession = { cookies, cachedAt: Date.now() };
  await redis
    .set(relaySessionKey(instanceId, subjectIdpId), JSON.stringify(payload), 'EX', ttlSeconds)
    .catch(() => undefined);
}

export async function dropCachedSession(
  redis: Redis,
  instanceId: string,
  subjectIdpId: string,
): Promise<void> {
  await redis.del(relaySessionKey(instanceId, subjectIdpId)).catch(() => undefined);
}

export async function dropSubjectSessions(
  redis: Redis,
  subjectIdpId: string,
  instanceId?: string,
): Promise<void> {
  if (instanceId !== undefined) {
    await dropCachedSession(redis, instanceId, subjectIdpId);
    return;
  }
  const keys = await scanKeys(redis, relaySubjectPattern(subjectIdpId));
  if (keys.length > 0) await redis.del(...keys).catch(() => undefined);
}

/**
 * Walks the keys a prepared pattern selects.
 *
 * The escaping happens in whichever function built the pattern (`relaySubjectPattern`), never here:
 * this is the one place a `MATCH` argument is handed to Redis, so escaping again would neutralise the
 * caller's wildcards and a deletion would match nothing. The walk is `SCAN`, so a sign-out neither
 * blocks Redis the way `KEYS` does nor depends on a single cursor pass.
 */
async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  try {
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
  } catch {
    return keys;
  }
  return keys;
}

/**
 * Neutralises the glob metacharacters a value may carry, so it matches as a literal.
 *
 * The subject comes from the identity provider and is not the platform's to constrain: interpolated
 * raw, a `*` in a `sub` claim would select — and delete — every cached session on the platform.
 */
function escapeGlob(value: string): string {
  return value.replace(/([*?[\]\\])/g, '\\$1');
}

/**
 * Single-flight. Returns a release function, or `null` when someone else holds the lock for this
 * (instance, subject) pair — in which case the caller falls back rather than queueing a second
 * password attempt. `PEXPIRE`-style expiry means a crashed holder cannot block a user forever.
 *
 * The release compares the token it wrote, so a lock that already expired and was taken by another
 * tab is not deleted out from under it.
 */
export async function acquireLoginLock(
  redis: Redis,
  instanceId: string,
  subjectIdpId: string,
  ttlMs: number,
): Promise<(() => Promise<void>) | null> {
  const key = relayLockKey(instanceId, subjectIdpId);
  const token = randomBytes(12).toString('base64url');
  const acquired = await redis
    .set(key, token, 'PX', ttlMs, 'NX')
    .catch(() => null as string | null);
  if (acquired !== 'OK') return null;

  return async () => {
    const released = await redis
      .eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        1,
        key,
        token,
      )
      .catch(() => 0);
    void released;
  };
}
