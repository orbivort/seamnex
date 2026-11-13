import { describe, expect, it } from 'vitest';
import { GUARANTEE_CLASSES } from '../../src/enums';
import {
  SYNC_STATE_BY_GUARANTEE_CLASS,
  propagatesFully,
  syncStateForGuaranteeClass,
} from '../../src/propagation';

/**
 * Invariant 12 lives in the database (`seamnex_entitlement_sync_state`, migration 0009): an entitlement
 * with `sync_state = 'unsupported'` is legal only where the route's `auth_mode` is `fa_gate`. This
 * test is the domain-side half of that rule — a mapping that disagreed with it made every identity
 * sync cycle fail with a check violation, so a deployed product never gained an entitlement and could
 * not appear in the portal.
 */
describe('entitlement propagation by guarantee class (FR-2.4)', () => {
  it('maps every declared class', () => {
    for (const guaranteeClass of GUARANTEE_CLASSES) {
      expect(SYNC_STATE_BY_GUARANTEE_CLASS[guaranteeClass], guaranteeClass).toBeDefined();
    }
  });

  it('claims `unsupported` only for the proxy-gate class', () => {
    const unsupported = GUARANTEE_CLASSES.filter(
      (guaranteeClass) => syncStateForGuaranteeClass(guaranteeClass) === 'unsupported',
    );
    expect(unsupported).toEqual(['fa_gate']);
  });

  it('treats the platform-side grant of a native product as applied', () => {
    // A native product keeps its own credential; the guarantee-class label tells the user that.
    // Recording `unsupported` here is what invariant 12 refuses, and it is not what the state means.
    expect(syncStateForGuaranteeClass('native')).toBe('applied');
    expect(propagatesFully('native')).toBe(true);
    expect(propagatesFully('fa_gate')).toBe(false);
  });
});
