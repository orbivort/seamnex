import { useMemo, type ReactNode } from 'react';
import {
  capabilitySets,
  type Capability,
  type CapabilitySets,
  type PlatformRole,
} from '@seamnex/domain';

/**
 * The slice of a session kit a gate needs. Structural on purpose: both apps build their session
 * with `createSessionKit`, and a gate must not depend on which options that kit was created with.
 */
export type SessionRoleSource = () => { readonly session: { readonly role: PlatformRole } };

/**
 * What to render when the gate refuses. The denied capability is passed so the caller can say
 * which one — `undefined` only when the entry declared no capability at all, which is a wiring
 * defect the navigation test catches.
 */
export type CapabilityFallback = (denied: Capability | undefined) => ReactNode;

export type CapabilityGates = {
  /** The role's held/mutable sets, memoised on the role alone. */
  useCapabilities: () => CapabilitySets;
  RequireCapability: (props: {
    capability: Capability;
    fallback: CapabilityFallback;
    children: ReactNode;
  }) => ReactNode;
  RequireFullCapability: (props: {
    capability: Capability;
    fallback: CapabilityFallback;
    children: ReactNode;
  }) => ReactNode;
  RequireAnyCapability: (props: {
    capabilities: readonly Capability[];
    fallback: CapabilityFallback;
    children: ReactNode;
  }) => ReactNode;
  RequireAnyFullCapability: (props: {
    capabilities: readonly Capability[];
    fallback: CapabilityFallback;
    children: ReactNode;
  }) => ReactNode;
};

/**
 * ADR-FE-01 — the client-side gates, built once per app.
 *
 * The console had these three privately and the portal had none, so the same policy was written
 * twice in one app and not at all in the other. Handing the factory the app's own `useSession` is
 * what keeps one implementation: the sets are derived from the matrix in `@seamnex/domain`, and the
 * only per-app decision left is presentation — which is why the refused node is a parameter rather
 * than an import.
 *
 * There is deliberately no `CapabilitiesProvider`. The consumers are leaves (one guard per route,
 * a few panels), so a provider would save a 49-entry filter per mounted guard while requiring a
 * mount point and a no-provider fallback, since a component test that renders a guard outside the
 * app still has to get an answer. Two derivations to remove one derivation is not a trade worth
 * making.
 *
 * Nothing here is a control. The sets decide what to render; the PDP decides what may be read
 * (`packages/api-client/src/session-role.ts`). A hidden route stays reachable by URL and answers
 * 403, which is the honest answer for a caller who typed it.
 */
export function createCapabilityGates(useSession: SessionRoleSource): CapabilityGates {
  function useCapabilities(): CapabilitySets {
    const { session } = useSession();
    return useMemo(() => capabilitySets(session.role), [session.role]);
  }

  function RequireCapability({
    capability,
    fallback,
    children,
  }: {
    capability: Capability;
    fallback: CapabilityFallback;
    children: ReactNode;
  }): ReactNode {
    // `held`, not `mutable`: a `scoped` grant still opens the screen, which then states the scope.
    const { held } = useCapabilities();
    return held.has(capability) ? children : fallback(capability);
  }

  function RequireFullCapability({
    capability,
    fallback,
    children,
  }: {
    capability: Capability;
    fallback: CapabilityFallback;
    children: ReactNode;
  }): ReactNode {
    // `mutable`: an admin surface is only enterable on an outright grant.
    const { mutable } = useCapabilities();
    return mutable.has(capability) ? children : fallback(capability);
  }

  function RequireAnyCapability({
    capabilities,
    fallback,
    children,
  }: {
    capabilities: readonly Capability[];
    fallback: CapabilityFallback;
    children: ReactNode;
  }): ReactNode {
    const { held } = useCapabilities();
    if (capabilities.some((capability) => held.has(capability))) return children;
    // The first capability the role does not hold is the one worth naming in the refusal.
    return fallback(capabilities.find((capability) => !held.has(capability)));
  }

  /**
   * "One of these, held outright": a surface that names several capabilities and needs an
   * unscoped grant on any of them — the environment profiles screen, where R1 manages and R3 files
   * a change request, is the case that needs it.
   */
  function RequireAnyFullCapability({
    capabilities,
    fallback,
    children,
  }: {
    capabilities: readonly Capability[];
    fallback: CapabilityFallback;
    children: ReactNode;
  }): ReactNode {
    const { mutable } = useCapabilities();
    if (capabilities.some((capability) => mutable.has(capability))) return children;
    return fallback(capabilities.find((capability) => !mutable.has(capability)));
  }

  return {
    useCapabilities,
    RequireCapability,
    RequireFullCapability,
    RequireAnyCapability,
    RequireAnyFullCapability,
  };
}
