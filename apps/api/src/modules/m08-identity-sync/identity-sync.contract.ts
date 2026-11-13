import type { Queryable } from '@seamnex/db';
import type { z } from 'zod';
import type {
  AccessRequest,
  DisableUserResponseSchema,
  IdpGroup,
  IdpUser,
  SyncRun,
  UserEntitlementsSchema,
} from '@seamnex/domain';

export type UserEntitlements = z.infer<typeof UserEntitlementsSchema>;
export type DisableUserResponse = z.infer<typeof DisableUserResponseSchema>;

export const IDENTITY_SYNC_SERVICE = Symbol('seamnex.m08.identity-sync');

/** What a decided request tells the orchestrator, which still owns the policy check and the audit. */
export type AccessRequestDecision = {
  readonly requesterIdpId: string;
  readonly kind: string;
  readonly target: string;
};

/** The request as governance must see it before deciding. No policy lives here. */
export type AccessRequestView = AccessRequestDecision & {
  readonly justification: string;
  readonly state: string;
  readonly createdAt: Date;
};

/** Owns idp_user, idp_group, group_mapping, sync_run, access_request. */
export interface IdentitySyncService {
  /**
   * One page of the directory, ordered by `username` and capped (the cap is a safety bound, not a
   * page size). `after` is the keyset cursor: the last `username` of the previous page.
   */
  users(query?: string, after?: string): Promise<IdpUser[]>;
  user(id: string): Promise<IdpUser>;
  userEntitlements(id: string): Promise<UserEntitlements>;
  groups(): Promise<IdpGroup[]>;
  /** Durable: the sync writer is not granted INSERT/UPDATE on group_mapping (invariant 10). */
  mapGroup(
    groupId: string,
    request: { role: string; scopeType: string; scopeLabel: string; propagate: boolean },
    actorId: string,
  ): Promise<IdpGroup>;
  syncRuns(): Promise<SyncRun[]>;
  /** Forces one mirror cycle (deliverable 3.6); returns the completed run. */
  runSync(actorId: string): Promise<SyncRun>;
  /**
   * AC-12: disables the account platform-wide, removes its bindings and entitlements, terminates
   * its sessions and writes the audit row. `group_mapping` is never touched.
   */
  disableUser(id: string, actorId: string): Promise<DisableUserResponse>;
  accessRequests(): Promise<AccessRequest[]>;
  /** One request, read-only, for a caller that has to check a rule before deciding it. */
  accessRequest(id: string): Promise<AccessRequestView>;
  createAccessRequest(
    request: { entryKey: string; justification: string },
    requesterIdpId: string,
  ): Promise<AccessRequest>;
  /**
   * Owns `access_request`. Locks the row and applies the decision inside the caller's transaction,
   * so the state change commits with the audit row that records it.
   *
   * Governance keeps what is genuinely its own: refusing self-approval, writing the audit entry,
   * and asking M10 to grant the entitlement. M18 used to run this UPDATE and the `FOR UPDATE` read
   * itself, which the boundary test could not distinguish from a legitimate read.
   */
  decideAccessRequest(
    tx: Queryable,
    input: { id: string; decision: 'approve' | 'reject'; actorId: string },
  ): Promise<AccessRequestDecision>;
}
