import type {
  BreakGlassSession,
  DsarRequest,
  LicenseGate,
  LicenseRecord,
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
  setHostedService(instanceId: string, enabled: boolean, actorId: string): Promise<LicenseGate>;
  patches(): Promise<PatchRecord[]>;
  posture(): Promise<PostureSummary>;
  breakGlass(): Promise<BreakGlassSession[]>;
  maintenance(): Promise<MaintenanceWindow[]>;
  policyExceptions(): Promise<PolicyException[]>;
  dsar(): Promise<DsarRequest[]>;
}
