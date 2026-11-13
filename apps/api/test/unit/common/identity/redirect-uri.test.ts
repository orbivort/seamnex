import { describe, expect, it } from 'vitest';
import { assertRedirectUri, originOf } from '../../../../src/common/identity/redirect-uri';
import { AppError } from '../../../../src/common/problem/app-error';

const ORIGINS = ['https://portal.test'];
const PATHS = ['/auth/callback'];

describe('assertRedirectUri', () => {
  it('accepts a registered path on an allowlisted origin', () => {
    expect(() =>
      assertRedirectUri('https://portal.test/auth/callback', ORIGINS, PATHS),
    ).not.toThrow();
  });

  it('tolerates a trailing slash and upper-case path', () => {
    expect(() =>
      assertRedirectUri('https://portal.test/Auth/Callback/', ORIGINS, PATHS),
    ).not.toThrow();
  });

  it('refuses an unparseable URI', () => {
    for (const uri of ['not a uri', '', '//portal.test/auth/callback']) {
      expect(() => assertRedirectUri(uri, ORIGINS, PATHS), uri).toThrow(AppError);
    }
  });

  it('refuses a query string or a fragment, which a registered callback never carries', () => {
    expect(() =>
      assertRedirectUri('https://portal.test/auth/callback?next=/x', ORIGINS, PATHS),
    ).toThrow(AppError);
    expect(() =>
      assertRedirectUri('https://portal.test/auth/callback#frag', ORIGINS, PATHS),
    ).toThrow(AppError);
  });

  it('refuses a path the client never registered', () => {
    expect(() => assertRedirectUri('https://portal.test/auth/other', ORIGINS, PATHS)).toThrow(
      AppError,
    );
  });

  it('refuses an origin the platform does not serve', () => {
    expect(() => assertRedirectUri('https://evil.test/auth/callback', ORIGINS, PATHS)).toThrow(
      AppError,
    );
  });

  it('refuses a different port on an allowlisted host', () => {
    expect(() =>
      assertRedirectUri('https://portal.test:8443/auth/callback', ORIGINS, PATHS),
    ).toThrow(AppError);
  });
});

describe('originOf', () => {
  it('renders scheme and host, lower-cased without a trailing slash', () => {
    expect(originOf('HTTPS://Portal.Test/path')).toBe('https://portal.test');
    expect(originOf('http://localhost:3000/x')).toBe('http://localhost:3000');
  });

  it('accepts a URL instance', () => {
    expect(originOf(new URL('https://portal.test/a'))).toBe('https://portal.test');
  });

  it('returns an empty string for an unparseable value', () => {
    expect(originOf('nonsense')).toBe('');
  });
});
