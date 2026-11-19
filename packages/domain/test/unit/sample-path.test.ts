import { describe, expect, it } from 'vitest';
import { pathSegments, resolvesPath } from '../../src/sample-path';

/**
 * FR-5.5 — the question validation asks of a stored item: does this mapping's path exist here?
 *
 * The paths come from the sample parser (`_embedded.elements[0].subject`, `["first name"]`), and the
 * answer decides whether an issue is an error that blocks activation or advice that does not.
 */
describe('pathSegments', () => {
  it('reads a dotted path', () => {
    expect(pathSegments('contact.email')).toEqual(['contact', 'email']);
  });

  it('reads an index inside a path', () => {
    expect(pathSegments('_embedded.elements[0].subject')).toEqual([
      '_embedded',
      'elements',
      0,
      'subject',
    ]);
  });

  it('reads a quoted key, including the dots inside it', () => {
    expect(pathSegments('["first name"]')).toEqual(['first name']);
    expect(pathSegments('a["odd.key"]')).toEqual(['a', 'odd.key']);
  });

  it('refuses text that is not a path, rather than guessing at it', () => {
    expect(pathSegments('$json.contact.email + 1')).toBeNull();
    expect(pathSegments('a[')).toBeNull();
    expect(pathSegments('a[b]')).toBeNull();
  });
});

describe('resolvesPath', () => {
  const item = {
    contact: { email: 'someone@example.com', phone: null },
    _embedded: { elements: [{ subject: 'Fix the roof' }] },
    'first name': 'Ada',
  };

  it('finds a nested value', () => {
    expect(resolvesPath(item, 'contact.email')).toBe(true);
  });

  it('counts a null value as present: the field exists, its value is empty', () => {
    expect(resolvesPath(item, 'contact.phone')).toBe(true);
  });

  it('finds an element of an array', () => {
    expect(resolvesPath(item, '_embedded.elements[0].subject')).toBe(true);
  });

  it('finds a quoted key', () => {
    expect(resolvesPath(item, '["first name"]')).toBe(true);
  });

  it('says no when the key is absent', () => {
    // The live failure: four paths read from a collection envelope ("subject", "budget", …).
    expect(resolvesPath(item, 'subject')).toBe(false);
  });

  it('says no when the index is past the end', () => {
    expect(resolvesPath(item, '_embedded.elements[3].subject')).toBe(false);
  });

  it('says no when a path walks through a scalar', () => {
    expect(resolvesPath(item, 'contact.email.domain')).toBe(false);
  });

  it('judges a path carrying the prefix it should not, because it really will not resolve', () => {
    // `from` is a bare path; `$json.contact.email` compiles to `$json.$json.contact.email`.
    expect(resolvesPath(item, '$json.contact.email')).toBe(false);
  });

  it('says nothing about text that is not a path at all', () => {
    expect(resolvesPath(item, '$json.contact.email + 1')).toBeNull();
  });
});
