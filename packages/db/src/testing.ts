import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool } from './client';
import { migrateUp } from './migrate';

/**
 * Integration-test support, shared by `@seamnex/db` and `@seamnex/api`.
 *
 * Two properties every suite needs, and the API suite did not have:
 *   - a **throwaway database**, so a test run cannot touch the developer's data;
 *   - an explicit opt-in, so a silently skipped suite is impossible in CI.
 */

export const ADMIN_URL = process.env.SEAMNEX_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
export const hasDatabase = ADMIN_URL.length > 0;

const SKIP_REASON =
  'Set SEAMNEX_TEST_DATABASE_URL (or DATABASE_URL) to a disposable PostgreSQL 18 to run the schema suite.';

/**
 * `SEAMNEX_REQUIRE_DATABASE_TESTS=1` turns "skipped" into "failed". CI sets it, because a green run that
 * skipped the schema, the invariants and the audit chain is worse than a red one.
 */
export function skipUnlessDatabase(): string | false {
  if (hasDatabase) return false;
  if (process.env.SEAMNEX_REQUIRE_DATABASE_TESTS === '1') {
    throw new Error(`SEAMNEX_REQUIRE_DATABASE_TESTS=1 but no database URL is set. ${SKIP_REASON}`);
  }
  return SKIP_REASON;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

export type TestDatabase = {
  readonly url: string;
  readonly pool: Pool;
  readonly admin: Pool;
  /** A client with `SET ROLE seamnex_app` applied: grants and triggers are exercised as that role. */
  appClient: () => Promise<PoolClient>;
  drop: () => Promise<void>;
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = createPool({
    connectionString: ADMIN_URL,
    max: 2,
    applicationName: 'seamnex-test-admin',
  });
  const name = `seamnex_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
  const url = withDatabase(ADMIN_URL, name);
  const pool = createPool({ connectionString: url, max: 4, applicationName: 'seamnex-test' });

  try {
    await migrateUp({ pool });
  } catch (error) {
    await pool.end().catch(() => undefined);
    await admin
      .query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`)
      .catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw error;
  }

  return {
    url,
    pool,
    admin,
    appClient: async () => {
      const client = await pool.connect();
      await client.query('SET ROLE seamnex_app');
      return client;
    },
    drop: async () => {
      await pool.end().catch(() => undefined);
      await admin
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`)
        .catch(() => undefined);
      await admin.end().catch(() => undefined);
    },
  };
}

/** Inserts the minimum rows a foreign key needs, without duplicating test setup in every case. */
export async function insertCatalogEntry(pool: Pool | PoolClient, key = 'D01-01'): Promise<void> {
  await pool.query(
    `INSERT INTO catalog_entry (key, domain, product, guarantee_class, packaging)
     VALUES ($1, 'Core Operations', 'Test', 'native', 'compose')
     ON CONFLICT (key) DO NOTHING`,
    [key],
  );
}

export async function insertInstance(
  pool: Pool | PoolClient,
  id: string,
  options: { slug?: string; entryKey?: string; state?: string; sourcePath?: string | null } = {},
): Promise<void> {
  await insertCatalogEntry(pool, options.entryKey ?? 'D01-01');
  await pool.query(
    `INSERT INTO instance (id, entry_key, slug, domain_route, state, source_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      options.entryKey ?? 'D01-01',
      options.slug ?? `slug-${id.slice(0, 8)}`,
      `host-${id.slice(0, 8)}.test`,
      options.state ?? 'ready',
      options.sourcePath ?? null,
    ],
  );
}
