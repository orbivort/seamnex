import type { GuaranteeClass } from './enums';
import { nativeFloorStatus } from './posture';
import type { CatalogCoverage } from './schemas/catalog';

/**
 * S-1 / S-2 / AC-01 — the catalogue's own coverage, computed once and served everywhere.
 *
 * Three callers need the same answer: the reload receipt, `GET /posture` and the
 * `check:catalog` gate. Computing it in each is how the console and the API end up disagreeing
 * about whether six products or three are catalogued, which is exactly the finding this closes.
 *
 * Two vocabulary decisions matter:
 *   - **Deployments, not entries.** D5 and D6 are two domain entries served by one ERPNext
 *     deployment, so counting entries would credit the same native login twice and make S-2's
 *     "6 of 12 deployments" unreachable by arithmetic alone. `primaryInstanceId` identifies the
 *     deployment; an entry without one is its own deployment.
 *   - **`refused` is a first-class output.** A declaration with no entry document cannot be
 *     projected; before this, the loader tolerated it and the operator saw a healthy catalogue with
 *     a product that could never deploy.
 */
export type CatalogCoverageEntry = {
  readonly key: string;
  readonly guaranteeClass: GuaranteeClass;
  /** `null` for an entry that owns its deployment (the console dedupes the same way). */
  readonly primaryInstanceId: string | null;
};

export type CatalogCoverageInput = {
  readonly entries: readonly CatalogCoverageEntry[];
  /** `catalog/env/*.json` declarations found in the tree, valid or not. */
  readonly declaredEnvironments: number;
  /** Declarations that cannot be projected, with the reason a human can act on. */
  readonly refused: readonly { readonly key: string; readonly reason: string }[];
  /** S-2 floor in force; defaults to `NATIVE_FLOOR_DEPLOYMENTS`. */
  readonly floor?: number;
};

export function computeCatalogCoverage(input: CatalogCoverageInput): CatalogCoverage {
  const deployments = new Map<string, GuaranteeClass>();
  for (const entry of input.entries) {
    const deployment = entry.primaryInstanceId ?? `entry:${entry.key}`;
    // Two entries on one deployment share one login mechanism; the first wins and the second is the
    // same deployment seen from another domain.
    if (!deployments.has(deployment)) deployments.set(deployment, entry.guaranteeClass);
  }

  const byClass = { native: 0, fa_header: 0, fa_delegated: 0, fa_gate: 0 };
  for (const guaranteeClass of deployments.values()) byClass[guaranteeClass] += 1;

  const floor = nativeFloorStatus(
    {
      native: byClass.native,
      forwardAuth: byClass.fa_header + byClass.fa_delegated,
      signInRequired: byClass.fa_gate,
    },
    input.floor,
  );

  const refused = [...input.refused];
  return {
    entries: input.entries.length,
    deployments: deployments.size,
    declaredEnvironments: input.declaredEnvironments,
    // A refused declaration is *declared but not documented*; subtracting keeps the two totals
    // additive without a second pass over the tree.
    documentedEnvironments: Math.max(0, input.declaredEnvironments - refused.length),
    refused,
    byClass,
    nativeDeployments: byClass.native,
    floor: floor.floor,
    baseline: floor.baseline,
    floorMet: floor.met,
    shortfall: floor.shortfall,
  };
}
