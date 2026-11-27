import type { ComposeRule } from '@seamnex/domain';

/**
 * The one result shape every source policy answers with.
 *
 * A Compose file and a Dockerfile are different documents but the same control: the platform decides
 * whether it can govern what they describe, and it either refuses, waives an approved rule, or
 * normalises what it can rewrite. Keeping one shape means the resolver, the renderer, the plan and
 * the exception queue read the same verdict from either path — the Dockerfile path used to return an
 * empty result and therefore bypassed NFR-4.15 entirely.
 */
export type ComposeViolation = {
  readonly rule: ComposeRule;
  readonly service: string | null;
  readonly detail: string;
};

export type ComposePatchEntry = {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
};

export type SourcePolicyResult = {
  readonly verdict: 'allowed' | 'blocked' | 'unsafe_approved';
  readonly violations: readonly ComposeViolation[];
  /** Violations that are covered by an approved exception. */
  readonly waived: readonly ComposeRule[];
  /** The platform-owned copy: published ports removed, exposure declared. */
  readonly document: Record<string, unknown>;
  readonly patch: readonly ComposePatchEntry[];
  /** Invariant 9: must be 0 before apply. */
  readonly publishedPorts: number;
  readonly services: readonly string[];
};

/**
 * The compose-path name for the same shape. Kept because the resolver's contract, its tests and the
 * renderer all speak it, and because renaming a type is not part of this change.
 */
export type ComposePolicyResult = SourcePolicyResult;

export function emptyPolicy(): SourcePolicyResult {
  return {
    verdict: 'allowed',
    violations: [],
    waived: [],
    document: {},
    patch: [],
    publishedPorts: 0,
    services: [],
  };
}
