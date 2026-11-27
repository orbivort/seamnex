/**
 * S-2 — the native floor, as data rather than a caption.
 *
 * The floor was a literal in the console (`NATIVE_FLOOR_DEPLOYMENTS = 6`), which meant the API, the
 * catalogue projection and the acceptance evidence each had a different idea of the target and none
 * of them could refuse anything. It lives here because it is a product rule, not a screen rule: the
 * posture payload, the coverage verdict and the gate script all read this one definition.
 *
 * The numbers are S-2's, not a tuning knob: **6 of 12 deployments** authenticate natively, counted
 * per deployment because D5 and D6 share one ERPNext instance. Lowering the floor is permitted only
 * by a recorded owner decision (S-2), which is why `floor` is a parameter here rather than a
 * constant read inside the function.
 */
export const NATIVE_FLOOR_DEPLOYMENTS = 6;

/** S-2's denominator: 12 containerised product deployments serve the 13 domain entries. */
export const NATIVE_BASELINE_DEPLOYMENTS = 12;

export type NativeFloorCounts = {
  readonly native: number;
  readonly forwardAuth: number;
  readonly signInRequired: number;
};

export type NativeFloorStatus = {
  readonly native: number;
  readonly forwardAuth: number;
  readonly signInRequired: number;
  /** Deployments counted, whatever their class; the denominator the floor is measured against. */
  readonly deployments: number;
  readonly floor: number;
  readonly baseline: number;
  readonly met: boolean;
  /** How many more native deployments the floor needs; `0` when it is met. */
  readonly shortfall: number;
};

/**
 * Pure so it can be tested without a database and reused by the projection verdict, the posture
 * payload and `scripts/check-catalog-coverage.mjs` (through a copy of the same rule).
 */
export function nativeFloorStatus(
  counts: NativeFloorCounts,
  floor: number = NATIVE_FLOOR_DEPLOYMENTS,
): NativeFloorStatus {
  const native = Math.max(0, Math.trunc(counts.native));
  const forwardAuth = Math.max(0, Math.trunc(counts.forwardAuth));
  const signInRequired = Math.max(0, Math.trunc(counts.signInRequired));
  const deployments = native + forwardAuth + signInRequired;
  const target = Math.max(0, Math.trunc(floor));
  return {
    native,
    forwardAuth,
    signInRequired,
    deployments,
    floor: target,
    baseline: NATIVE_BASELINE_DEPLOYMENTS,
    met: native >= target,
    shortfall: Math.max(0, target - native),
  };
}

/**
 * S-2's "recorded owner decision" rule. A decision is valid only when it is explicit about who
 * accepted the lower floor; an empty reason would turn the carve-out back into a silent re-baseline.
 */
export function isAcceptableFloorDecision(input: {
  readonly floor: number;
  readonly reason: string;
}): boolean {
  if (!Number.isInteger(input.floor) || input.floor < 0) return false;
  if (input.floor > NATIVE_BASELINE_DEPLOYMENTS) return false;
  if (input.floor >= NATIVE_FLOOR_DEPLOYMENTS) return false;
  return input.reason.trim().length >= 20;
}
