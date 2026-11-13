import type { JobState } from '@seamnex/db';

/**
 * Job lifecycle. A failed or cancelled job is terminal: "retry" creates a new job that references
 * the original, so the history stays append-only and a retry cannot rewrite what happened.
 */
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function isTerminalJobState(state: JobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

/**
 * Cancellation is allowed before `apply` (design §6.3). After apply the job escalates to a
 * compensating plan — stop plus rollback — which is Phase 4A work; until then `apply` is the
 * boundary that makes the rule honest.
 */
export const APPLY_STEP = 'apply';

export function cancellableAt(steps: readonly { name: string; state: string }[]): boolean {
  const apply = steps.find((step) => step.name === APPLY_STEP);
  return apply === undefined || apply.state === 'pending' || apply.state === 'skipped';
}
