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
 *   - Scheme and port belong to the edge, not to the product. The dev edge serves plain HTTP on
 *     :8020, so a hardcoded `https://<host>` named a port nothing listens on.
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
 * The instance environment variable that carries this product's OIDC client secret.
 *
 * The secret exists twice by design — once in Keycloak, once in the product — and both must be the
 * same value. The operator sets it once through the environment surface (it lands in the secret
 * store); the identity registration then reuses that value instead of generating a second one the
 * product could never present.
 */
const OIDC_SECRET_VARIABLES: Readonly<Record<string, string>> = {
  'D01-01': 'ESPOCRM_CONFIG_OIDC_CLIENT_SECRET',
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
