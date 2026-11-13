import { useMemo } from 'react';
import type { Capability, PlatformRole } from '@seamnex/domain';
import { CAPABILITIES, can, canMutate } from '@seamnex/domain';
import { useSession } from './session';

/**
 * A role's permissions as two lookups instead of two predicate calls.
 *
 * `can` and `canMutate` both answer by reading one cell of `CAPABILITY_MATRIX`, and that matrix is
 * a frozen `const` literal: the answer for a role cannot change while the role does not. Guards and
 * the navigation filter nevertheless asked for it again on every render (three guard components,
 * plus `navigationFor` walking the matrix once per nav item). Deriving the two sets once per role
 * makes every one of those a `has()` against a value that comes from the same matrix, so there is
 * no second list that could drift from the domain's source of truth.
 */
export type RoleCapabilities = {
  /**
   * Every capability the role holds at any level: `can()` as a set. A `scoped` grant is included,
   * because a scope still opens the screen — the screen is then responsible for stating the
   * narrower scope. This set answers "may they read it?", never "may they change it?".
   */
  held: ReadonlySet<Capability>;
  /**
   * The subset granted outright: `canMutate()` as a set. Mutating affordances are only enabled on a
   * `full` grant (a `scoped` one shows a request path instead), so a guard that checked `held`
   * would put an enabled-looking control in front of an auditor.
   */
  mutable: ReadonlySet<Capability>;
};

/**
 * The derivation itself, kept out of the hook so the "why" of the two sets lives in one place.
 *
 * It asks the domain predicates per capability rather than copying a list: a capability added to
 * the matrix, or one whose cells change, is picked up here with no edit to this file.
 */
function capabilitiesFor(role: PlatformRole): RoleCapabilities {
  const held = new Set<Capability>();
  const mutable = new Set<Capability>();
  for (const capability of CAPABILITIES) {
    if (can(role, capability)) held.add(capability);
    if (canMutate(role, capability)) mutable.add(capability);
  }
  return { held, mutable };
}

/**
 * The role's capability sets, memoised on the role alone.
 *
 * Nothing else in the session can change the answer: the scenario and the simulated latency pick
 * which data the request returns and how long it takes, not what the role is allowed to ask for.
 * Including them would rebuild two sets on every latency step and hand every consumer a new object
 * identity, which is the churn `useNavigation` was memoised to avoid.
 *
 * There is deliberately no `CapabilitiesProvider` above this. The consumers are leaves — one guard
 * per route, rendered once — so a provider would save a 46-entry filter per mounted guard (a few
 * dozen property reads) while requiring both a mount point in `app.tsx`'s provider stack and a
 * no-provider fallback, since a component test that renders a guard outside the app still has to
 * get an answer. Two derivations to remove one derivation is not a trade worth making.
 */
export function useCapabilities(): RoleCapabilities {
  const { session } = useSession();
  return useMemo(() => capabilitiesFor(session.role), [session.role]);
}
