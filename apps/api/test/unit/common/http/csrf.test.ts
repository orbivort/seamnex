import { describe, expect, it } from 'vitest';
import {
  assertAllowedOrigin,
  assertCsrf,
  isUnsafeMethod,
  timingSafeEqual,
} from '../../../../src/common/http/csrf';
import { AppError } from '../../../../src/common/problem/app-error';

function caught(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the check to refuse');
}

describe('method classification', () => {
  it('treats the safe methods as safe in any casing', () => {
    for (const method of ['GET', 'head', 'Options']) {
      expect(isUnsafeMethod(method)).toBe(false);
    }
  });

  it('treats every mutation as unsafe', () => {
    for (const method of ['POST', 'put', 'PATCH', 'DELETE']) {
      expect(isUnsafeMethod(method)).toBe(true);
    }
  });
});

describe('timingSafeEqual', () => {
  it('compares equal and unequal values of the same length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('refuses values of different length without leaking which is shorter', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('compares unicode by its utf8 bytes', () => {
    expect(timingSafeEqual('é', 'é')).toBe(true);
    expect(timingSafeEqual('é', 'e')).toBe(false);
  });
});

describe('origin check', () => {
  const allowedOrigins = ['https://portal.test'];

  it('accepts an allowlisted origin, normalising case and a trailing slash', () => {
    expect(() =>
      assertAllowedOrigin({ origin: 'HTTPS://PORTAL.TEST/', allowedOrigins }),
    ).not.toThrow();
  });

  it('refuses a missing, empty or literal null origin', () => {
    for (const origin of [undefined, '', '  ', 'null']) {
      const error = caught(() => assertAllowedOrigin({ origin, allowedOrigins }));
      expect(error.code).toBe('ORIGIN_REJECTED');
      expect(error.detail).toContain('no usable Origin');
    }
  });

  it('refuses a cross-site fetch even when the origin matches', () => {
    const error = caught(() =>
      assertAllowedOrigin({
        origin: 'https://portal.test',
        allowedOrigins,
        secFetchSite: 'Cross-Site',
      }),
    );
    expect(error.code).toBe('ORIGIN_REJECTED');
    expect(error.detail).toContain('cross-site');
  });

  it('accepts an absent or same-site Sec-Fetch-Site', () => {
    for (const secFetchSite of [undefined, 'same-origin', 'same-site', 'none']) {
      expect(() =>
        assertAllowedOrigin({ origin: 'https://portal.test', allowedOrigins, secFetchSite }),
      ).not.toThrow();
    }
  });

  it('refuses an origin the platform does not serve', () => {
    const error = caught(() =>
      assertAllowedOrigin({ origin: 'https://evil.test', allowedOrigins }),
    );
    expect(error.code).toBe('ORIGIN_REJECTED');
    expect(error.detail).toContain('does not serve');
    expect(error.remediation).toContain('Sign in again');
  });
});

describe('CSRF token check', () => {
  const sessionToken = 'session-token-value';

  it('accepts matching header and cookie tokens', () => {
    expect(() =>
      assertCsrf({ headerToken: sessionToken, cookieToken: sessionToken, sessionToken }),
    ).not.toThrow();
  });

  it('refuses a missing header token', () => {
    const error = caught(() =>
      assertCsrf({ headerToken: undefined, cookieToken: sessionToken, sessionToken }),
    );
    expect(error.code).toBe('CSRF_FAILED');
    expect(error.detail).toContain('missing');
  });

  it('refuses a missing cookie token', () => {
    const error = caught(() =>
      assertCsrf({ headerToken: sessionToken, cookieToken: undefined, sessionToken }),
    );
    expect(error.code).toBe('CSRF_FAILED');
    expect(error.detail).toContain('missing');
  });

  it('refuses a session that carries no token, even when both sides are empty', () => {
    const error = caught(() => assertCsrf({ headerToken: '', cookieToken: '', sessionToken: '' }));
    expect(error.code).toBe('CSRF_FAILED');
    expect(error.detail).toContain('carries no CSRF token');
  });

  it('refuses a mismatched header token', () => {
    const error = caught(() =>
      assertCsrf({ headerToken: 'wrong', cookieToken: sessionToken, sessionToken }),
    );
    expect(error.code).toBe('CSRF_FAILED');
    expect(error.detail).toContain('does not match');
  });

  it('refuses a mismatched cookie token', () => {
    expect(() =>
      assertCsrf({ headerToken: sessionToken, cookieToken: 'wrong', sessionToken }),
    ).toThrow(/does not match/);
  });
});
