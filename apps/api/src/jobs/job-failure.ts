import { isAppError } from '../common/problem/app-error';

/**
 * NFR-6.5 — which job failures are worth retrying without a human.
 *
 * The distinction is the requirement's, not a preference: steady-state operational effort is capped
 * at four operator-hours a week, so a dependency that was briefly absent (a restarting registry, a
 * throttled object store, a dropped socket) must not become a person's afternoon. A failure that
 * says the *request* was wrong — a blocked Compose policy, a missing secret, a state conflict —
 * cannot be fixed by repeating it, and a retry would only add noise to the history.
 *
 * Classification happens where the error is still an object (the worker), because the stored
 * `error_code` is all the retry pass can see afterwards. `jobErrorCode()` is therefore the only
 * writer of that column and `isTransientJobError()` the only reader of the rule.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  // 5xx-class refusals the API raises when a dependency is not there.
  'UNAVAILABLE',
  'ADAPTER_UNAVAILABLE',
  'REPOSITORY_UNAVAILABLE',
  'AUTH_PROVIDER_UNAVAILABLE',
  'SECRET_UNAVAILABLE',
  // A throttle is a "not now", which is the definition of a transient failure.
  'RATE_LIMITED',
]);

/**
 * Socket-level failures. They arrive as a bare `Error` from `fetch`, `pg` or `dockerode` — not an
 * `AppError` — so they are matched on the errno in the error or anywhere in its cause chain.
 */
const TRANSIENT_ERRNO: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** A failure the platform may retry on its own, without a human deciding first. */
export const TRANSIENT_FAILURE_CODE = 'JOB_TRANSIENT';

/** The stored `error_code` of a job that died with its worker rather than failing a stage. */
export const ABANDONED_FAILURE_CODE = 'JOB_ABANDONED';

/** Every code the retry pass treats as transient, for the `= ANY(...)` candidate query. */
export const TRANSIENT_JOB_ERROR_CODES: readonly string[] = [
  TRANSIENT_FAILURE_CODE,
  ...TRANSIENT_CODES,
];

/**
 * The cause chain is bounded because a driver may nest its error arbitrarily deep, and walking a
 * cycle would hang a worker inside its own failure path.
 */
const MAX_CAUSE_DEPTH = 6;

export function isTransientFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== 'object') return false;
    if (isAppError(current) && TRANSIENT_CODES.has(current.code)) return true;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_ERRNO.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
    if (current === undefined) return false;
  }
  return false;
}

/**
 * The `deployment_job.error_code` a failure writes.
 *
 * A deliberate refusal keeps its own code: the console and the audit trail name the actual problem,
 * and only a generic transient error needs the synthetic one. `JOB_FAILED` remains the answer for
 * everything else, which is what the column held before classification existed.
 */
export function jobErrorCode(error: unknown): string {
  if (isAppError(error)) return error.code;
  return isTransientFailure(error) ? TRANSIENT_FAILURE_CODE : 'JOB_FAILED';
}

export function isTransientJobError(code: string | null | undefined): boolean {
  if (code === null || code === undefined) return false;
  return code === TRANSIENT_FAILURE_CODE || TRANSIENT_CODES.has(code);
}
