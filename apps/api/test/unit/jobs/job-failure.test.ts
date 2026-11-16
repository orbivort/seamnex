import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/common/problem/app-error';
import {
  ABANDONED_FAILURE_CODE,
  TRANSIENT_FAILURE_CODE,
  isTransientFailure,
  isTransientJobError,
  jobErrorCode,
} from '../../../src/jobs/job-failure';

/**
 * NFR-6.5 — the retry policy is only as good as its classification: retrying a request that was
 * wrong wastes an attempt and hides the real refusal, while refusing to retry a dropped socket
 * hands a transient outage to a person. The classifier therefore has to see through the wrappers
 * drivers put around the errno, and it must not walk a cause chain for ever.
 */
function errno(code: string, cause?: unknown): Error {
  return Object.assign(new Error(`socket ${code}`), { code, cause });
}

describe('isTransientFailure', () => {
  it.each([
    'UNAVAILABLE',
    'ADAPTER_UNAVAILABLE',
    'REPOSITORY_UNAVAILABLE',
    'AUTH_PROVIDER_UNAVAILABLE',
    'SECRET_UNAVAILABLE',
    'RATE_LIMITED',
  ])('treats the API code %s as transient', (code) => {
    expect(isTransientFailure(new AppError({ code, detail: 'not now' }))).toBe(true);
  });

  it.each(['COMPOSE_POLICY_BLOCKED', 'VALIDATION_FAILED', 'STATE_CONFLICT', 'INSTANCE_BUSY'])(
    'treats %s as decisive, because repeating it changes nothing',
    (code) => {
      expect(isTransientFailure(new AppError({ code, detail: 'no' }))).toBe(false);
    },
  );

  it('recognises a socket errno on a bare error', () => {
    expect(isTransientFailure(errno('ECONNRESET'))).toBe(true);
    expect(jobErrorCode(errno('ECONNRESET'))).toBe(TRANSIENT_FAILURE_CODE);
  });

  it('looks through the cause a fetch or driver wraps around the errno', () => {
    const wrapped = new Error('fetch failed', { cause: errno('EAI_AGAIN') });
    expect(isTransientFailure(wrapped)).toBe(true);
  });

  it('stops walking a cause chain at a bounded depth instead of hanging', () => {
    let chain: Error = errno('ECONNRESET');
    for (let depth = 0; depth < 10; depth += 1) chain = new Error('wrapped', { cause: chain });
    expect(isTransientFailure(chain)).toBe(false);
  });

  it('says no for a value that is not an error at all', () => {
    expect(isTransientFailure('connection reset')).toBe(false);
    expect(isTransientFailure(null)).toBe(false);
  });
});

describe('jobErrorCode', () => {
  it('keeps a deliberate refusal’s own code, so the console names the real problem', () => {
    expect(
      jobErrorCode(new AppError({ code: 'COMPOSE_POLICY_BLOCKED', detail: 'privileged mode' })),
    ).toBe('COMPOSE_POLICY_BLOCKED');
  });

  it('marks a generic transient failure with the synthetic code', () => {
    expect(jobErrorCode(errno('ETIMEDOUT'))).toBe(TRANSIENT_FAILURE_CODE);
  });

  it('leaves everything else as the code the column held before classification existed', () => {
    expect(jobErrorCode(new Error('render set is missing'))).toBe('JOB_FAILED');
  });
});

describe('isTransientJobError', () => {
  it('accepts the synthetic code and the transient API codes', () => {
    expect(isTransientJobError(TRANSIENT_FAILURE_CODE)).toBe(true);
    expect(isTransientJobError('UNAVAILABLE')).toBe(true);
  });

  it('refuses the codes that mean a human has to decide', () => {
    expect(isTransientJobError('CAPACITY_EXCEEDED')).toBe(false);
    expect(isTransientJobError(ABANDONED_FAILURE_CODE)).toBe(false);
    expect(isTransientJobError(null)).toBe(false);
    expect(isTransientJobError(undefined)).toBe(false);
  });
});
