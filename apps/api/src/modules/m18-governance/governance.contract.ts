import type {
  BreakGlassSession,
  DsarRequest,
  LicenseGate,
  LicenseRecord,
  LicenseReviewRequest,
  MaintenanceWindow,
  PatchRecord,
  PolicyException,
  PostureSummary,
} from '@seamnex/domain';

export const GOVERNANCE_SERVICE = Symbol('seamnex.m18.governance');

/**
 * The write side of M18, for callers that are not reading the governance screens.
 *
 * It is a separate token because it is a separate responsibility: `GovernanceService` is the read
 * model, and a scheduler sweep that moves rows has no business on it. The token exists so the
 * scheduler depends on M18's interface rather than importing `governance-writes.service`.
 */
export const GOVERNANCE_WRITES = Symbol('seamnex.m18.governance-writes');

export interface GovernanceWrites {
  /**
   * FR-4.11 — closes every grant whose time box has elapsed and returns what changed, so the
   * caller can write one audit row per grant. `break_glass_session` is owned by M18: the scheduler
   * used to run this UPDATE itself, which the boundary test could not tell from a legitimate read.
   */
  expireOverdueBreakGlass(): Promise<
    ReadonlyArray<{ readonly id: string; readonly instanceId: string | null }>
  >;
}

/** Owns licence_record, patch_record, break_glass_session, policy_exception, maintenance_window, dsar_request. */
export interface GovernanceService {
  licenses(): Promise<LicenseRecord[]>;
  /** ADR-BE-25: R2 records the review; the actor and timestamp come from the session/server. */
  recordReview(
    instanceId: string,
    request: LicenseReviewRequest,
    actorId: string,
  ): Promise<LicenseRecord>;
  setHostedService(instanceId: string, enabled: boolean, actorId: string): Promise<LicenseGate>;
  patches(): Promise<PatchRecord[]>;
  posture(): Promise<PostureSummary>;
  breakGlass(): Promise<BreakGlassSession[]>;
  /**
   * FR-5.9 / §5.1 — the read-write elevations this actor currently holds, by instance.
   *
   * R1's authority inside a business product is break-glass, so a workflow write by an R1 needs an
   * active, unexpired, read-write session on each instance it writes to. The query lives here
   * because `break_glass_session` is this module's table; a caller only ever sees the pairs it may
   * record as evidence, never the justification.
   */
  activeWriteElevations(
    actorId: string,
    instanceIds: readonly string[],
  ): Promise<{ instanceId: string; sessionId: string }[]>;
  maintenance(): Promise<MaintenanceWindow[]>;
  policyExceptions(): Promise<PolicyException[]>;
  dsar(): Promise<DsarRequest[]>;
}
