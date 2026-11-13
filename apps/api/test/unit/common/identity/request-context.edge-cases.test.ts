import { describe, expect, it, vi } from 'vitest';
import {
  currentContext,
  isAnonymousPath,
  requireContext,
  runWithContext,
} from '../../../../src/common/identity/request-context';
import { currentRequestId } from '../../../../src/common/logging/logger';
import { AppError } from '../../../../src/common/problem/app-error';
import { testContext } from '../../../support/operation-input';

/**
 * Two properties of the store that a handler depends on without ever seeing:
 *
 * - the context survives `await`. A service that awaits a database call and then attributes an
 *   audit row is three async hops away from the resolver; `AsyncLocalStorage` is what makes that
 *   work, and a regression to a module-level variable passes every synchronous test;
 * - the anonymous-path match is exact. `/healthz/` and `/Healthz` are *not* the probe route, so
 *   they must resolve an identity — a prefix or case-insensitive match would let an unauthenticated
 *   caller reach a path the platform never declared as anonymous.
 */
describe('context propagation across await', () => {
  it('is still bound after an awaited call inside the same request', async () => {
    const context = testContext({ requestId: 'rid-async' });

    const observed = await runWithContext(context, async () => {
      await Promise.resolve();
      const afterOneHop = currentContext()?.requestId;
      await new Promise((resolve) => setImmediate(resolve));
      return { afterOneHop, afterTimer: requireContext().requestId, log: currentRequestId() };
    });

    expect(observed).toEqual({
      afterOneHop: 'rid-async',
      afterTimer: 'rid-async',
      log: 'rid-async',
    });
    expect(currentContext()).toBeUndefined();
  });

  it('does not leak into a concurrent request that starts outside it', async () => {
    const first = runWithContext(testContext({ requestId: 'rid-1' }), async () => {
      await Promise.resolve();
      return currentContext()?.requestId;
    });
    const second = runWithContext(testContext({ requestId: 'rid-2' }), async () => {
      await Promise.resolve();
      return currentContext()?.requestId;
    });

    await expect(Promise.all([first, second])).resolves.toEqual(['rid-1', 'rid-2']);
  });
});

describe('anonymous path matching', () => {
  it('does not accept a trailing slash the platform never declared', () => {
    expect(isAnonymousPath('/healthz/')).toBe(false);
    expect(isAnonymousPath('/api/v1/metrics/')).toBe(false);
  });

  it('is case-sensitive, because the router is', () => {
    expect(isAnonymousPath('/Healthz')).toBe(false);
    expect(isAnonymousPath('/API/v1/healthz')).toBe(false);
  });

  it('matches on the path only, so a probe query string cannot smuggle a route', () => {
    expect(isAnonymousPath('/metrics?since=1&until=2')).toBe(true);
    expect(isAnonymousPath('/jobs?next=/healthz')).toBe(false);
    // A `?` in first position leaves an empty path, which is not anonymous either.
    expect(isAnonymousPath('?path=/healthz')).toBe(false);
  });

  it('accepts a bare `?` or a query containing another `?`', () => {
    expect(isAnonymousPath('/healthz?')).toBe(true);
    expect(isAnonymousPath('/readyz?probe=1?probe=2')).toBe(true);
  });

  it('is exact about the path shape, so no neighbour inherits anonymity', () => {
    expect(isAnonymousPath('')).toBe(false);
    expect(isAnonymousPath('/')).toBe(false);
    expect(isAnonymousPath('//healthz')).toBe(false);
    expect(isAnonymousPath('/healthz/live')).toBe(false);
    expect(isAnonymousPath('/api/v1/healthz/live')).toBe(false);
    expect(isAnonymousPath('/api/v1/healthzz')).toBe(false);
    expect(isAnonymousPath('healthz')).toBe(false);
  });
});

/**
 * `isAnonymousPath` ends in `path.split('?')[0] ?? path`, and no `string` can take the right-hand
 * side: `split` always yields at least one element, even for `''`. The fallback is there because
 * `noUncheckedIndexedAccess` types the index as possibly absent, and its whole job is to keep the
 * value the caller passed instead of letting it decay into `undefined`. The two outcomes are
 * indistinguishable from the return value — `ANONYMOUS_PATHS.has(undefined)` is `false` too — so
 * these tests stub `split` and watch the argument the lookup actually receives.
 */
describe('anonymous path fallback when split yields no first segment', () => {
  /** A `string` whose `split` cannot produce a first segment; unreachable through real input. */
  function withoutFirstSegment(segments: string[]): string {
    return { split: () => segments } as unknown as string;
  }

  /** Runs the match with `Set.prototype.has` watched, so the looked-up value is observable. */
  function observeLookup(path: string): { matched: boolean; lookedUp: unknown[] } {
    const has = vi.spyOn(Set.prototype, 'has');
    try {
      return {
        matched: isAnonymousPath(path),
        lookedUp: has.mock.calls.map(([value]) => value),
      };
    } finally {
      has.mockRestore();
    }
  }

  it('looks the original value up rather than undefined, and refuses it', () => {
    const path = withoutFirstSegment([]);

    const { matched, lookedUp } = observeLookup(path);

    expect(matched).toBe(false);
    expect(lookedUp).toContain(path);
    expect(lookedUp).not.toContain(undefined);
  });

  it('falls back for a sparse list, where the first index is absent rather than empty', () => {
    const path = withoutFirstSegment(new Array<string>(1));

    const { matched, lookedUp } = observeLookup(path);

    expect(matched).toBe(false);
    expect(lookedUp).toContain(path);
  });

  it('does not stringify the fallback, so an anonymous-looking value is still refused', () => {
    // `Set.has` compares with SameValueZero, never by coercion: an object that claims to be
    // `/healthz` must not inherit the probe route's anonymity through the fallback path.
    const path = { split: () => [], toString: () => '/healthz' } as unknown as string;

    expect(isAnonymousPath(path)).toBe(false);
  });
});

/**
 * `requireContext` is the one identity call a handler cannot skip, so its failure has to be a
 * rendered refusal rather than a bare `Error`: the problem filter only knows how to render an
 * `AppError`, and an unwrapped throw would reach the client as an opaque 500.
 */
describe('requireContext failure contract', () => {
  function captureThrow(run: () => unknown): unknown {
    try {
      run();
      throw new Error('expected requireContext to throw');
    } catch (caught) {
      return caught;
    }
  }

  it('refuses with a renderable AppError that names the remedy', () => {
    const error = captureThrow(() => requireContext());

    expect(error).toBeInstanceOf(AppError);
    const refusal = error as AppError;
    expect(refusal.name).toBe('AppError');
    expect(refusal.code).toBe('UNAUTHORIZED');
    expect(refusal.remediation).toBeDefined();
    expect(refusal.remediation).toContain('Sign in');
    // No status is pinned here: the catalogue decides that UNAUTHORIZED is a 401.
    expect(refusal.status).toBeUndefined();
    expect(refusal.fieldErrors).toEqual([]);
    expect(refusal.headers).toBeUndefined();
  });

  it('uses the innermost context when a request nests another', () => {
    const outer = testContext({ requestId: 'outer' });
    const inner = testContext({ requestId: 'inner' });

    const observed = runWithContext(outer, () => {
      const outside = requireContext().requestId;
      const nested = runWithContext(inner, () => requireContext().requestId);
      return { outside, nested, after: requireContext().requestId };
    });

    expect(observed).toEqual({ outside: 'outer', nested: 'inner', after: 'outer' });
  });

  it('is unavailable in a continuation started before the request began', async () => {
    const context = testContext({ requestId: 'rid-late' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Captured outside any `runWithContext` callback, so `AsyncLocalStorage` binds nothing to it.
    const detached = gate.then(() => ({ identity: currentContext(), log: currentRequestId() }));

    runWithContext(context, () => release());

    await expect(detached).resolves.toEqual({ identity: undefined, log: undefined });
  });
});

/**
 * The stores are ambient state, so every path out of `runWithContext` — a value, a synchronous
 * throw, a rejected promise — must remove them again. A leak would attach the previous request's
 * subject to the next unit of work on the same process.
 */
describe('runWithContext teardown', () => {
  it('unbinds both stores after a synchronous throw and rethrows the original error', () => {
    const boom = new Error('sync boom');

    expect(() =>
      runWithContext(testContext({ requestId: 'rid-sync' }), () => {
        throw boom;
      }),
    ).toThrow(boom);

    expect(currentContext()).toBeUndefined();
    expect(currentRequestId()).toBeUndefined();
  });

  it('unbinds both stores after a rejected promise without swallowing the reason', async () => {
    await expect(
      runWithContext(testContext({ requestId: 'rid-async' }), async () => {
        await Promise.resolve();
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');

    expect(currentContext()).toBeUndefined();
    expect(currentRequestId()).toBeUndefined();
  });

  it('returns undefined unchanged when the callback produces no value', () => {
    expect(runWithContext(testContext(), () => undefined)).toBeUndefined();
    expect(currentContext()).toBeUndefined();
  });

  it('binds the process role, not the subject role, in the logging store', () => {
    const observed = runWithContext(
      testContext({ processRole: 'deploy-worker', role: 'R1' }),
      () => ({ log: currentRequestId(), role: currentContext()?.processRole }),
    );

    // `R1` is what the human may do; `deploy-worker` is what this process is, and pino's base
    // field must describe the process or every log line from a worker would look like a request.
    expect(observed).toEqual({ log: 'rid-test', role: 'deploy-worker' });
  });

  it('restores the outer logging store when an inner context ends', () => {
    const observed = runWithContext(testContext({ requestId: 'outer-log' }), () => {
      const before = currentRequestId();
      const nested = runWithContext(testContext({ requestId: 'inner-log' }), () =>
        currentRequestId(),
      );
      return { before, nested, after: currentRequestId() };
    });

    expect(observed).toEqual({ before: 'outer-log', nested: 'inner-log', after: 'outer-log' });
  });

  it('keeps the context reference intact, so identity fields cannot be re-derived per call', () => {
    const context = testContext();

    const observed = runWithContext(context, () => ({
      same: currentContext() === context,
      subject: currentContext()?.subject,
      scopes: currentContext()?.scopes,
    }));

    expect(observed.same).toBe(true);
    expect(observed.subject).toBe(context.subject);
    expect(observed.scopes).toBe(context.scopes);
  });
});
