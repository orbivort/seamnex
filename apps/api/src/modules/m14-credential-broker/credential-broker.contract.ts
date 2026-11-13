import type { CredentialScope } from '@seamnex/domain';

export const CREDENTIAL_BROKER_SERVICE = Symbol('seamnex.m14.credential-broker');

/**
 * What the broker learns from a presented token, or `null` when the token is unknown, expired,
 * revoked, or belongs to a version the workflow has already moved past.
 */
export type VerifiedScope = {
  readonly scopeId: string;
  readonly instanceId: string;
  readonly workflowId: string;
  readonly versionId: string | null;
  readonly operations: readonly string[];
  readonly mode: 'read' | 'write';
  readonly expiresAt: string;
};

/**
 * Owns credential_scope, broker_policy. Phase 4E.
 *
 * The C-11 rule is enforced three times, on purpose:
 *   - here, as a stated refusal with a remediation the author can act on;
 *   - in the database (invariant 4, migration 0017), which is what makes it true for a writer that
 *     never reaches this interface;
 *   - and by construction: `credential_scope.mode = 'write'` is unreachable for a product whose
 *     `credential_granularity` is not `scoped`, so the activation that would mint one cannot pass
 *     validation for that product.
 */
export interface CredentialBrokerService {
  /**
   * Mints the scope an active version's nodes call the broker with.
   *
   * `token` is the only moment the plaintext exists outside the n8n credential: it is what activation
   * writes into n8n and never stores. A re-activation of the same version returns the same token —
   * the scope is keyed by version and entry, so a retry must not leave a second live credential
   * behind. The digest, not the token, is what `credential_scope` keeps (migration 0027).
   */
  mint(input: {
    instanceId: string;
    workflowId: string;
    operations: readonly string[];
    mode: 'read' | 'write';
    ttlSeconds: number;
    idempotencyKey?: string;
  }): Promise<{
    scopeId: string;
    secretRef: string;
    token: string;
    expiresAt: string;
    mode: 'read' | 'write';
    operations: string[];
  }>;
  revoke(scopeId: string, actorId?: string): Promise<void>;
  list(instanceId: string): Promise<CredentialScope[]>;
  /**
   * Resolves a token the broker was handed to the scope that authorises it.
   *
   * A scope is bounded by its version (the contract above), so the lookup joins `workflow` and
   * requires the version to still be the current one: publishing a new version must not leave the
   * previous token usable until it expires on its own.
   */
  verifyToken(token: string): Promise<VerifiedScope | null>;
}
