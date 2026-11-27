import type { EntitlementSyncState, GuaranteeClass } from './enums';

/**
 * FR-2.4 / design §12: how far an entitlement *can* propagate is a property of the product's
 * authentication guarantee class. Whether it *did* is a separate fact, and 0035 is what makes that
 * fact expressible: a class sets the ceiling below, and the sync worker records `applied` only when
 * the platform actually applied the grant (an identity client it configured, or a role push the
 * entry declared and the adapter completed).
 *
 * - `native`      — the product authenticates against the IdP; with an OIDC/SAML client the group
 *                   claim carries the role, so `applied` is reachable. Without one, the grant exists
 *                   only on the platform and the honest state is `pending`.
 * - `fa_header`   — forward-auth headers carry the identity per request → applied
 * - `fa_delegated`— the product delegates sign-in but keeps a local role record → pending until a cycle
 * - `fa_gate`     — the edge enforces access; the product itself never learns the grant → unsupported
 *
 * `unsupported` is reserved for the proxy-gate class by database invariant 12
 * (`seamnex_entitlement_sync_state`, migration 0009): an `unsupported` entitlement is legal only where the
 * route's `auth_mode` is `fa_gate`. Mapping `native` to `unsupported` therefore made every identity
 * sync fail with a check violation the moment a native product was deployed, and no entitlement for
 * that instance could ever be created — a deployed product could not reach the portal launcher.
 * `edge_only` remains in the enum for a gate whose product role *is* propagated at the edge; no class
 * maps to it today.
 */
export const SYNC_STATE_BY_GUARANTEE_CLASS = {
  native: 'applied',
  fa_header: 'applied',
  fa_delegated: 'pending',
  fa_gate: 'unsupported',
} as const satisfies Record<GuaranteeClass, EntitlementSyncState>;

export function syncStateForGuaranteeClass(guaranteeClass: GuaranteeClass): EntitlementSyncState {
  return SYNC_STATE_BY_GUARANTEE_CLASS[guaranteeClass];
}

/**
 * Classes whose grant can be realised entirely on the platform side — and are therefore the only
 * ones where `applied` may be recorded without a completed product push.
 *
 * `fa_gate` is excluded because invariant 12 forbids `applied` there, and `fa_delegated` because the
 * product keeps its own role record: the platform's claim is not the product's state.
 */
export function canApplyWithoutProductPush(guaranteeClass: GuaranteeClass): boolean {
  return guaranteeClass === 'native' || guaranteeClass === 'fa_header';
}

/** Classes whose grant is completely realised on the platform side. */
export function propagatesFully(guaranteeClass: GuaranteeClass): boolean {
  return SYNC_STATE_BY_GUARANTEE_CLASS[guaranteeClass] === 'applied';
}
