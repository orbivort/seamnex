/**
 * Environment values that are a property of *this instance*, not of the product.
 *
 * A catalog default describes the deployment an entry was verified against — for D1 that is
 * `espocrm.localhost:8020` and the client `seamnex-espocrm`. Both are correct for exactly one instance.
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
   * ERPNext. The value is a Frappe *site name* — bare host, no scheme, no port — and the product
   * builds absolute URLs from it, so it has to be this instance's host and nothing else.
   */
  'D06-01': (context) => ({ ERPNEXT_SITE_NAME: context.host }),

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

/** `scheme://host[:port]`, with no trailing slash — the shape the product compares against. */
export function origin(context: Pick<DerivedEnvContext, 'scheme' | 'host' | 'port'>): string {
  return `${context.scheme}://${context.host}${context.port === '' ? '' : `:${context.port}`}`;
}
