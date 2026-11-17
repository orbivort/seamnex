import type {
  BreakGlassSession,
  DsarRequest,
  LicenseGate,
  LicenseRecord,
  LicenseReviewRequest,
  MaintenanceWindow,
  NativeFloorDecision,
  NativeFloorDecisionRequest,
  PatchRecord,
  PolicyException,
  PostureSummary,
  UpstreamObservationResult,
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

  /**
   * S-2 — records the owner decision that lowers the native floor.
   *
   * The method is on the write surface rather than exposed as a settings field because the decision
   * *is* the control: the row and its audit entry are one transaction, and only a decision recorded
   * here can make `nativeFloorStatus()` report a lower target.
   */
  recordNativeFloorDecision(
    request: NativeFloorDecisionRequest,
    actorId: string,
  ): Promise<NativeFloorDecision>;
}

/**
 * FR-2.12 / NFR-4.7 — the observation pass, as the scheduler and the on-demand route see it.
 *
 * Its own token for the same reason `GOVERNANCE_WRITES` exists: the scheduler needs to *run* the
 * pass, and nothing that only reads the register should be able to.
 */
export const UPSTREAM_OBSERVER = Symbol('seamnex.m18.upstream-observer');

export type UpstreamObservationActor = {
  /** `system` for the scheduler pass, `user` for the operator-triggered route. */
  readonly type: 'system' | 'user';
  readonly id: string;
};

export interface UpstreamObserver {
  /**
   * Observes GitHub releases and OSV advisories for the catalogue, then writes the register.
   *
   * Throws `UNAVAILABLE` when tracking is disabled; a feed that answers badly is a counted outcome
   * in the result, never an exception, so one unreachable upstream cannot abort the pass.
   */
  observe(actor: UpstreamObservationActor): Promise<UpstreamObservationResult>;
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
