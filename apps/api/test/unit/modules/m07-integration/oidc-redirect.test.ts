import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OIDC_CALLBACK_PATH,
  SAML_CALLBACK_PATH,
  backchannelLogoutUrlFor,
  callbackPathFor,
  oidcGroupClaimFor,
  oidcSecretVariableFor,
  publicBaseUrl,
  redirectUriFor,
} from '../../../../src/modules/m07-integration/oidc-redirect';

/**
 * The redirect URI is the one string that must agree in three places (Keycloak, the product's
 * `siteUrl`-derived configuration, and the browser). These tests pin the two facts that were wrong
 * in the field: EspoCRM's callback path, and the edge's scheme/port rather than an assumed https.
 */
describe('product callback addresses (4D.1)', () => {
  it('uses the product’s own callback path, not the platform convention', () => {
    expect(callbackPathFor('D01-01', 'oidc')).toBe('/oauth-callback.php');
    // OpenProject routes the callback through the provider slug (`AuthProvider#callback_url`). The
    // entry used to fall through to `/oauth2/callback`, which the product never serves: `seamnex-projects`
    // held that URI and could not have completed a login with it.
    expect(callbackPathFor('D09-01', 'oidc')).toBe('/auth/keycloak/callback');
    // A product with no declared path keeps the documented convention. Inventing a path per entry
    // would be a guess the IdP rejects with invalid_redirect_uri at the first login.
    expect(callbackPathFor('D11-01', 'oidc')).toBe(DEFAULT_OIDC_CALLBACK_PATH);
    expect(callbackPathFor('D01-01', 'saml')).toBe(SAML_CALLBACK_PATH);
  });

  it('resolves the pre-rename shorthand to the same entry', () => {
    // `instance.entry_key` carries the composed key, which is why the tables are keyed that way; the
    // frozen alias table keeps an environment file that still says `D1` working.
    for (const [legacy, composed] of [
      ['D01-01', 'D01-01'],
      ['D09-01', 'D09-01'],
      ['D11-01', 'D11-01'],
    ] as const) {
      expect(callbackPathFor(legacy, 'oidc')).toBe(callbackPathFor(composed, 'oidc'));
      expect(oidcSecretVariableFor(legacy)).toBe(oidcSecretVariableFor(composed));
      expect(oidcGroupClaimFor(legacy)).toBe(oidcGroupClaimFor(composed));
    }
  });

  it('puts the edge’s port in the base URL only when the edge publishes one', () => {
    expect(publicBaseUrl('http', 'crm.seamnex.local', '8020')).toBe(
      'http://crm.seamnex.local:8020',
    );
    expect(publicBaseUrl('https', 'crm.seamnex.local', '')).toBe('https://crm.seamnex.local');
  });

  it('builds the exact URI the product derives from its own site URL', () => {
    const baseUrl = publicBaseUrl('http', 'crm.seamnex.local', '8020');
    expect(redirectUriFor({ entryKey: 'D01-01', protocol: 'oidc', baseUrl })).toBe(
      'http://crm.seamnex.local:8020/oauth-callback.php',
    );
    // Production shape: TLS on 443, no port, same path.
    expect(
      redirectUriFor({
        entryKey: 'D01-01',
        protocol: 'oidc',
        baseUrl: publicBaseUrl('https', 'crm.seamnex.local', ''),
      }),
    ).toBe('https://crm.seamnex.local/oauth-callback.php');
  });

  it('names the product’s own secret variable, and none when it declares no convention', () => {
    // The secret is written twice by design — Keycloak and the product — and both must be the same
    // value, so the registration reuses the variable the environment surface already set.
    expect(oidcSecretVariableFor('D01-01')).toBe('ESPOCRM_CONFIG_OIDC_CLIENT_SECRET');
    expect(oidcSecretVariableFor('D11-01')).toBeNull();
  });

  it('declares the ID-token claim a product requires, and null when it declares none', () => {
    // EspoCRM asks for `groups` as an essential claim; without a scope that mints it the product
    // receives a token it cannot use for group mapping.
    expect(oidcGroupClaimFor('D01-01')).toBe('groups');
    expect(oidcGroupClaimFor('D09-01')).toBeNull();
  });

  it('registers a back-channel logout endpoint only where the product has one', () => {
    const baseUrl = 'http://crm.seamnex.local:8020';
    expect(backchannelLogoutUrlFor('D01-01', baseUrl)).toBe(
      'http://crm.seamnex.local:8020/api/v1/Oidc/action/backchannelLogout',
    );
    // No endpoint means no registration: a URL that answers 404 would look like revocation support.
    // OpenProject does expose `/auth/<provider>/backchannel-logout`, but only behind the same
    // Enterprise gate as the strategy (ADR-BE-15), so it is registered with the flip to `native`.
    expect(backchannelLogoutUrlFor('D09-01', baseUrl)).toBeNull();
  });
});
