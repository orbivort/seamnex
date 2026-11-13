import { vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

/**
 * Doubles for the `pg` driver.
 *
 * The unit project must not need a datastore, so every module that touches `pg` is exercised
 * through these instead of a throwaway database. They live under `test/` on purpose: `coverage.include`
 * is `src/**`, so a double cannot inflate the numbers it helps produce.
 */

/** What one faked statement returns. `rowCount: null` is what `pg` reports for a `SELECT`. */
export type FakeResult = { rows: unknown[]; rowCount: number | null };

export type FakeBehaviour = {
  readonly match: RegExp;
  readonly handle: (sql: string, params: readonly unknown[]) => FakeResult;
};

const EMPTY_RESULT: FakeResult = { rows: [], rowCount: 0 };

export type FakePoolOptions = {
  readonly behaviours?: readonly FakeBehaviour[];
  /** Return a value to throw for a statement no behaviour matched; `undefined` lets it through. */
  readonly failWith?: (sql: string, params: readonly unknown[]) => unknown;
};

export type FakePoolHandle = {
  readonly pool: Pool;
  /** Every statement issued through the pool or one of its clients, in order. */
  readonly statements: string[];
  readonly connect: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
};

/**
 * A pool whose `query` and `connect().query` both run the same scripted responder, so a test can
 * assert the exact statement sequence a helper produced.
 */
export function createFakePool(options: FakePoolOptions = {}): FakePoolHandle {
  const statements: string[] = [];
  const release = vi.fn();
  const end = vi.fn(() => Promise.resolve(undefined));

  const run = (sql: string, params: readonly unknown[] = []): Promise<FakeResult> => {
    statements.push(sql);
    for (const behaviour of options.behaviours ?? []) {
      if (behaviour.match.test(sql)) return Promise.resolve(behaviour.handle(sql, params));
    }
    const thrown = options.failWith?.(sql, params);
    // Rejected rather than thrown: the driver reports a failed statement as a rejection, and a
    // synchronous throw here would skip the `await` the module under test relies on.
    if (thrown !== undefined) return Promise.reject(thrown);
    return Promise.resolve(EMPTY_RESULT);
  };

  const connect = vi.fn(() =>
    Promise.resolve({ query: vi.fn(run), release } as unknown as PoolClient),
  );

  return {
    pool: { query: vi.fn(run), connect, end, on: vi.fn() } as unknown as Pool,
    statements,
    connect,
    end,
    release,
  };
}

export type LedgerEntry = {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt?: Date;
  readonly durationMs?: number;
};

export type LedgerRow = { checksum: string; appliedAt: Date; durationMs: number };

export type LedgerPoolHandle = FakePoolHandle & { readonly ledger: Map<string, LedgerRow> };

export type LedgerPoolOptions = {
  readonly entries?: readonly LedgerEntry[];
  readonly failWith?: FakePoolOptions['failWith'];
};

/**
 * An in-memory `schema_migration` ledger behind the statements `migrate.ts` actually issues.
 *
 * Matching is by statement shape rather than by call order, so a test asserts behaviour (this
 * migration ran, this row was written) instead of a brittle script of expectations.
 */
export function createLedgerPool(options: LedgerPoolOptions = {}): LedgerPoolHandle {
  const ledger = new Map<string, LedgerRow>();
  for (const entry of options.entries ?? []) {
    ledger.set(entry.id, {
      checksum: entry.checksum,
      appliedAt: entry.appliedAt ?? new Date('2025-01-01T00:00:00.000Z'),
      durationMs: entry.durationMs ?? 1,
    });
  }

  const behaviours: FakeBehaviour[] = [
    {
      match: /CREATE TABLE IF NOT EXISTS schema_migration/,
      handle: () => ({ rows: [], rowCount: null }),
    },
    {
      match: /SELECT id, checksum FROM schema_migration/,
      handle: () => ({
        rows: [...ledger.entries()].map(([id, row]) => ({ id, checksum: row.checksum })),
        rowCount: ledger.size,
      }),
    },
    {
      match: /SELECT id FROM schema_migration ORDER BY id DESC LIMIT/,
      handle: (_sql, params) => {
        const limit = Number(params[0] ?? 0);
        const rows = [...ledger.keys()]
          .sort((left, right) => right.localeCompare(left))
          .slice(0, limit)
          .map((id) => ({ id }));
        return { rows, rowCount: rows.length };
      },
    },
    {
      match: /SELECT id, applied_at, duration_ms FROM schema_migration/,
      handle: () => {
        const rows = [...ledger.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, row]) => ({
            id,
            applied_at: row.appliedAt,
            duration_ms: row.durationMs,
          }));
        return { rows, rowCount: rows.length };
      },
    },
    {
      match: /INSERT INTO schema_migration/,
      handle: (_sql, params) => {
        ledger.set(String(params[0]), {
          checksum: String(params[1]),
          appliedAt: new Date('2025-01-01T00:00:00.000Z'),
          durationMs: Number(params[2] ?? 0),
        });
        return { rows: [], rowCount: 1 };
      },
    },
    {
      match: /DELETE FROM schema_migration WHERE id = \$1/,
      handle: (_sql, params) => ({ rows: [], rowCount: ledger.delete(String(params[0])) ? 1 : 0 }),
    },
  ];

  const base =
    options.failWith === undefined
      ? createFakePool({ behaviours })
      : createFakePool({ behaviours, failWith: options.failWith });

  return { ...base, ledger };
}

/**
 * The `Pool` class `client.test.ts` injects in place of `pg`'s, so constructor options and the
 * idle-error listener can be inspected without opening a socket.
 */
export class FakePgPool {
  static instances: FakePgPool[] = [];

  readonly config: Record<string, unknown>;
  readonly queries: string[] = [];
  ended = false;
  private readonly errorHandlers: Array<(error: Error) => void> = [];

  constructor(config: Record<string, unknown>) {
    this.config = config;
    FakePgPool.instances.push(this);
  }

  static reset(): void {
    FakePgPool.instances.length = 0;
  }

  static last(): FakePgPool {
    const instance = FakePgPool.instances.at(-1);
    if (instance === undefined) throw new Error('no pool was created');
    return instance;
  }

  on(event: string, handler: (error: Error) => void): this {
    if (event === 'error') this.errorHandlers.push(handler);
    return this;
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  query(sql: string): Promise<FakeResult> {
    this.queries.push(sql);
    return Promise.resolve(EMPTY_RESULT);
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

/** The first item of a list, without a non-null assertion (the repo forbids those). */
export function firstOf<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error('expected at least one item');
  return first;
}
