import type { InstancePlan } from '@seamnex/domain';

export const PLANNER_SERVICE = Symbol('seamnex.m04.planner');

export type PlanChange = { readonly field: string; readonly from: string; readonly to: string };

export type PlanInput = {
  readonly instanceId: string;
  readonly action: string;
  readonly renderSetId: string;
  /** `unsafe_approved` only when an approved exception covered a compose rule. */
  readonly policyVerdict: 'allowed' | 'blocked' | 'unsafe_approved';
  readonly capacity: {
    readonly admissible: boolean;
    readonly headline: string;
    readonly detail: string;
    readonly source: 'measured' | 'snapshot' | 'unknown';
  };
  readonly preUpgradeBackup: boolean;
};

export type PlanRecord = {
  readonly planId: string;
  readonly instanceId: string;
  readonly action: string;
  readonly renderSetId: string;
  readonly changes: readonly PlanChange[];
  readonly capacityVerdict: 'admitted' | 'refused' | 'unknown';
  readonly policyVerdict: 'allowed' | 'blocked' | 'unsafe_approved';
  readonly preUpgradeBackup: boolean;
  readonly rollbackAvailable: boolean;
};

/**
 * Owns `deployment_plan`.
 *
 * A plan is the executable record of "what will change": the diff between the currently applied
 * render set and the candidate, the policy verdict and the capacity verdict. The executor applies
 * *the plan*, not the render set directly — which is what makes AC-33 (a plan-gated upgrade) and
 * the pre-upgrade backup checkable rather than conventional.
 */
export interface PlannerService {
  plan(input: PlanInput): Promise<PlanRecord>;
  latest(instanceId: string, action?: string): Promise<PlanRecord | null>;
  /** The `GET /instances/:id/plan` projection (a read that never resolves a source). */
  instancePlan(instanceId: string, action: string): Promise<InstancePlan>;
}
