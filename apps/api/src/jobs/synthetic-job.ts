/**
 * The Phase 1 synthetic job (exit criterion 3).
 *
 * It exercises the whole path — queued → running → steps → logs → stream → terminal — without
 * pretending to deploy anything. The step names match the deploy pipeline where they matter:
 * `apply` is the cancellation boundary, and a job cancelled before it must not reach it.
 */
export const SYNTHETIC_STEPS = ['preflight', 'prepare', 'apply', 'done'] as const;

export const APPLY_INDEX = SYNTHETIC_STEPS.indexOf('apply');
