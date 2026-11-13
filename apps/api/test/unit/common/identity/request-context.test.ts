import { describe, expect, it } from 'vitest';
import {
  currentContext,
  isAnonymousPath,
  requireContext,
  runWithContext,
} from '../../../../src/common/identity/request-context';
import { currentRequestId } from '../../../../src/common/logging/logger';
import { AppError } from '../../../../src/common/problem/app-error';
import { testContext } from '../../../support/operation-input';

describe('currentContext', () => {
  it('is undefined outside a request', () => {
    expect(currentContext()).toBeUndefined();
  });

  it('is the context bound by runWithContext, and only inside it', () => {
    const context = testContext();

    const inside = runWithContext(context, () => currentContext());

    expect(inside).toBe(context);
    expect(currentContext()).toBeUndefined();
  });
});

describe('requireContext', () => {
  it('returns the context a handler is running in', () => {
    const context = testContext();
    expect(runWithContext(context, () => requireContext())).toBe(context);
  });

  it('throws UNAUTHORIZED when a handler runs outside a request, which is a defect', () => {
    let error: unknown;
    try {
      requireContext();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('UNAUTHORIZED');
    expect((error as AppError).detail).toContain('no resolved identity');
  });
});

describe('runWithContext', () => {
  it('keeps the logging store and the identity store on the same request id', () => {
    const context = testContext({ requestId: 'rid-both' });

    const observed = runWithContext(context, () => ({
      identity: currentContext()?.requestId,
      logging: currentRequestId(),
      role: currentContext()?.processRole,
    }));

    expect(observed).toEqual({ identity: 'rid-both', logging: 'rid-both', role: 'api' });
  });

  it('propagates both a return value and a rejection', async () => {
    expect(runWithContext(testContext(), () => 7)).toBe(7);

    await expect(
      runWithContext(testContext(), async () => {
        throw new Error('inside context');
      }),
    ).rejects.toThrow('inside context');
  });

  it('keeps nested contexts isolated', () => {
    const outer = testContext({ requestId: 'outer' });
    const inner = testContext({ requestId: 'inner' });

    const observed = runWithContext(outer, () => {
      const before = currentContext()?.requestId;
      const nested = runWithContext(inner, () => currentContext()?.requestId);
      return { before, nested, after: currentContext()?.requestId };
    });

    expect(observed).toEqual({ before: 'outer', nested: 'inner', after: 'outer' });
  });
});

describe('isAnonymousPath', () => {
  it.each([
    '/api/v1/healthz',
    '/api/v1/readyz',
    '/api/v1/metrics',
    '/api/v1/openapi.json',
    '/healthz',
    '/readyz',
    '/metrics',
    '/openapi.json',
  ])('treats %s as anonymous', (path) => {
    expect(isAnonymousPath(path)).toBe(true);
  });

  it('ignores a query string when matching', () => {
    expect(isAnonymousPath('/api/v1/healthz?verbose=1')).toBe(true);
  });

  it('does not treat a product path as anonymous', () => {
    expect(isAnonymousPath('/api/v1/jobs')).toBe(false);
    expect(isAnonymousPath('/api/v1/healthz/../jobs')).toBe(false);
  });
});
