import { createCapabilityGates, type CapabilityGates } from '@seamnex/shell';
import type { CapabilitySets } from '@seamnex/domain';
import { useSession } from './session';

/**
 * The console's capability sets and route gates, built from the shared factory (ADR-FE-01).
 *
 * The derivation lives in `@seamnex/domain` (`capabilitySets`), the gates in `@seamnex/shell`, and
 * this module is the seam that gives them the console's session. What used to be a private copy of
 * both — five screens plus three guards reading a matrix walk per render — is now one leaf hook
 * against a set memoised on the role.
 *
 * The gates are exported here as well as through `components/Guard.tsx`: the guard file supplies
 * the console's refusal panel, while a call site that already renders its own refusal (a panel, a
 * disabled action) can use the gate directly without importing presentation.
 */
export const capabilityGates: CapabilityGates = createCapabilityGates(useSession);

export const useCapabilities = capabilityGates.useCapabilities;

export type { CapabilitySets };
