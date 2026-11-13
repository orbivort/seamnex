import { describe, expect, it } from 'vitest';
import { mapIdTokenClaims } from '../../../../../src/common/identity/oidc/claims';

/**
 * `preferred_username` is optional in OIDC, so the platform's username is a fallback chain:
 * preferred username, then the local part of the email, then the subject. The chain is asserted
 * here because the value it produces is what `noPlatformRole` quotes in a 403 and what the console
 * renders — an empty username is a person who cannot be identified in a support ticket.
 */
const SUBJECT = 'ceb72438-1b20-4045-8adc-afe72efe6db0';

function token(claims: Record<string, unknown>): Record<string, unknown> {
  return {
    sub: SUBJECT,
    name: 'Revenue Owner',
    realm_access: { roles: ['R3'] },
    ...claims,
  };
}

describe('username derivation', () => {
  it('prefers preferred_username when the provider sends one', () => {
    const claims = mapIdTokenClaims(
      token({ preferred_username: 'dev-owner', email: 'someone-else@seamnex.local' }),
    );

    expect(claims.username).toBe('dev-owner');
  });

  it('falls back to the local part of the email', () => {
    const claims = mapIdTokenClaims(token({ email: 'dev-owner@seamnex.local' }));

    expect(claims.username).toBe('dev-owner');
  });

  it('takes the local part only, even when the address carries more than one @', () => {
    const claims = mapIdTokenClaims(token({ email: 'release+seamnex@example.test@relay.test' }));

    expect(claims.username).toBe('release+seamnex');
  });

  it('falls back to the subject when neither claim is present', () => {
    const claims = mapIdTokenClaims(token({}));

    expect(claims.username).toBe(SUBJECT);
  });

  it('treats a blank preferred_username as absent instead of rendering an empty name', () => {
    const claims = mapIdTokenClaims(
      token({ preferred_username: '   ', email: 'dev-owner@seamnex.local' }),
    );

    expect(claims.username).toBe('dev-owner');
  });

  it('quotes the derived username in the refusal for an identity with no platform role', () => {
    expect(() =>
      mapIdTokenClaims(token({ email: 'auditor@seamnex.local', realm_access: {} })),
    ).toThrow(/no platform role for "auditor"/);
  });
});

describe('claims that arrive in another type', () => {
  it('ignores a preferred_username that is not a string', () => {
    const claims = mapIdTokenClaims(
      token({ preferred_username: 42, email: 'dev-owner@seamnex.local' }),
    );

    expect(claims.username).toBe('dev-owner');
  });

  it('ignores a non-string group entry and keeps the usable ones', () => {
    const claims = mapIdTokenClaims(token({ groups: ['/seamnex-users', 7, null] }));

    expect(claims.groups).toEqual(['/seamnex-users']);
  });

  it('reads a second factor from a mixed-case amr', () => {
    const claims = mapIdTokenClaims(token({ amr: ['PWD', 'OTP'] }));

    expect(claims.mfaMethod).toBe('totp');
    expect(claims.mfaSatisfied).toBe(true);
    expect(claims.amr).toEqual(['pwd', 'otp']);
  });

  it('names no display name when only a whitespace name was asserted', () => {
    const claims = mapIdTokenClaims(token({ name: '   ', preferred_username: 'dev-owner' }));

    expect(claims.displayName).toBe('dev-owner');
  });
});
