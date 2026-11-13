import { describe, expect, it } from 'vitest';
import * as shell from '../../src/index';
import type {
  AsyncPanelProps,
  AsyncQuery,
  SessionContextValue,
  SessionDefaults,
  SessionKit,
  SessionKitOptions,
  SessionState,
} from '../../src/index';

/**
 * The package has one entry point and the applications import only from it, so a symbol that
 * exists in `src/` but not here is unreachable in production even though every unit test passes.
 * The type-only exports are asserted at compile time (this file would not typecheck without them);
 * the runtime ones are checked below.
 */
describe('@seamnex/shell entry point', () => {
  it('exports every runtime symbol the applications mount', () => {
    expect(typeof shell.AsyncPanel).toBe('function');
    expect(typeof shell.ProductVersion).toBe('function');
    expect(typeof shell.QueryError).toBe('function');
    expect(typeof shell.SignInPage).toBe('function');
    expect(typeof shell.SignOutDialog).toBe('function');
    expect(typeof shell.UnauthorizedNotice).toBe('function');
    expect(typeof shell.useDebouncedValue).toBe('function');
    expect(typeof shell.createSessionKit).toBe('function');
    expect(typeof shell.isPlatformRole).toBe('function');
    expect(typeof shell.isScenario).toBe('function');
    expect(typeof shell.readSessionFromUrl).toBe('function');
  });

  it('publishes nothing beyond that surface', () => {
    // The exact set, not a subset: an accidental export widens the public API of every app that
    // depends on the package. `sign-in-stub` is internal — `sign-in.tsx` imports it — so its two
    // symbols must stay off the barrel even though they are tested directly.
    expect(Object.keys(shell).sort()).toEqual([
      'AsyncPanel',
      'ProductVersion',
      'QueryError',
      'SignInPage',
      'SignOutDialog',
      'UnauthorizedNotice',
      'createSessionKit',
      'isPlatformRole',
      'isScenario',
      'readSessionFromUrl',
      'useDebouncedValue',
    ]);
  });

  it('exposes the session types through the same entry point', () => {
    const session: SessionState = { role: 'R5', scenario: 'degraded', latencyMs: 0 };
    const defaults: SessionDefaults = { defaultRole: 'R5', defaultLatencyMs: 0 };
    const options: SessionKitOptions = defaults;
    const kit: SessionKit = shell.createSessionKit(options);
    const value: SessionContextValue['session'] = session;
    const query: AsyncQuery<string> = {
      isPending: false,
      isError: false,
      data: 'x',
      error: null,
      refetch: () => undefined,
    };
    const props: AsyncPanelProps<string> = { query, children: (data) => data };

    expect(kit.readSession()).toEqual({ role: 'R5', scenario: 'degraded', latencyMs: 0 });
    expect(value).toBe(session);
    expect(props.query.data).toBe('x');
  });
});
