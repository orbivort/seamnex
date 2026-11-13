import type { Queryable } from '@seamnex/db';

export const SECRETS_SERVICE = Symbol('seamnex.secrets.service');

/**
 * `product_account` is one platform subject's credential on one product instance (ADR-BE-22). It is
 * a scope of its own so the secret is never addressable from `instance`: filing a per-user password
 * under the instance would make it readable by anything that can open any instance secret.
 */
export type SecretScope = 'instance' | 'idp_client' | 'workflow' | 'platform' | 'product_account';

/**
 * The owner a caller claims for a secret it is about to decrypt. `ownerId` is the mapping row for
 * `product_account`, the instance id for `instance`, and so on — the same value the writer filed it
 * under.
 */
export type SecretOwner = {
  readonly scope: SecretScope;
  readonly ownerId: string;
};

export type SecretMetadata = {
  readonly id: string;
  readonly scope: SecretScope;
  readonly ownerId: string;
  readonly name: string;
  readonly version: number;
  /** Always the mask: no projection of this service returns a value. */
  readonly masked: string;
};

export interface SecretsService {
  /**
   * Writes a new version.
   *
   * `tx` is for a caller that is already inside a transaction which holds the audit chain lock. The
   * write then joins that transaction instead of opening a second one: two connections, the same
   * chain lock, is a self-deadlock that only resolves when `statement_timeout` fires — which is
   * exactly how a deployment with any secret variable used to fail, leaving a half-created instance
   * behind.
   */
  put(
    scope: SecretScope,
    ownerId: string,
    name: string,
    value: string,
    tx?: Queryable,
  ): Promise<SecretMetadata>;
  /**
   * Writes a new version, refusing an id the caller does not believe it is rotating.
   *
   * `expected` mirrors `open`, and it is not redundant with it: rotation *replaces* the value. A
   * `secret_ref` that drifted onto another scope's secret would overwrite that secret — the admin API
   * token, another mapping's password — and audit the rotation as a success (ADR-BE-22). A mismatch
   * is refused and audited as a failed rotation before anything is written.
   */
  rotate(
    secretId: string,
    value: string,
    expected?: SecretOwner,
    tx?: Queryable,
  ): Promise<SecretMetadata>;
  /**
   * Decrypts and writes a `secret.read` audit row in the same transaction.
   *
   * `expected` is the caller stating which secret it believes it is opening. A scope in the CHECK
   * constraint is a namespace, not an authorization boundary: without this argument any caller
   * holding an id could decrypt any other scope's value, including a per-user product password
   * (ADR-BE-22). A mismatch is refused before decryption and audited as a failed read.
   */
  open(secretId: string, reason: string, expected?: SecretOwner): Promise<string>;
  describe(secretId: string): Promise<SecretMetadata>;
  /**
   * Deletes the secret and every version of it, and audits `secret.delete`.
   *
   * It exists for offboarding (ADR-BE-22): a per-user product credential whose subject is gone is
   * not "unused", it is a standing access the platform is no longer entitled to hold. A no-op for a
   * missing id, so a retried offboarding cannot fail on the second run.
   *
   * `expected` is the same assertion `open` and `rotate` take, and it matters more here: a drifted
   * `secret_ref` would make offboarding delete an unrelated secret, so a mismatch is refused — and
   * audited as a failed deletion — without deleting anything.
   */
  remove(secretId: string, reason: string, expected?: SecretOwner): Promise<void>;
  /**
   * The newest version of a named secret, without its value — `null` when the scope holds none.
   *
   * It exists so a module that provisions a credential can *reuse* one the operator already stored
   * (an `instance`-scoped variable set through the environment surface) instead of generating a
   * second value the product would never receive. Metadata only: reading it needs no decryption and
   * writes no `secret.read` audit row.
   */
  find(scope: SecretScope, ownerId: string, name: string): Promise<SecretMetadata | null>;
}
