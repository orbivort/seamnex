import { AppError } from '../common/problem/app-error';

/**
 * Deliverable 2.1 / exit criterion 5: a declared mutation the phase does not own answers `501`
 * with a code naming the owning phase. A silent no-op is indistinguishable from success, which is
 * the one failure mode a phased rollout can hide.
 *
 * **Phase 4 exit state: empty.** Every declared operation is mounted with a handler, and the parity
 * test asserts that handlers and this table partition the registry - so an operation added without a
 * handler fails the build rather than reaching a user as `501`.
 */
export type DeferredOwner = 'phase-4f';

export const DEFERRED_OPERATIONS: ReadonlyMap<string, { owner: DeferredOwner; reason: string }> =
  new Map();

export function deferredProblem(key: string): AppError {
  return new AppError({
    code: 'OPERATION_NOT_IMPLEMENTED',
    detail: `${key} is declared but has no handler in this build.`,
    remediation: 'Nothing was changed. This is a defect: the registry parity test must fail first.',
  });
}
