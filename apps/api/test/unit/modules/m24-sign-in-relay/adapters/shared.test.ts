import { describe, expect, it } from 'vitest';
import {
  absolute,
  absorbCookies,
  cookieHeader,
  emittedCookies,
  jarFromCookies,
  messageOf,
  newJar,
  pathOf,
  setCookieValues,
  text,
} from '../../../../../src/modules/m24-sign-in-relay/adapters/shared';

/**
 * The shared cookie/HTTP vocabulary of ADR-BE-22's two product adapters.
 *
 * It exists because two copies of this code would be two places to get `Set-Cookie` handling wrong,
 * so the tests are about the details a product actually differs on: a cookie value with no `=`, an
 * attribute string that has to survive the hop verbatim, a `Location` that is already absolute, and
 * a body read that must not throw out of the launch.
 */

const base = 'http://orangehrm.localhost:8020';

describe('jarFromCookies', () => {
  it('rebuilds both halves of the jar from a cached Set-Cookie string', () => {
    const jar = jarFromCookies(['_orangehrm=signed-in; Path=/web; HttpOnly']);

    expect([...jar.values.entries()]).toEqual([['_orangehrm', 'signed-in']]);
    // The launch hop re-emits the attribute string, so it is kept as the product wrote it.
    expect([...jar.raw.values()]).toEqual(['_orangehrm=signed-in; Path=/web; HttpOnly']);
  });

  it('ignores a value that is not a string, a pair with no name, and one with no separator', () => {
    const jar = jarFromCookies([42 as unknown as string, 'novalue', '=nameless; Path=/', 'kept=1']);

    expect([...jar.values.entries()]).toEqual([['kept', '1']]);
  });
});

describe('absorbCookies', () => {
  it('is last-write-wins, so the signed-in cookie replaces the pre-auth one', () => {
    const jar = newJar();
    absorbCookies(
      new Response('', {
        status: 200,
        headers: { 'set-cookie': '_orangehrm=pre-auth; Path=/web' },
      }),
      jar,
    );
    absorbCookies(
      new Response('', {
        status: 200,
        headers: { 'set-cookie': '_orangehrm=signed-in; Path=/web' },
      }),
      jar,
    );

    expect(jar.values.get('_orangehrm')).toBe('signed-in');
    expect([...jar.raw.values()]).toEqual(['_orangehrm=signed-in; Path=/web']);
  });

  it('keeps every cookie of a multi-value response and skips unusable pairs', () => {
    const response = new Response('', {
      status: 200,
      headers: [
        ['set-cookie', 'a=1; Path=/'],
        ['set-cookie', 'nameless'],
        ['set-cookie', '=orphan'],
        ['set-cookie', 'b=2; Path=/'],
      ],
    });

    const jar = newJar();
    absorbCookies(response, jar);

    expect([...jar.values.entries()]).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('reads a single set-cookie header when the runtime has no getSetCookie', () => {
    const response = {
      headers: {
        getSetCookie: () => undefined,
        get: (name: string) => (name === 'set-cookie' ? 'a=1' : null),
      },
    } as unknown as Response;

    expect(setCookieValues(response)).toEqual(['a=1']);
  });

  it('answers no cookies when the response carries none', () => {
    const response = {
      headers: { getSetCookie: () => undefined, get: () => null },
    } as unknown as Response;

    expect(setCookieValues(response)).toEqual([]);
  });
});

describe('emittedCookies and cookieHeader', () => {
  it('emits the attribute strings for the hop and the name=value pairs for a request', () => {
    const jar = jarFromCookies(['a=1; Path=/', 'b=2; HttpOnly']);

    expect(emittedCookies(jar)).toEqual(['a=1; Path=/', 'b=2; HttpOnly']);
    expect(cookieHeader(jar.values)).toBe('a=1; b=2');
  });
});

describe('pathOf', () => {
  it('keeps the path and query of an absolute Location on the public origin', () => {
    expect(pathOf(`${base}/web/index.php/dashboard/index?x=1`, base)).toBe(
      '/web/index.php/dashboard/index?x=1',
    );
  });

  it('keeps a relative path as it stands', () => {
    expect(pathOf('/web/index.php/auth/login', base)).toBe('/web/index.php/auth/login');
  });

  it('falls back to the raw value when the public origin itself cannot be parsed', () => {
    // A path still resolves the way the caller expects: only the base is unusable.
    expect(pathOf('/login', 'not a url')).toBe('/login');
    // And a value that is neither a URL nor rooted is at least rooted.
    expect(pathOf('login', 'not a url')).toBe('/login');
  });
});

describe('absolute', () => {
  it('rewrites a public absolute URL onto the internal origin', () => {
    expect(absolute(`${base}/web/index.php/auth/login`, 'http://orangehrm:80')).toBe(
      'http://orangehrm:80/web/index.php/auth/login',
    );
    expect(absolute('/login', 'http://orangehrm:80')).toBe('http://orangehrm:80/login');
  });

  it('roots a bare path when the origin cannot be parsed', () => {
    expect(absolute('/login', 'not a url')).toBe('not a url/login');
    expect(absolute('login', 'not a url')).toBe('not a url/login');
  });
});

describe('text and messageOf', () => {
  it('treats an unreadable body as empty rather than as a thrown error', async () => {
    const broken = {
      text: () => Promise.reject(new Error('stream reset')),
    } as unknown as Response;

    await expect(text(broken)).resolves.toBe('');
  });

  it('renders a thrown value that is not an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf('boom')).toBe('boom');
    expect(messageOf(undefined)).toBe('undefined');
  });
});
