/**
 * FR-2.4 — the seam through which the platform writes a mapped product role into a product.
 *
 * It is a port so the sync worker never talks HTTP itself: the cycle decides *whether* a grant was
 * applied, the adapter decides *how* one product accepts that fact. A deployment that has no product
 * admin API simply never binds a working implementation — the entitlements stay `pending` with a
 * reason, which is the state AC-11 asks the platform to be honest about.
 */

export const IDENTITY_PUSH = Symbol('seamnex.identity.push');

export type IdentityPushInput = {
  /** Instance whose network the product lives on; also the owner of the credential. */
  readonly instanceId: string;
  /** Product service alias on that network (`http://<slug>:<port>`); the fallback address. */
  readonly slug: string;
  /** Verified API origin when one was recorded, e.g. `http://crm:8080`. */
  readonly baseUrl: string | null;
  /** `integration.rolePush.path`, declared by the entry at onboarding. */
  readonly path: string;
  /** JSON field the product expects the role in. */
  readonly roleField: string;
  /** `instance`-scoped secret holding the product admin API token. */
  readonly secretName: string;
  readonly subjectIdpId: string;
  readonly email: string;
  readonly productRole: string;
};

export type IdentityPushResult = {
  readonly ok: boolean;
  /** A status line or the reason the push did not happen; never the token and never the body. */
  readonly detail: string;
};

export interface IdentityPushPort {
  push(input: IdentityPushInput): Promise<IdentityPushResult>;
}
