import { describe, expect, it } from 'vitest';
import {
  NATIVE_BASELINE_DEPLOYMENTS,
  NATIVE_FLOOR_DEPLOYMENTS,
  isAcceptableFloorDecision,
  nativeFloorStatus,
} from '../../src/posture';

/**
 * S-2 — the floor as data.
 *
 * The numbers used to be literals in the console, so the screenshot, the acceptance evidence and the
 * payload could all disagree and none of them could be refused. The assertions below pin the two
 * properties the requirement depends on: the shortfall is arithmetic over deployments, and a lower
 * floor is only ever a decision that says what it accepts.
 */
describe('nativeFloorStatus', () => {
  it('reports the floor, the baseline and the shortfall for the default target', () => {
    expect(nativeFloorStatus({ native: 4, forwardAuth: 5, signInRequired: 3 })).toEqual({
      native: 4,
      forwardAuth: 5,
      signInRequired: 3,
      deployments: 12,
      floor: NATIVE_FLOOR_DEPLOYMENTS,
      baseline: NATIVE_BASELINE_DEPLOYMENTS,
      met: false,
      shortfall: 2,
    });
  });

  it('counts the floor as met at exactly the target, and reports no shortfall', () => {
    const status = nativeFloorStatus({ native: 6, forwardAuth: 6, signInRequired: 0 });

    expect(status.met).toBe(true);
    expect(status.shortfall).toBe(0);
    expect(status.deployments).toBe(12);
  });

  it('treats an empty fleet as short of the floor rather than exempt', () => {
    const status = nativeFloorStatus({ native: 0, forwardAuth: 0, signInRequired: 0 });

    expect(status.met).toBe(false);
    expect(status.shortfall).toBe(NATIVE_FLOOR_DEPLOYMENTS);
    expect(status.deployments).toBe(0);
  });

  it('measures against the floor it is given, which is how a recorded decision takes effect', () => {
    const status = nativeFloorStatus({ native: 2, forwardAuth: 10, signInRequired: 0 }, 2);

    expect(status.floor).toBe(2);
    expect(status.met).toBe(true);
    expect(status.shortfall).toBe(0);
  });

  it('refuses to count negative or fractional input as extra headroom', () => {
    const status = nativeFloorStatus({ native: -3, forwardAuth: 2.9, signInRequired: 0 }, -1);

    expect(status).toMatchObject({
      native: 0,
      forwardAuth: 2,
      signInRequired: 0,
      deployments: 2,
      floor: 0,
      met: true,
      shortfall: 0,
    });
  });
});

describe('isAcceptableFloorDecision', () => {
  const reason = 'Accepting four native deployments while the ERPNext migration is in flight.';

  it('accepts a lower floor with a reason that says what is accepted', () => {
    expect(isAcceptableFloorDecision({ floor: 4, reason })).toBe(true);
    expect(isAcceptableFloorDecision({ floor: 0, reason })).toBe(true);
  });

  it('refuses a floor that is not a lowering', () => {
    // Only a lowering is a decision; raising it, or restating it, is not a carve-out S-2 permits.
    expect(isAcceptableFloorDecision({ floor: NATIVE_FLOOR_DEPLOYMENTS, reason })).toBe(false);
    expect(isAcceptableFloorDecision({ floor: NATIVE_FLOOR_DEPLOYMENTS + 1, reason })).toBe(false);
    expect(isAcceptableFloorDecision({ floor: NATIVE_BASELINE_DEPLOYMENTS + 1, reason })).toBe(
      false,
    );
  });

  it('refuses a floor that is not a whole non-negative number', () => {
    expect(isAcceptableFloorDecision({ floor: -1, reason })).toBe(false);
    expect(isAcceptableFloorDecision({ floor: 2.5, reason })).toBe(false);
    expect(isAcceptableFloorDecision({ floor: Number.NaN, reason })).toBe(false);
  });

  it('refuses a reason too short to record what is being accepted', () => {
    expect(isAcceptableFloorDecision({ floor: 4, reason: 'later' })).toBe(false);
    expect(isAcceptableFloorDecision({ floor: 4, reason: '   ' })).toBe(false);
  });
});
