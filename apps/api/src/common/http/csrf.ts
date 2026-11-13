import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { AppError } from '../problem/app-error';

/**
 * CSRF defence for cookie-authenticated requests (deliverable 3.2).
 *
 * Two independent checks, both required, because either alone has a known gap:
 *   1. `Origin` must be an allowlisted browser origin. That stops a cross-site form post even when
 *      the attacker can guess nothing.
 *   2. `x-seamnex-csrf` must equal the token bound to the server-side session, and the readable
 *      `seamnex_csrf` cookie must carry the same value. The server-side binding is stronger than the
 *      classic double-submit cookie, which a sub-domain attacker can satisfy.
 *
 * Bearer-authenticated machine requests are exempt: a browser does not attach a bearer token
 * automatically, so there is no confused-deputy problem to solve there.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** Constant-time comparison that does not leak length through an early return. */
export function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    // Still compare a same-length pair so the timing does not reveal which side was shorter.
    nodeTimingSafeEqual(a, a);
    return false;
  }
  return nodeTimingSafeEqual(a, b);
}

export function assertAllowedOrigin(input: {
  origin: string | undefined;
  allowedOrigins: readonly string[];
  /**
   * `Sec-Fetch-Site`, when the browser sent one. It is a third, independent signal: a page on
   * `evil.test` cannot forge it, and it fires even for a request that somehow carries a matching
   * `Origin`. Absent (a non-browser client, an older browser) is not a refusal — the origin check
   * still applies, and refusing a missing header would break every test harness.
   */
  secFetchSite?: string | undefined;
}): void {
  const origin = input.origin?.trim().replace(/\/$/, '').toLowerCase();
  if (origin === undefined || origin.length === 0 || origin === 'null') {
    throw new AppError({
      code: 'ORIGIN_REJECTED',
      detail: 'The request has no usable Origin header.',
      remediation: 'Sign in again from the platform sign-in page.',
    });
  }
  if (input.secFetchSite?.trim().toLowerCase() === 'cross-site') {
    throw new AppError({
      code: 'ORIGIN_REJECTED',
      detail: 'The request was issued from a cross-site context.',
      remediation: 'Sign in again from the platform sign-in page.',
    });
  }
  if (!input.allowedOrigins.includes(origin)) {
    throw new AppError({
      code: 'ORIGIN_REJECTED',
      detail: 'The request originates from an origin the platform does not serve.',
      remediation: 'Sign in again from the platform sign-in page.',
    });
  }
}

export function assertCsrf(input: {
  headerToken: string | undefined;
  cookieToken: string | undefined;
  sessionToken: string;
}): void {
  if (input.headerToken === undefined || input.cookieToken === undefined) {
    throw new AppError({
      code: 'CSRF_FAILED',
      detail: 'The request is missing its CSRF token.',
      remediation: 'Reload the page and retry; the browser may have dropped a cookie.',
    });
  }
  // An empty session token would make an empty header match it; a session never legitimately has
  // one, so the comparison fails closed instead of comparing two empty strings.
  if (input.sessionToken.length === 0) {
    throw new AppError({
      code: 'CSRF_FAILED',
      detail: 'The session carries no CSRF token, so the request cannot be verified.',
      remediation: 'Reload the page and retry. The request was not applied.',
    });
  }
  if (
    !timingSafeEqual(input.headerToken, input.sessionToken) ||
    !timingSafeEqual(input.cookieToken, input.sessionToken)
  ) {
    throw new AppError({
      code: 'CSRF_FAILED',
      detail: 'The CSRF token does not match the authenticated session.',
      remediation: 'Reload the page and retry. The request was not applied.',
    });
  }
}
