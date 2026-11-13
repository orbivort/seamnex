import { describe, expect, it } from 'vitest';
import { mapIdTokenClaims } from '../../../../../src/common/identity/oidc/claims';

/**
 * The mapping is where a provider's vocabulary becomes the platform's. Every case here is a
 * decision an operator can read: which role wins, what a bare group name means, and — most of all —
 * that a missing `amr` is not silently upgraded into "a second factor was used".
 */
const base = {
  sub: 'ceb72438-1b20-4045-8adc-afe72efe6db0',
  preferred_username: 'dev-owner',
  name: 'Revenue Owner',
  email: 'dev-owner@seamnex.local',
  realm_access: { roles: ['R3', 'default-roles-seamnex', 'offline_access', 'uma_authorization'] },
  groups: ['/seamnex-domain-owners', '/seamnex-domains/revenue-customer'],
  amr: ['pwd'],
};

describe('ID token claim mapping', () => {
  it('keeps only platform roles, in privilege order', () => {
    const claims = mapIdTokenClaims({
      ...base,
      realm_access: { roles: ['R5', 'R1', 'offline_access'] },
    });
    expect(claims.roles).toEqual(['R1', 'R5']);
  });

  it('refuses an identity the provider asserted no platform role for', () => {
    expect(() =>
      mapIdTokenClaims({
        ...base,
        realm_access: { roles: ['offline_access', 'uma_authorization'] },
      }),
    ).toThrowError(/no platform role/);
  });

  it('refuses a subject with no realm_access at all', () => {
    expect(() => mapIdTokenClaims({ ...base, realm_access: undefined })).toThrowError(
      /no platform role/,
    );
  });

  it('normalises group names to full paths and removes duplicates', () => {
    const claims = mapIdTokenClaims({
      ...base,
      groups: ['seamnex-users', '/seamnex-users', '/seamnex-domains/core'],
    });
    expect(claims.groups).toEqual(['/seamnex-domains/core', '/seamnex-users']);
  });

  it('reads a password-only assertion as single factor, and marks it as asserted', () => {
    const claims = mapIdTokenClaims(base);
    expect(claims.mfaSatisfied).toBe(false);
    expect(claims.mfaMethod).toBe('none');
    // The provider *did* say how the user authenticated, which is what lets the gate refuse.
    expect(claims.mfaAsserted).toBe(true);
  });

  it('treats an absent or empty `amr` as "not asserted" rather than "password only"', () => {
    // Keycloak 26 emits `amr: []` unless the realm maps authentication methods; reading that as a
    // single-factor session would refuse every administrator in a correctly configured realm.
    for (const amr of [[], undefined]) {
      const claims = mapIdTokenClaims({ ...base, amr });
      expect(claims.mfaSatisfied).toBe(false);
      expect(claims.mfaAsserted).toBe(false);
    }
  });

  it('recognises the second-factor methods the realm can assert', () => {
    const totp = mapIdTokenClaims({ ...base, amr: ['pwd', 'otp'] });
    expect(totp.mfaSatisfied).toBe(true);
    expect(totp.mfaMethod).toBe('totp');

    const webauthn = mapIdTokenClaims({ ...base, amr: ['pwd', 'hwk'] });
    expect(webauthn.mfaMethod).toBe('webauthn');

    const sms = mapIdTokenClaims({ ...base, amr: ['pwd', 'sms'] });
    expect(sms.mfaMethod).toBe('totp');
  });

  it('falls back through the display-name and email claims without inventing values', () => {
    const nameOnly = mapIdTokenClaims({
      ...base,
      name: undefined,
      given_name: 'Revenue',
      family_name: 'Owner',
    });
    expect(nameOnly.displayName).toBe('Revenue Owner');

    const bare = mapIdTokenClaims({
      ...base,
      name: undefined,
      given_name: undefined,
      family_name: undefined,
    });
    expect(bare.displayName).toBe('dev-owner');

    const noEmail = mapIdTokenClaims({ ...base, email: undefined });
    expect(noEmail.email).toBe('');
  });

  it('does not derive the guest instance scope from a group name', () => {
    // A group carries a slug; the session field is an instance UUID. Translating one into the other
    // by name would let a group rename move a guest to another product.
    const guest = mapIdTokenClaims({
      ...base,
      groups: ['/seamnex-instances/finance-suite'],
      realm_access: { roles: ['R6'] },
    });
    expect(guest.roles).toEqual(['R6']);
    expect(guest.instanceId).toBeNull();
  });

  it('refuses a token with no subject', () => {
    expect(() => mapIdTokenClaims({ ...base, sub: '' })).toThrowError(/not accepted/);
  });
});
