import { describe, expect, it } from 'vitest';
import {
  clearCookie,
  clearSessionCookieHeaders,
  headerValue,
  parseCookies,
  serializeCookie,
  sessionCookieHeaders,
  type SessionCookieConfig,
} from '../../../../src/common/http/cookies';

describe('cookie parsing and serialisation', () => {
  it('parses the platform cookies and ignores junk', () => {
    const parsed = parseCookies(
      'seamnex_session=abc.def; seamnex_csrf=xyz; junk; =empty; seamnex_session=second',
    );
    expect(parsed.seamnex_session).toBe('abc.def');
    expect(parsed.seamnex_csrf).toBe('xyz');
    expect(parsed.junk).toBeUndefined();
    // The first value wins, so a duplicated name cannot override the credential.
    expect(parsed.seamnex_session).not.toBe('second');
  });

  it('returns nothing for an absent or empty header', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('refuses an oversized header rather than scanning it', () => {
    expect(parseCookies(`seamnex_session=${'a'.repeat(9_000)}`)).toEqual({});
  });

  it('decodes a percent-encoded value', () => {
    expect(parseCookies('seamnex_session=a%20b%3Dc')).toEqual({ seamnex_session: 'a b=c' });
  });

  it('skips a value it cannot decode instead of failing the request', () => {
    expect(parseCookies('seamnex_session=%E0%A4%A; seamnex_csrf=ok')).toEqual({
      seamnex_csrf: 'ok',
    });
  });

  it('skips an invalid cookie name and an empty pair', () => {
    expect(parseCookies('bad name=1; =2; ;seamnex_csrf=ok')).toEqual({ seamnex_csrf: 'ok' });
  });

  it('serialises the session cookie as HttpOnly, Secure and SameSite=Lax', () => {
    const cookie = serializeCookie('seamnex_session', 'abc', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAgeSeconds: 1_800,
    });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=1800');
    expect(cookie).toContain('Path=/');
  });

  it('defaults Path and SameSite and omits every optional attribute', () => {
    expect(serializeCookie('seamnex_session', 'abc')).toBe(
      'seamnex_session=abc; Path=/; SameSite=Lax',
    );
  });

  it('writes the CSRF cookie without HttpOnly so the SPA can echo it', () => {
    const cookie = serializeCookie('seamnex_csrf', 'abc', { httpOnly: false, sameSite: 'Lax' });
    expect(cookie).not.toContain('HttpOnly');
  });

  it('emits every optional attribute when given', () => {
    const cookie = serializeCookie('seamnex_session', 'abc', {
      path: '/portal',
      maxAgeSeconds: 12.9,
      expires: new Date('2026-01-01T00:00:00.000Z'),
      domain: '.example.test',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
    expect(cookie).toContain('Path=/portal');
    expect(cookie).toContain('Max-Age=12');
    expect(cookie).toContain('Expires=Thu, 01 Jan 2026 00:00:00 GMT');
    expect(cookie).toContain('Domain=.example.test');
    expect(cookie).toContain('SameSite=None');
  });

  it('never emits a negative Max-Age', () => {
    expect(serializeCookie('seamnex_session', 'abc', { maxAgeSeconds: -5 })).toContain('Max-Age=0');
  });

  it('percent-encodes the value', () => {
    expect(serializeCookie('seamnex_session', 'a b')).toContain('seamnex_session=a%20b');
  });

  it('expires both cookies on sign-out', () => {
    const cookie = clearCookie('seamnex_session', { httpOnly: true });
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
  });

  it('rejects a value that could inject a header', () => {
    expect(() => serializeCookie('seamnex_session', 'abc\r\nSet-Cookie: evil=1')).toThrow();
    expect(() => serializeCookie('seamnex_session', 'a;b')).toThrow();
    expect(() => serializeCookie('seamnex_session', 'a,b')).toThrow();
  });

  it('rejects an invalid cookie name', () => {
    expect(() => serializeCookie('bad name', 'abc')).toThrow();
  });
});

describe('session cookie pair', () => {
  const config: SessionCookieConfig = {
    SESSION_COOKIE_NAME: 'seamnex_session',
    CSRF_COOKIE_NAME: 'seamnex_csrf',
    SESSION_COOKIE_SECURE: true,
    SESSION_COOKIE_DOMAIN: '.example.test',
  };

  it('sets both cookies with the remaining idle lifetime and the configured domain', () => {
    const [session, csrf] = sessionCookieHeaders(config, {
      sid: 'sid-1',
      csrfToken: 'token-1',
      maxAgeSeconds: 1_800.7,
    });

    expect(session).toContain('seamnex_session=sid-1');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('Max-Age=1800');
    expect(session).toContain('Domain=.example.test');

    expect(csrf).toContain('seamnex_csrf=token-1');
    expect(csrf).not.toContain('HttpOnly');
    expect(csrf).toContain('Secure');
  });

  it('keeps the cookie host-only when no domain is configured', () => {
    const [session] = sessionCookieHeaders(
      { ...config, SESSION_COOKIE_DOMAIN: undefined },
      { sid: 'sid-1', csrfToken: 'token-1', maxAgeSeconds: 60 },
    );
    expect(session).not.toContain('Domain=');
  });

  it('gives the cookies at least one second of life', () => {
    const [session] = sessionCookieHeaders(config, {
      sid: 'sid',
      csrfToken: 'csrf',
      maxAgeSeconds: 0,
    });
    expect(session).toContain('Max-Age=1');
  });

  it('clears both with the attributes they were set with', () => {
    const [session, csrf] = clearSessionCookieHeaders(config);
    for (const cookie of [session, csrf]) {
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('Domain=.example.test');
      expect(cookie).toContain('Secure');
    }
    expect(session).toContain('HttpOnly');
    expect(csrf).not.toContain('HttpOnly');
  });

  it('clears a host-only pair without a domain', () => {
    const [session] = clearSessionCookieHeaders({
      ...config,
      SESSION_COOKIE_DOMAIN: undefined,
    });
    expect(session).not.toContain('Domain=');
  });
});

describe('headerValue', () => {
  it('returns a trimmed single value', () => {
    expect(headerValue({ origin: '  https://portal.test  ' }, 'origin')).toBe(
      'https://portal.test',
    );
  });

  it('takes the first of a repeated header', () => {
    expect(headerValue({ 'x-seamnex-csrf': ['one', 'two'] }, 'x-seamnex-csrf')).toBe('one');
  });

  it('returns undefined for a missing, empty or non-string value', () => {
    expect(headerValue({}, 'origin')).toBeUndefined();
    expect(headerValue({ origin: '' }, 'origin')).toBeUndefined();
    expect(headerValue({ origin: '   ' }, 'origin')).toBeUndefined();
    expect(headerValue({ origin: [] }, 'origin')).toBeUndefined();
    expect(headerValue({ origin: [1 as unknown as string] }, 'origin')).toBeUndefined();
  });
});
