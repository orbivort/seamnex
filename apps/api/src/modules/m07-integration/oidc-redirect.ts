import { resolveKey } from '@seamnex/domain';

/**
 * 4D.1 — the address the identity provider calls back on.
 *
 * Keycloak compares `redirect_uri` byte for byte, so this string exists in three places that must
 * agree: the client registration, the product's own configuration (`siteUrl` + its callback path),
 * and the browser. One function builds it, so they cannot drift.
 *
 * Two things the previous hardcoded pair got wrong:
 *   - EspoCRM calls back on `/oauth-callback.php`, not `/oauth2/callback`. Keycloak answered
 *     `invalid_redirect_uri` and the product's OIDC login could never complete, however correct the
 *     rest of the configuration was.
 *   - Scheme and port belong to the edge, not to the product. The dev edge terminates TLS on :8443,
 *     so a hardcoded `https://<host>` named a port nothing listens on.
 */

export type ProductUrlScheme = 'http' | 'https';

/*
 * Every table below is keyed by the catalogue entry *identity* (`D01-01`), not by the pre-ADR-BE-20
 * shorthand (`D1`). `instance.entry_key` carries the composed key, so a table keyed with the legacy
 * spelling never matched at runtime: EspoCRM fell through to the platform convention
 * (`/oauth2/callback`), the client was registered on a URI the product never serves, and Keycloak
 * answered the first login with `Invalid parameter: redirect_uri`. The lookups resolve the key first
 * so an environment file that still carries `D1` keeps working (the alias table is frozen for that).
 */

/** Paths a product expects the IdP to call back on, keyed by catalogue entry. */
const OIDC_CALLBACK_PATHS: Readonly<Record<string, string>> = {
  // EspoCRM's OIDC entry point (`/application/Espo/EntryPoints/OauthCallback.php`). The product
  // derives this URI from its own `siteUrl` and shows it read-only in Administration → Authentication.
  'D01-01': '/oauth-callback.php',
  /*
   * OpenProject: `<root>/auth/<provider>/callback`, from `AuthProvider#callback_url` in the image.
   * The provider is seeded as `keycloak` (ADR-BE-15), so the segment is fixed before an instance
   * exists and the registration no longer points at `/oauth2/callback`, a path OpenProject never
   * serves — measured on 17.9.6, where `seamnex-projects` held that URI and could never have completed
   * a login with it.
   *
   * The URI is a property of the product, not of the edition. Native OIDC on OpenProject needs an
   * Enterprise token (`sso_auth_providers`); until the entry's class flips to `native`, the client
   * this URI is registered on is unused, and the back-channel endpoint stays unregistered because
   * an endpoint that answers 404 is not revocation support.
   */
  'D09-01': '/auth/keycloak/callback',
  /*
   * ERPNext (Frappe): the browser returns to a whitelisted *method*, and the method name is the
   * provider's, not the record's. `social_login_provider = Keycloak` has its own entry point
   * (`frappe/integrations/oauth2_logins.py#login_via_keycloak`, v16), unlike a `Custom` provider,
   * which Frappe routes through `oauth2_logins.custom/<Social Login Key name>`.
   *
   * Frappe is also the one product here that sends back the value *it* stores: `Social Login Key
   * .redirect_url` is passed as `redirect_uri` on both the authorize and the token request
   * (`frappe/utils/oauth.py#get_redirect_uri`). The first boot writes that field as
   * `<ERPNEXT_SITE_ORIGIN>` + this path, so the two halves of the byte-for-byte comparison are
   * built from the same origin and the same literal.
   */
  'D06-01': '/api/method/frappe.integrations.oauth2_logins.login_via_keycloak',
};

/** Default for an entry with no declared path: the convention used by the platform's own scaffolds. */
export const DEFAULT_OIDC_CALLBACK_PATH = '/oauth2/callback';

/** SAML's assertion consumer service. One endpoint for every product until an adapter says otherwise. */
export const SAML_CALLBACK_PATH = '/saml/consume';

/** Back-channel logout endpoints, where the product implements OIDC back-channel logout. */
const BACKCHANNEL_LOGOUT_PATHS: Readonly<Record<string, string>> = {
  // EspoCRM: `POST /api/v1/Oidc/action/backchannelLogout`.
  'D01-01': '/api/v1/Oidc/action/backchannelLogout',
};

/**
 * The product's own sign-in page, and the literal that page carries only when it offers the identity
 * provider.
 *
 * The platform's login check drives the identity-provider side of the flow, and every stage of that can
 * pass while the product is not configured at all: ERPNext was deployed with a registered Keycloak
 * client, a successful code exchange, and no `Social Login Key` on the site, so its sign-in page showed
 * a password form and nothing else while the portal reported "single sign-on". Only an entry whose
 * product renders the provider on a page of its own declares one here — the marker is the callback path
 * the client was registered on, which is what Frappe puts in the button's `redirect_uri`.
 */
const SIGN_IN_PAGES: Readonly<Record<string, { readonly path: string; readonly marker: string }>> =
  {
    'D06-01': {
      path: '/login',
      // `frappe/www/login.html` renders `<a href="{{ provider.auth_url }}">`, and that URL carries
      // `redirect_uri=<origin>/api/method/frappe.integrations.oauth2_logins.login_via_keycloak`,
      // percent-encoded. The method name survives encoding unchanged, the slashes around it do not,
      // which is why the marker stops at the method name.
      marker: 'login_via_keycloak',
    },
  };

export function signInPageFor(
  entryKey: string,
): { readonly path: string; readonly marker: string } | null {
  return SIGN_IN_PAGES[resolveKey(entryKey)] ?? null;
}

/**
 * The instance environment variable that carries this product's OIDC client secret.
 *
 * The secret exists twice by design — once in Keycloak, once in the product — and both must be the
 * same value. The operator sets it once through the environment surface (it lands in the secret
 * store); the identity registration then reuses that value instead of generating a second one the
 * product could never present.
 */
const OIDC_SECRET_VARIABLES: Readonly<Record<string, string>> = {
  'D01-01': 'ESPOCRM_CONFIG_OIDC_CLIENT_SECRET',
  // ERPNext: read by the first boot, which writes it into the site's `Social Login Key` row. Left
  // empty in the plan, so `registerIdentity` mints one and writes it back as the applied value.
  'D06-01': 'ERPNEXT_SSO_CLIENT_SECRET',
};

/**
 * The ID-token claim a product is configured to require, when it declares one.
 *
 * EspoCRM asks for `groups` as an *essential* claim and maps it with `oidcGroupClaim`. The platform
 * registers the client, so it owns the other half of that contract: a client with no scope that
 * mints the claim produces a token the product cannot use for group or team mapping, and nothing in
 * the registration previously said so.
 */
const OIDC_GROUP_CLAIMS: Readonly<Record<string, string>> = {
  'D01-01': 'groups',
};

export function oidcGroupClaimFor(entryKey: string): string | null {
  return OIDC_GROUP_CLAIMS[resolveKey(entryKey)] ?? null;
}

export function oidcSecretVariableFor(entryKey: string): string | null {
  return OIDC_SECRET_VARIABLES[resolveKey(entryKey)] ?? null;
}

/** `scheme://host` with the edge's port only when the edge publishes one. */
export function publicBaseUrl(scheme: ProductUrlScheme, host: string, port: string): string {
  return `${scheme}://${host}${port === '' ? '' : `:${port}`}`;
}

export function callbackPathFor(entryKey: string, protocol: 'oidc' | 'saml'): string {
  if (protocol === 'saml') return SAML_CALLBACK_PATH;
  return OIDC_CALLBACK_PATHS[resolveKey(entryKey)] ?? DEFAULT_OIDC_CALLBACK_PATH;
}

export function redirectUriFor(input: {
  readonly entryKey: string;
  readonly protocol: 'oidc' | 'saml';
  readonly baseUrl: string;
}): string {
  return `${input.baseUrl}${callbackPathFor(input.entryKey, input.protocol)}`;
}

/**
 * `null` when the product has no back-channel endpoint. Registering a URL that answers 404 would
 * look like revocation support and silently never revoke anything.
 */
export function backchannelLogoutUrlFor(entryKey: string, baseUrl: string): string | null {
  const path = BACKCHANNEL_LOGOUT_PATHS[resolveKey(entryKey)];
  return path === undefined ? null : `${baseUrl}${path}`;
}
