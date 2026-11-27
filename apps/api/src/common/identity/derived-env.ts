/**
 * Environment values that are a property of *this instance*, not of the product.
 *
 * A catalog default describes the deployment an entry was verified against — for D1 that is
 * `https://espocrm.seamnex.localhost:8443` and the client `seamnex-espocrm`. Both are correct for
 * exactly one instance.
 * A second instance of the same entry inherits them and then fails at the identity provider: the
 * product derives its redirect URI from its `siteUrl`, the platform registers the client against the
 * instance's own route, and Keycloak refuses the authorization request with `invalid_redirect_uri`
 * before a code is ever issued. The operator sees an error page from the IdP with no way back.
 *
 * The renderer cannot express this: `defaultValue` is a literal, and it is resolved before an
 * instance — and therefore a slug and a host — exists. So the two values that are a function of the
 * instance are derived here, after the slug is known and before the values are stored, and the
 * operator's explicit override still wins over the derived value.
 *
 * Keyed by entry because the *variable names* are the product's, not the platform's: an entry that
 * has no such variables declares nothing and gets nothing.
 */

import { resolveKey } from '@seamnex/domain';

export type DerivedEnvContext = {
  readonly entryKey: string;
  readonly slug: string;
  /** The host this instance's route will publish, i.e. `${slug}.${ingressDomain}`. */
  readonly host: string;
  readonly scheme: 'http' | 'https';
  /** The edge's published port, empty when the scheme's default port is used. */
  readonly port: string;
};

type Derivation = (context: DerivedEnvContext) => Record<string, string>;

const DERIVATIONS: Readonly<Record<string, Derivation>> = {
  /**
   * EspoCRM. Both values must follow the instance:
   *   - `siteUrl` is the base of the OIDC redirect URI the *product* sends, so it has to equal the
   *     route the *platform* registers the client against;
   *   - the client id is derived from the slug by `registerIdentity` (`seamnex-<slug>`), so a copied
   *     default points the product at another instance's client.
   *
   * Keyed by the composed entry identity (`D01-01`), which is what `entry.key` carries. The table used
   * to be keyed `D1`, so it never matched and neither value was ever derived: only the catalog
   * defaults (correct for exactly one deployment) applied.
   */
  'D01-01': (context) => ({
    ESPOCRM_SITE_URL: origin(context),
    ESPOCRM_CONFIG_OIDC_CLIENT_ID: `seamnex-${context.slug}`,
  }),

  /**
   * Mautic. Same reasoning as D1: the site URL is the base of every link the product mails out, and
   * the catalog default names one deployment's route.
   */
  'D02-01': (context) => ({ MAUTIC_SITE_URL: origin(context) }),

  /**
   * ERPNext. Two values, because a Frappe site name and the base of the product's absolute URLs are
   * different shapes:
   *   - `ERPNEXT_SITE_NAME` is a *site name* — bare host, no scheme, no port. It is the directory
   *     `sites/<name>`, the argument to `bench new-site` and nginx's `server_name`, so a URL there
   *     fails the first boot instead of producing a site;
   *   - `ERPNEXT_SITE_ORIGIN` is what `host_name` carries, and `host_name` is the base of every link
   *     the product prints. It has to be the origin a browser can follow — the route's scheme and,
   *     when the edge publishes a non-default one, its port. Deriving it from the site name is what
   *     produced `http://<site>` on an edge serving `https` on `:8443`: a reset link nobody could open.
   *
   * The SSO client id is derived for the same reason as EspoCRM's: `registerIdentity` names the
   * Keycloak client `seamnex-<slug>`, and the site's `Social Login Key` has to present that id. A
   * copied default would point one instance at another instance's client — the registration would
   * succeed and the first login would fail with `invalid_client`.
   */
  'D06-01': (context) => ({
    ERPNEXT_SITE_NAME: context.host,
    ERPNEXT_SITE_ORIGIN: origin(context),
    ERPNEXT_SSO_CLIENT_ID: `seamnex-${context.slug}`,
  }),

  /**
   * OpenProject. `OPENPROJECT_HOST__NAME` is copied into Rails' `config.hosts` and Apache's
   * `ServerName`, and the platform's relay reaches the product by container alias with the *public*
   * host in the `Host` header. A catalog default that disagrees with the route is therefore not a
   * cosmetic mismatch: Apache answers its `_default_` vhost with `404`, the administrator token
   * cannot be derived, and automated sign-in fails with `product_unavailable`. Both names have to
   * move together — separate them and the vhost and Rails disagree.
   */
  'D09-01': (context) => ({
    OPENPROJECT_HOST__NAME: context.host,
    SERVER_NAME: context.host,
  }),

  /**
   * Metabase. Links it generates (password resets, subscriptions, alerts) come from this base, so a
   * stale value surfaces days later as a reset link that points at another host.
   */
  'D11-01': (context) => ({ MB_SITE_URL: origin(context) }),
};

export function derivedEnvValues(context: DerivedEnvContext): Record<string, string> {
  return DERIVATIONS[resolveKey(context.entryKey)]?.(context) ?? {};
}

/**
 * Values that have to be stored *beside* another one, because the entry applies them on a different
 * schedule than the variable that is actually derived.
 *
 * D1 is the case in the field. `ESPOCRM_SITE_URL` is read by the image's install action only, so a
 * product keeps the `siteUrl` written on the day it was installed; after the instance moved to
 * another scheme, host or port it goes on sending the previous `redirect_uri`, and Keycloak answers
 * the popup with `invalid_redirect_uri` — signing in cannot complete, however correct the client
 * registration and the route are. The same image applies every `ESPOCRM_CONFIG_*` variable through
 * `bin/command config:set` on *every* start (`applyConfigEnv`), which is the channel that carries a
 * route change into a running instance.
 *
 * The mirror is taken from the effective value — after the operator's override was merged — so an
 * address someone set on purpose is not silently replaced by the derived one. It is applied wherever
 * the environment is written, so the two cannot drift through a partial update either.
 */
const MIRRORS: Readonly<Record<string, readonly { from: string; to: string }[]>> = {
  'D01-01': [{ from: 'ESPOCRM_SITE_URL', to: 'ESPOCRM_CONFIG_SITE_URL' }],
};

export function mirroredEnvValues(
  entryKey: string,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const mirrors = MIRRORS[resolveKey(entryKey)] ?? [];
  const mirrored: Record<string, string> = { ...values };
  for (const mirror of mirrors) {
    const source = values[mirror.from];
    if (source === undefined || source === '') continue;
    mirrored[mirror.to] = source;
  }
  return mirrored;
}

/** `scheme://host[:port]`, with no trailing slash — the shape the product compares against. */
export function origin(context: Pick<DerivedEnvContext, 'scheme' | 'host' | 'port'>): string {
  return `${context.scheme}://${context.host}${context.port === '' ? '' : `:${context.port}`}`;
}
