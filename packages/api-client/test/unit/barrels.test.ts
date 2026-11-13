import { describe, expect, it } from 'vitest';
import * as root from '../../src/index';
import * as hooksBarrel from '../../src/hooks/index';
import * as admin from '../../src/hooks/admin';
import * as backups from '../../src/hooks/backups';
import * as catalog from '../../src/hooks/catalog';
import * as governance from '../../src/hooks/governance';
import * as instances from '../../src/hooks/instances';
import * as jobStream from '../../src/hooks/job-stream';
import * as jobs from '../../src/hooks/jobs';
import * as portal from '../../src/hooks/portal';
import * as privacy from '../../src/hooks/privacy';
import * as recovery from '../../src/hooks/recovery';
import * as workflows from '../../src/hooks/workflows';
import * as auth from '../../src/auth';
import * as http from '../../src/http';
import * as provider from '../../src/provider';
import * as prototypeTransport from '../../src/prototype-transport';
import * as queryKeysModule from '../../src/query-keys';
import * as sessionRole from '../../src/session-role';
import * as transport from '../../src/transport';

/**
 * Two barrels publish the same hook surface: `@seamnex/api-client` and `@seamnex/api-client/hooks`. The
 * subpath exists so a screen that wants one query hook does not pull the transport, the auth flow
 * and the query client into its module graph — which only holds while the two barrels agree. A hook
 * added to `src/hooks/<domain>.ts` and to one barrel but not the other is reachable in one import
 * path and absent in the other, and no per-hook suite can see it.
 *
 * Both barrels use `export *`, so a name published by two modules is dropped from both in the same
 * way. That is checked here rather than assumed: a collision would remove an export from the public
 * API silently.
 */
const HOOK_MODULES = [
  ['portal', portal],
  ['catalog', catalog],
  ['instances', instances],
  ['jobs', jobs],
  ['job-stream', jobStream],
  ['backups', backups],
  ['workflows', workflows],
  ['governance', governance],
  ['admin', admin],
  ['recovery', recovery],
  ['privacy', privacy],
] as const satisfies readonly (readonly [string, Record<string, unknown>])[];

const CORE_MODULES = [
  ['http', http],
  ['transport', transport],
  ['prototype-transport', prototypeTransport],
  ['auth', auth],
  ['session-role', sessionRole],
  ['query-keys', queryKeysModule],
  ['provider', provider],
] as const satisfies readonly (readonly [string, Record<string, unknown>])[];

const rootOf = root as Record<string, unknown>;
const hooksOf = hooksBarrel as Record<string, unknown>;

/** Every runtime symbol the given modules publish, keyed by name, with its publishing module. */
function published(
  modules: readonly (readonly [string, Record<string, unknown>])[],
): Map<string, { module: string; value: unknown }> {
  const seen = new Map<string, { module: string; value: unknown }>();
  for (const [module, namespace] of modules) {
    for (const [name, value] of Object.entries(namespace)) {
      const previous = seen.get(name);
      expect(
        previous?.module,
        `${name} is published by both ${previous?.module} and ${module}`,
      ).toBeUndefined();
      seen.set(name, { module, value });
    }
  }
  return seen;
}

describe('@seamnex/api-client/hooks entry point', () => {
  it('publishes exactly the union of the hook modules', () => {
    const hookNames = [...published(HOOK_MODULES).keys()].sort();

    expect(Object.keys(hooksBarrel).sort()).toEqual(hookNames);
  });

  it('publishes every hook as the binding its module publishes', () => {
    for (const [name, { module, value }] of published(HOOK_MODULES)) {
      expect(
        hooksOf,
        `${name} from hooks/${module} is missing from the subpath barrel`,
      ).toHaveProperty(name);
      expect(hooksOf[name], `${name} is not the same binding`).toBe(value);
    }
  });
});

describe('@seamnex/api-client root entry point', () => {
  it('publishes the same hooks as the subpath barrel, as the same bindings', () => {
    for (const name of Object.keys(hooksBarrel)) {
      expect(rootOf, `${name} is in the hooks subpath but not in the root barrel`).toHaveProperty(
        name,
      );
      expect(rootOf[name], `${name} differs between the two barrels`).toBe(hooksOf[name]);
    }
  });

  it('publishes every symbol of the transport, auth and session modules', () => {
    for (const [name, { module, value }] of published(CORE_MODULES)) {
      expect(rootOf, `${name} from ${module} is missing from the root barrel`).toHaveProperty(name);
      expect(rootOf[name], `${name} is not the same binding`).toBe(value);
    }
  });

  it('publishes nothing the modules do not publish', () => {
    const known = new Set([...published(CORE_MODULES).keys(), ...published(HOOK_MODULES).keys()]);

    expect(Object.keys(root).filter((key) => !known.has(key))).toEqual([]);
  });

  it('publishes no runtime key for a type-only export', () => {
    const keys = Object.keys(root);

    for (const name of [
      'RequestOptions',
      'FetchTransportOptions',
      'HttpMethod',
      'Transport',
      'TransportRequest',
      'PrototypeTransportOptions',
      'CallbackFailure',
      'CallbackOutcome',
      'SessionLocation',
      'SessionRouting',
      'ApiProviderProps',
    ]) {
      expect(keys, `${name} is a type and must not exist at runtime`).not.toContain(name);
    }
  });

  it('publishes the names the applications import', () => {
    for (const name of [
      'ApiError',
      'request',
      'openEventStream',
      'configureTransport',
      'resetTransport',
      'lastKnownStatusAt',
      'isAbortError',
      'toProblem',
      'onUnauthorized',
      'createFetchTransport',
      'DEFAULT_TIMEOUT_MS',
      'createPrototypeTransport',
      'authKeys',
      'beginSignIn',
      'codeChallengeFor',
      'completeSignIn',
      'createCodeVerifier',
      'endSession',
      'fetchSession',
      'providerLogoutUrl',
      'readServerSession',
      'rememberProviderLogout',
      'safeNextPath',
      'sessionRouting',
      'signInWithStub',
      'startSession',
      'takeProviderLogout',
      'clearAssertedRole',
      'devSignInAvailable',
      'readAssertedRole',
      'rememberAssertedRole',
      'rememberAuthProvider',
      'queryKeys',
      'ApiProvider',
      'useMe',
      'useInstances',
      'useJob',
      'useAuditPages',
    ]) {
      expect(Object.keys(root), `root barrel is missing ${name}`).toContain(name);
    }
  });
});

/**
 * The barrel's own statements are re-export bindings, so what is left to exercise is that the
 * published values are the ones a caller can use without reaching past the entry point. Edge cases
 * belong to the module suites; these are the sentinels a screen depends on.
 */
describe('the entry point is usable as the only import', () => {
  it('keeps the timeout a caller can override as a number', () => {
    expect(root.DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  it('returns the same key object from queryKeys on every call', () => {
    expect(root.queryKeys).toBe(queryKeysModule.queryKeys);
    expect(root.queryKeys.me).toEqual(['me']);
    expect(root.queryKeys.instances).toEqual(['instances']);
  });

  it('rejects a next path that leaves the application or re-enters sign-in', () => {
    expect(root.safeNextPath('/instances/42')).toBe('/instances/42');
    expect(root.safeNextPath('//evil.example')).toBe('/');
    expect(root.safeNextPath('https://evil.example')).toBe('/');
    expect(root.safeNextPath('/sign-in/callback')).toBe('/');
    expect(root.safeNextPath(null)).toBe('/');
  });

  it('derives an S256 challenge that is stable for the same verifier and differs otherwise', async () => {
    const first = await root.codeChallengeFor('verifier-a');
    const second = await root.codeChallengeFor('verifier-a');
    const other = await root.codeChallengeFor('verifier-b');

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    // base64url, unpadded: no `+`, `/` or `=`.
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('publishes the API error as a throwable class carrying the problem document', () => {
    const problem = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Slug already in use',
      code: 'slug_taken',
      fieldErrors: [],
      remediation: 'Choose another slug',
    };

    expect(root.ApiError).toBe(http.ApiError);

    const error = new root.ApiError(problem, { retryAfterMs: 1_200 });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.message).toBe('Conflict');
    expect(error.problem).toBe(problem);
    expect(error.retryAfterMs).toBe(1_200);
    expect(new root.ApiError(problem).retryAfterMs).toBeNull();
  });
});
