export const FORWARD_AUTH_SERVICE = Symbol('seamnex.m11.forward-auth');

/**
 * Stateless: no tables. Never queries PostgreSQL on the hot path — it reads the Redis decision
 * cache (design §6.2). Implemented in Phase 4D.
 */
export interface ForwardAuthService {
  decide(input: {
    host: string;
    path: string;
    sessionId: string | null;
  }): Promise<{ allow: boolean; headers: Record<string, string>; reason: string }>;
  /**
   * Redeems a one-time launch ticket for the session it was minted from, or `null` when the ticket
   * is unknown, expired, already used, or belongs to a different route. The caller then answers the
   * bootstrap request with that session's cookie on the product's host.
   *
   * `instanceId` and `subjectIdpId` are the relay's inputs (ADR-BE-22): the instance decides whether
   * a product account exists, and the subject decides whose it is. They are resolved during the
   * redemption rather than added to the ticket, so a leaked URL still promotes nobody.
   */
  redeem(input: { ticket: string; host: string }): Promise<{
    readonly sessionId: string;
    readonly instanceId: string;
    readonly subjectIdpId: string;
  } | null>;
}
