import { describe, expect, it } from 'vitest';
import {
  MASK,
  containsCanary,
  maskDeep,
  maskText,
  maskValue,
} from '../../../../src/common/logging/masking';

const CANARY = 'seamnex-canary-2f8c1d9e-must-never-appear';

describe('mask by default', () => {
  it('masks sensitive keys at any depth', () => {
    const masked = maskDeep({
      instance: 'i-1',
      password: CANARY,
      nested: { clientSecret: CANARY, list: [{ token: CANARY }] },
    });

    const rendered = JSON.stringify(masked);
    expect(rendered).not.toContain(CANARY);
    expect(masked.instance).toBe('i-1');
    expect(masked.nested.list[0]?.token).toBe(MASK);
  });

  it('masks a bearer token even under an innocent key', () => {
    expect(maskValue(`Bearer ${CANARY}`)).toBe(MASK);
    expect(maskValue('plain text')).toBe('plain text');
  });

  it('survives cycles and deep structures instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => maskDeep(cyclic)).not.toThrow();

    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let index = 0; index < 20; index += 1) deep = { nested: deep };
    expect(() => maskDeep(deep)).not.toThrow();
  });

  it('detects a leaked canary in rendered output', () => {
    const line = `job log ${CANARY} emitted`;
    expect(containsCanary(line, CANARY)).toBe(true);
    expect(containsCanary(JSON.stringify(maskDeep({ secret: CANARY })), CANARY)).toBe(false);
    expect(containsCanary('anything', '')).toBe(false);
  });

  it('leaves scalars, dates and buffers as the values a logger can render', () => {
    expect(maskDeep(42)).toBe(42);
    expect(maskDeep(true)).toBe(true);
    expect(maskDeep(10n)).toBe(10n);
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(maskDeep(date)).toBe(date);
    expect(maskDeep(Buffer.from(CANARY))).toBe(MASK);
  });

  it('passes null and undefined through', () => {
    expect(maskDeep(null)).toBeNull();
    expect(maskDeep(undefined)).toBeUndefined();
  });

  it('masks a key that names a credential in any casing or separator', () => {
    const masked = maskDeep({
      apiKey: 'a',
      'api-key': 'b',
      private_key: 'c',
      hmac: 'd',
      cookie: 'e',
      csrf: 'f',
      authorization: 'g',
      credential: 'h',
      passwd: 'i',
      session_id: 'j',
      'session-id': 'k',
    });
    for (const value of Object.values(masked)) expect(value).toBe(MASK);
  });

  it('redacts an inline assignment in free text', () => {
    expect(maskText('client_secret=abc123 rest')).toBe(`client_secret=${MASK} rest`);
    expect(maskText('token: plain')).toBe(`token: ${MASK}`);
    expect(maskText('api-key=abc; next')).toBe(`api-key=${MASK}; next`);
    expect(maskText('nothing to redact')).toBe('nothing to redact');
  });

  it('masks a JWT even under an innocent key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-part';
    expect(maskValue(jwt)).toBe(MASK);
    expect(maskValue('Basic dXNlcjpwYXNz')).toBe(MASK);
  });

  it('replaces the output of a structure deeper than the limit with a placeholder', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 12; index += 1) deep = { nested: deep };
    expect(JSON.stringify(maskDeep(deep))).toContain('[depth-limit]');
  });

  it('returns a placeholder for a repeated object rather than recursing forever', () => {
    const shared = { value: 'x' };
    const masked = maskDeep({ first: shared, second: shared });
    expect(masked).toEqual({ first: { value: 'x' }, second: '[circular]' });
  });

  it('masks an array of credentials element by element', () => {
    expect(maskDeep([CANARY, { token: CANARY }])).toEqual([CANARY, { token: MASK }]);
  });

  it('passes a function or a symbol through rather than mistaking it for an object', () => {
    const fn = () => undefined;
    const symbol = Symbol('s');
    expect(maskDeep(fn)).toBe(fn);
    expect(maskDeep(symbol)).toBe(symbol);
  });
});
