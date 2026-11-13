/**
 * ADR-BE-22 §Credentials — the second seam: creating, re-passwording and locking the per-user
 * accounts the relay signs in as.
 *
 * This is deliberately *not* the same interface as the login adapter. A product may be drivable
 * through its form and still have no admin API (then mappings are created by hand), or the reverse.
 * What the relay needs from this side is four verbs and, per product, the shape of the credential
 * its API accepts — a bearer token for OpenProject, an administrator's login pair for OrangeHRM.
 */

/**
 * The admin credential, as the product's API accepts it.
 *
 * Modelled as a union rather than "a token and an optional username" so a product cannot be handed
 * the wrong half: the adapter states which shape it takes, and the caller reads only that one from
 * the secret store.
 */
export type ProductAdminCredential =
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'password'; readonly username: string; readonly password: string };

export type ProductProvisioningTarget = {
  /** `http://<slug>:<httpPort>` on the instance network. */
  readonly origin: string;
  /** The product's public origin, so `Host` matches what it was configured with. */
  readonly publicOrigin: string;
  readonly credential: ProductAdminCredential;
};

export type ProductApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly detail: string };

export type CreatedProductUser = { readonly id: string; readonly login: string };

/**
 * What reconciliation needs to know about an account the product already has: its id, and whether
 * it is an administrator. `admin` is read because a login collision must never resolve by resetting
 * the password of an account with administrator rights (ADR-BE-22 §Credentials, break-glass).
 */
export type FoundProductUser = { readonly id: string; readonly admin: boolean };

export interface ProductProvisioningAdapter {
  /** A stable label for logs; the catalogue entry alone cannot name the client that answered. */
  readonly name: string;
  /** Which member of `ProductAdminCredential` this product's API accepts. */
  readonly credentialKind: ProductAdminCredential['kind'];
  /**
   * Present when `credentialKind` is `password`: the instance variables holding the administrator's
   * login. Named by the adapter, because the variable names belong to the product's env schema.
   */
  readonly passwordVariables?: {
    readonly username: string;
    readonly password: string;
  };
  /**
   * Present when the platform can derive the bearer token itself, from the administrator account the
   * deploy created.
   *
   * ADR-BE-22 §Credentials (amendment): a `bearer` product has no token until a human mints one, and
   * a fresh deployment — a new database, a new volume — starts without one, so a redeploy silently
   * regressed every launch to the product's own form. The one credential that is *not* a human's is
   * the seed administrator: the deploy generated its password and stored it as an instance secret.
   * This recipe says which variable holds it, and the relay signs in through the product's own form
   * to mint a token, exactly as an operator would — without changing the password, so the account
   * stays usable by a person who reads the secret.
   *
   * Absent means "no safe way to derive it": the token stays operator-supplied (`admin_credential`).
   */
  readonly adminBootstrap?: {
    readonly login: string;
    /** The instance variable holding that account's password, as the entry's env schema names it. */
    readonly passwordVariable: string;
  };
  createUser(
    target: ProductProvisioningTarget,
    user: {
      readonly login: string;
      readonly password: string;
      readonly firstName: string;
      readonly lastName: string;
      readonly email: string | null;
    },
  ): Promise<ProductApiResult<CreatedProductUser>>;
  resetPassword(
    target: ProductProvisioningTarget,
    userId: string,
    password: string,
  ): Promise<ProductApiResult<null>>;
  disableUser(target: ProductProvisioningTarget, userId: string): Promise<ProductApiResult<null>>;
  findUserByLogin(
    target: ProductProvisioningTarget,
    login: string,
  ): Promise<ProductApiResult<FoundProductUser | null>>;
}
