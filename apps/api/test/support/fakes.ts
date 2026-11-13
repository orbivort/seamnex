import type { Pool, PoolClient, QueryResult } from 'pg';

/**
 * Test doubles for the two pieces of infrastructure every service reaches for: the Postgres pool
 * and Redis. They are deliberately *routing* fakes rather than `vi.mock` of `pg`: a service states
 * what it needs in SQL, so a test can answer a statement by what it selects and assert on the
 * parameters it received. Nothing here simulates a schema — an unexpected statement is a failure
 * with the SQL in the message, which is what makes a new query in production code visible.
 */

export type Row = Record<string, unknown>;

export type QueryCall = { readonly sql: string; readonly params: readonly unknown[] };

export type RouteResult =
  Row[] | QueryResult | ((sql: string, params: readonly unknown[]) => unknown) | unknown;

export type Route = readonly [matcher: string | RegExp, result: RouteResult];

function matches(matcher: string | RegExp, sql: string): boolean {
  return typeof matcher === 'string' ? sql.includes(matcher) : matcher.test(sql);
}

function asResult(value: unknown, sql: string): QueryResult {
  if (Array.isArray(value)) {
    return { rows: value as Row[], rowCount: value.length, command: '', oid: 0, fields: [] };
  }
  if (typeof value === 'object' && value !== null && 'rows' in value) {
    return value as QueryResult;
  }
  throw new Error(`fake pg: route for "${sql}" returned neither rows nor a QueryResult`);
}

export type FakeDb = {
  readonly pool: Pool;
  readonly calls: QueryCall[];
  /** Statements that matched no route, in order. A clean test leaves this empty. */
  readonly unmatched: string[];
  readonly client: PoolClient;
};

const TRANSACTION_VERBS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'START TRANSACTION']);

function isTransactionVerb(sql: string): boolean {
  return TRANSACTION_VERBS.has(sql.trim().toUpperCase());
}

/**
 * @param routes ordered matchers; the first match answers the statement.
 * @param options.allowUnmatched keep going on an unknown statement instead of throwing. Used by
 *   tests that only care that a statement was issued, not what it returned.
 */
export function fakeDb(
  routes: readonly Route[] = [],
  options: { allowUnmatched?: boolean } = {},
): FakeDb {
  const calls: QueryCall[] = [];
  const unmatched: string[] = [];

  const answer = async (sql: string, params: readonly unknown[] = []): Promise<QueryResult> => {
    calls.push({ sql, params });
    if (isTransactionVerb(sql)) return asResult([], sql);
    for (const [matcher, result] of routes) {
      if (!matches(matcher, sql)) continue;
      // A route may be a value, a row-producing function, or a promise (for failure paths).
      const produced =
        typeof result === 'function'
          ? (result as (s: string, p: readonly unknown[]) => unknown)(sql, params)
          : result;
      return asResult(await produced, sql);
    }
    unmatched.push(sql);
    if (options.allowUnmatched === true) return asResult([], sql);
    throw new Error(`fake pg: no route for statement:\n${sql.trim()}`);
  };

  const client = {
    query: (sql: string, params?: readonly unknown[]) => answer(sql, params ?? []),
    release: () => undefined,
  } as unknown as PoolClient;

  const pool = {
    query: (sql: string, params?: readonly unknown[]) => answer(sql, params ?? []),
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool;

  return { pool, calls, unmatched, client };
}

/** A pool whose every statement fails with `error`, for the failure paths. */
export function failingDb(error: Error = new Error('database unavailable')): FakeDb {
  const calls: QueryCall[] = [];
  const fail = (sql: string, params: readonly unknown[] = []): Promise<never> => {
    calls.push({ sql, params });
    return Promise.reject(error);
  };
  const client = { query: fail, release: () => undefined } as unknown as PoolClient;
  const pool = {
    query: fail,
    connect: () => Promise.reject(error),
    end: () => Promise.resolve(),
  } as unknown as Pool;
  return { pool, calls, unmatched: [], client };
}

export type FakeRedis = {
  readonly multi: () => FakeRedis;
  readonly incr: (...args: unknown[]) => FakeRedis;
  readonly pexpire: (...args: unknown[]) => FakeRedis;
  readonly exec: () => Promise<unknown>;
  readonly pttl: () => Promise<number>;
  readonly get: () => Promise<string | null>;
  readonly set: () => Promise<'OK'>;
  readonly del: () => Promise<number>;
  readonly ping: () => Promise<'PONG'>;
};

/** A Redis double: the limiter uses `multi().incr().pexpire().exec()` and `pttl`. */
export function fakeRedis(
  options: {
    count?: number;
    ttl?: number;
    fail?: Error;
    on?: (command: string, args: readonly unknown[]) => unknown;
  } = {},
): FakeRedis & { readonly commands: string[] } {
  const commands: string[] = [];
  const record = (command: string, args: readonly unknown[]): unknown => {
    commands.push(command);
    if (options.fail !== undefined) throw options.fail;
    return options.on?.(command, args);
  };
  const self: FakeRedis & { readonly commands: string[] } = {
    commands,
    multi: () => {
      record('multi', []);
      return self;
    },
    incr: (...args) => {
      record('incr', args);
      return self;
    },
    pexpire: (...args) => {
      record('pexpire', args);
      return self;
    },
    exec: () => {
      record('exec', []);
      return Promise.resolve([[null, options.count ?? 1]]);
    },
    pttl: () => {
      record('pttl', []);
      return Promise.resolve(options.ttl ?? 1_000);
    },
    get: () => {
      record('get', []);
      return Promise.resolve(null);
    },
    set: () => {
      record('set', []);
      return Promise.resolve('OK' as const);
    },
    del: () => {
      record('del', []);
      return Promise.resolve(1);
    },
    ping: () => {
      record('ping', []);
      return Promise.resolve('PONG' as const);
    },
  };
  return self;
}

/** Deterministic `Response` for the `fetch` seam some clients accept. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

/**
 * A relay-cache Redis double with the one property the real thing has and a stub does not:
 * `SCAN MATCH` applies glob semantics.
 *
 * A double that answers "no keys" for every pattern hid the defect it was supposed to catch — the
 * revocation walk escaped its own `*`, matched nothing, and the test still passed because it only
 * asserted that `scan` had been called. This one evaluates the pattern, so a pattern that matches
 * nothing is visibly a test failure.
 */
export type FakeRelayRedis = {
  readonly store: Map<string, string>;
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string, ...args: readonly unknown[]) => Promise<'OK' | null>;
  readonly del: (...keys: string[]) => Promise<number>;
  readonly scan: (cursor: string, ...args: readonly string[]) => Promise<[string, string[]]>;
  /** The lock-release script: compare-and-delete, as the production Lua does. */
  readonly eval: (script: string, keys: number, key: string, token: string) => Promise<number>;
};

export function fakeRelayRedis(initial: Record<string, string> = {}): FakeRelayRedis {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value, ...args) => {
      // The relay writes with `EX <seconds>` and `NX` for the lock; only existence matters here.
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK' as const;
    },
    del: async (...keys) => {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    },
    scan: async (_cursor, ...args) => {
      const pattern = args[args.indexOf('MATCH') + 1] ?? '*';
      return ['0', [...store.keys()].filter((key) => globMatches(pattern, key))];
    },
    eval: async (_script, _keys, key, token) => {
      if (store.get(key) !== token) return 0;
      store.delete(key);
      return 1;
    },
  };
}

/**
 * Redis `MATCH` semantics for the grammar these patterns use: `*`, `?` and a backslash escape.
 *
 * Exported because a test that stubs `SCAN` must answer with the same semantics — a double that
 * ignores the pattern is what let a revocation walk that matched nothing pass its tests.
 */
export function globMatches(pattern: string, key: string): boolean {
  return globToRegExp(pattern).test(key);
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === '\\' && index + 1 < pattern.length) {
      index += 1;
      source += escapeRegExp(pattern[index] as string);
      continue;
    }
    if (character === '*') {
      source += '.*';
      continue;
    }
    if (character === '?') {
      source += '.';
      continue;
    }
    source += escapeRegExp(character);
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
