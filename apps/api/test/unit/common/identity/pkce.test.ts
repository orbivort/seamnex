import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assertPkce, challengeFor } from '../../../../src/common/identity/pkce';
import { AppError } from '../../../../src/common/problem/app-error';

describe('PKCE S256', () => {
  it('derives the base64url SHA-256 challenge RFC 7636 specifies', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    // The RFC 7636 Appendix B vector.
    expect(challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is deterministic and differs per verifier', () => {
    expect(challengeFor('a')).toBe(challengeFor('a'));
    expect(challengeFor('a')).not.toBe(challengeFor('b'));
    expect(challengeFor('')).toBe(createHash('sha256').update('').digest('base64url'));
  });

  it('accepts the matching challenge', () => {
    const verifier = 'verifier-value';
    expect(() => assertPkce(verifier, challengeFor(verifier))).not.toThrow();
  });

  it('refuses a challenge produced by another verifier', () => {
    let error: unknown;
    try {
      assertPkce('verifier', challengeFor('other'));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('UNAUTHORIZED');
  });

  it('refuses a challenge of the wrong length without leaking which side was shorter', () => {
    expect(() => assertPkce('verifier', 'short')).toThrow(AppError);
    expect(() => assertPkce('verifier', '')).toThrow(AppError);
    expect(() => assertPkce('verifier', `${challengeFor('verifier')}x`)).toThrow(AppError);
  });
});
