import { describe, expect, it } from 'vitest';
import { signInPathFor } from '../../src/sign-in-copy';

/**
 * The dialog prints this sentence next to the product the person is about to trust. A generic
 * promise printed for a product that behaves differently is exactly the defect the table exists
 * to prevent, so both the generic shapes and the two overrides are pinned.
 */
describe('signInPathFor', () => {
  it('uses the generic sentence for a product with no override', () => {
    expect(signInPathFor('D3', 'forwarded').clicks).toBe(0);
    expect(signInPathFor('D3', 'forwarded').note).toMatch(/forwards the authenticated session/);

    expect(signInPathFor('D3', 'native-oidc').clicks).toBe(1);
    expect(signInPathFor('D3', 'native-oidc').note).toMatch(/one redirect/);

    expect(signInPathFor('D3', 'local').clicks).toBe(1);
    expect(signInPathFor('D3', 'local').note).toMatch(/own credential/);
  });

  it('describes EspoCRM’s popup flow rather than a single redirect', () => {
    const path = signInPathFor('D1', 'native-oidc');

    expect(path.clicks).toBe(2);
    expect(path.note).toMatch(/EspoCRM shows its own "Sign in" card/);
    // The other shapes for the same entry still fall back to the generic copy.
    expect(signInPathFor('D1', 'local')).toEqual(signInPathFor('D3', 'local'));
  });

  it('describes OpenProject’s Enterprise-only SSO in both current and future shapes', () => {
    const local = signInPathFor('D9', 'local');
    expect(local.clicks).toBe(2);
    // ADR-BE-22: the platform does hold this credential, so the sentence may not claim otherwise.
    expect(local.note).not.toMatch(/does not hold/);
    expect(local.note).toMatch(/does not ask for a second password/);
    expect(local.note).toMatch(/rotated monthly/);

    const native = signInPathFor('D9', 'native-oidc');
    expect(native.clicks).toBe(2);
    expect(native.note).toMatch(/Sign in with Keycloak/);

    expect(signInPathFor('D9', 'forwarded')).toEqual(signInPathFor('D3', 'forwarded'));
  });

  it('describes OrangeHRM as a relayed product, not one with an outside credential', () => {
    const local = signInPathFor('D7', 'local');
    expect(local.clicks).toBe(2);
    // The generic sentence says the platform never stores the credential. For a relayed entry that
    // is false, and it is the sentence a person reads before trusting the tile.
    expect(local.note).not.toMatch(/never stores|provisioned outside/);
    expect(local.note).toMatch(/does not ask for a second password/);
    // The two facts specific to HR: the account is not an administrator, and it is an employee record.
    expect(local.note).toMatch(/non-administrative/);
    expect(local.note).toMatch(/rotated monthly/);
    expect(signInPathFor('D07-01', 'local')).toEqual(local);
    expect(signInPathFor('D7', 'forwarded')).toEqual(signInPathFor('D3', 'forwarded'));
  });

  /*
   * A live `instance.entry_key` carries the composed grammar (`D09-01`, ADR-BE-20) while this table
   * is written in the legacy one (`D9`). Keying the lookup on the raw string printed the generic
   * "provisioned outside the platform" sentence for OpenProject on the dev stack — the exact
   * sentence ADR-BE-22 says becomes false — and this suite passed because it asked with `D9`.
   */
  it('applies an override to every published spelling of the key', () => {
    expect(signInPathFor('D09-01', 'local')).toEqual(signInPathFor('D9', 'local'));
    expect(signInPathFor('D09-01', 'local').note).toMatch(/does not ask for a second password/);
    expect(signInPathFor('D01-01', 'native-oidc')).toEqual(signInPathFor('D1', 'native-oidc'));
    // The other way round: a composed key the table does not override keeps the generic sentence.
    expect(signInPathFor('D03-01', 'local')).toEqual(signInPathFor('D3', 'local'));
  });

  it('falls back for an entry the table does not know', () => {
    expect(signInPathFor('D99', 'local')).toEqual(signInPathFor('D3', 'local'));
  });
});
