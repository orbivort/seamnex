import type { EntitlementSyncState, GuaranteeClass } from './enums';

/**
 * FR-2.4 / design §12: how far an entitlement can propagate is a property of the product's
 * authentication guarantee class, not of the sync run. The sync worker records the class-derived
 * state so a screen can say "pending" or "edge only" instead of implying it applied everywhere.
 *
 * - `native`      — the platform's grant is applied; the product keeps its own credential, which is
 *                   what the guarantee-class label (not the sync state) tells the user
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

/** Classes whose grant is completely realised on the platform side. */
export function propagatesFully(guaranteeClass: GuaranteeClass): boolean {
  return SYNC_STATE_BY_GUARANTEE_CLASS[guaranteeClass] === 'applied';
}
