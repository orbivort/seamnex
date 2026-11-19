import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import {
  javaDatabaseSeeded,
  scanCacheDir,
  scanDbMode,
  scannerNetwork,
  vulnDatabaseRepository,
  vulnDatabaseStatus,
} from '../../../../src/common/docker/vuln-db';

/**
 * NFR-4.6 / S-10 — the database the scan is allowed to use.
 *
 * A scanner with no network can only answer from a cache on disk, so the cache's existence and age
 * become part of the control: a missing database is "we could not look", and an old one is the same
 * claim with a stale answer. Both must be `error`, never a pass, and the age is read from what the
 * database says about itself rather than from when the process started.
 */
function cache(
  options: { updatedAt?: Date; metadata?: boolean; java?: boolean; dbMtime?: Date } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-vuln-db-'));
  mkdirSync(join(dir, 'db'), { recursive: true });
  const database = join(dir, 'db', 'trivy.db');
  writeFileSync(database, 'database');
  if (options.dbMtime !== undefined) utimesSync(database, options.dbMtime, options.dbMtime);
  if (options.metadata !== false) {
    writeFileSync(
      join(dir, 'db', 'metadata.json'),
      JSON.stringify({ Version: 2, DownloadedAt: (options.updatedAt ?? new Date()).toISOString() }),
      'utf8',
    );
  }
  if (options.java !== false) {
    mkdirSync(join(dir, 'java-db'), { recursive: true });
    writeFileSync(join(dir, 'java-db', 'trivy-java.db'), 'java database');
  }
  return dir;
}

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    SEAMNEX_SCAN_DB_MODE: 'cached',
    SEAMNEX_SCAN_CACHE_DIR: cache(),
    SEAMNEX_SCAN_DB_MAX_AGE_HOURS: 168,
    SEAMNEX_SCAN_DB_REPOSITORY: 'ghcr.io/aquasec/trivy-db',
    SEAMNEX_SCAN_NETWORK: '',
    ...overrides,
  } as unknown as AppConfig;
}

describe('vulnDatabaseStatus', () => {
  it('accepts a cache seeded inside the limit and reports the timestamp it read', () => {
    const updatedAt = new Date('2026-11-18T06:00:00Z');
    const status = vulnDatabaseStatus(
      config({ SEAMNEX_SCAN_CACHE_DIR: cache({ updatedAt }) }),
      new Date('2026-11-19T06:00:00Z'),
    );

    if (!status.ok) throw new Error(`expected a usable database, got: ${status.failure}`);
    expect(status.updatedAt?.toISOString()).toBe(updatedAt.toISOString());
  });

  it('refuses a cache that was never seeded and names the seeding command', () => {
    const empty = mkdtempSync(join(tmpdir(), 'seamnex-vuln-db-empty-'));
    const status = vulnDatabaseStatus(config({ SEAMNEX_SCAN_CACHE_DIR: empty }));

    expect(status).toMatchObject({ ok: false, mode: 'cached' });
    expect(status.ok === false ? status.failure : '').toContain('pnpm scan:db:update');
  });

  it('refuses a directory that holds metadata but no database', () => {
    const empty = mkdtempSync(join(tmpdir(), 'seamnex-vuln-db-partial-'));
    mkdirSync(join(empty, 'db'), { recursive: true });
    // An interrupted download leaves this behind; it must not read as a usable database.
    writeFileSync(join(empty, 'db', 'metadata.json'), '{"Version":2}', 'utf8');

    const status = vulnDatabaseStatus(config({ SEAMNEX_SCAN_CACHE_DIR: empty }));

    expect(status.ok).toBe(false);
    expect(status.ok === false ? status.failure : '').toContain(
      'no vulnerability database is present',
    );
  });

  it('refuses a cached scan with no cache directory at all', () => {
    const status = vulnDatabaseStatus(config({ SEAMNEX_SCAN_CACHE_DIR: '' }));

    expect(status.ok).toBe(false);
    expect(status.ok === false ? status.failure : '').toContain('SEAMNEX_SCAN_CACHE_DIR');
  });

  it('falls back to the shipped age limit when the configured one is not a limit', () => {
    // 100 h old: accepted by the 168 h default, refused by the `0` the config carries.
    const hundredHours = cache({ updatedAt: new Date(Date.now() - 100 * 3_600_000) });
    const status = vulnDatabaseStatus(
      config({ SEAMNEX_SCAN_CACHE_DIR: hundredHours, SEAMNEX_SCAN_DB_MAX_AGE_HOURS: 0 }),
    );

    expect(status.ok).toBe(true);
  });

  it('accepts a timestamp in the future rather than reporting a negative age', () => {
    // A clock that moved backwards is not freshness worth blocking on.
    const future = cache({ updatedAt: new Date(Date.now() + 6 * 3_600_000) });
    expect(vulnDatabaseStatus(config({ SEAMNEX_SCAN_CACHE_DIR: future })).ok).toBe(true);
  });

  it('falls back to the file for every shape of unusable metadata', () => {
    // Truncated, non-string, blank and unparsable: each one must read as "ask the file", never crash.
    const shapes = [
      '{',
      '{"DownloadedAt":123}',
      '{"DownloadedAt":"   "}',
      '{"DownloadedAt":"soon"}',
    ];
    for (const metadata of shapes) {
      const dir = cache({ metadata: false });
      writeFileSync(join(dir, 'db', 'metadata.json'), metadata, 'utf8');
      expect(vulnDatabaseStatus(config({ SEAMNEX_SCAN_CACHE_DIR: dir })).ok).toBe(true);
    }
  });

  it('refuses a database older than the limit rather than scanning on it', () => {
    const stale = cache({ updatedAt: new Date('2026-11-01T06:00:00Z') });
    const status = vulnDatabaseStatus(
      config({ SEAMNEX_SCAN_CACHE_DIR: stale, SEAMNEX_SCAN_DB_MAX_AGE_HOURS: 24 }),
      new Date('2026-11-19T06:00:00Z'),
    );

    expect(status.ok).toBe(false);
    expect(status.ok === false ? status.failure : '').toContain('over the 24 h limit');
  });

  it('trusts the declared timestamp over a file that was touched recently', () => {
    const old = cache({
      updatedAt: new Date('2026-11-01T06:00:00Z'),
      dbMtime: new Date('2026-11-19T05:00:00Z'),
    });

    const status = vulnDatabaseStatus(
      config({ SEAMNEX_SCAN_CACHE_DIR: old, SEAMNEX_SCAN_DB_MAX_AGE_HOURS: 24 }),
      new Date('2026-11-19T06:00:00Z'),
    );

    expect(status.ok).toBe(false);
  });

  it('falls back to the database file when there is no metadata to read', () => {
    const fresh = cache({ metadata: false, dbMtime: new Date('2026-11-19T05:00:00Z') });
    const status = vulnDatabaseStatus(
      config({ SEAMNEX_SCAN_CACHE_DIR: fresh, SEAMNEX_SCAN_DB_MAX_AGE_HOURS: 24 }),
      new Date('2026-11-19T06:00:00Z'),
    );

    expect(status.ok).toBe(true);

    const unreadable = cache({ metadata: false });
    // A metadata file that is present but says nothing usable is no better than an absent one.
    writeFileSync(join(unreadable, 'db', 'metadata.json'), '{"DownloadedAt":"not a date"}', 'utf8');
    expect(vulnDatabaseStatus(config({ SEAMNEX_SCAN_CACHE_DIR: unreadable })).ok).toBe(true);
  });

  it('accepts the networked modes without a local cache, because they fetch their own', () => {
    expect(
      vulnDatabaseStatus(config({ SEAMNEX_SCAN_DB_MODE: 'online', SEAMNEX_SCAN_CACHE_DIR: '' })),
    ).toMatchObject({
      ok: true,
      mode: 'online',
    });
    expect(vulnDatabaseStatus(config({ SEAMNEX_SCAN_DB_MODE: 'mirror' })).ok).toBe(true);
  });

  it('normalises a mode the schema would have rejected to the strictest one', () => {
    // A hand-built config (or a value from an older `.env`) must not widen what the scanner can do.
    expect(scanDbMode(config({ SEAMNEX_SCAN_DB_MODE: 'auto' }))).toBe('cached');
    expect(scanDbMode(config({ SEAMNEX_SCAN_DB_MODE: undefined }))).toBe('cached');
    expect(scanDbMode(config({ SEAMNEX_SCAN_DB_MODE: 'ONLINE' }))).toBe('online');
  });
});

describe('settings readers', () => {
  it('reads an absent setting as empty rather than inventing a value', () => {
    // A hand-built config in a test or a role that never parsed `.env`: the strict default holds.
    expect(scanCacheDir(config({ SEAMNEX_SCAN_CACHE_DIR: undefined }))).toBe('');
    expect(vulnDatabaseRepository(config({ SEAMNEX_SCAN_DB_REPOSITORY: undefined }))).toBe('');
    expect(scannerNetwork(config({ SEAMNEX_SCAN_NETWORK: undefined }))).toBe('none');
    expect(vulnDatabaseRepository(config())).toBe('ghcr.io/aquasec/trivy-db');
  });
});

describe('scannerNetwork', () => {
  it('keeps a cached scan offline and gives the fetching modes a route', () => {
    expect(scannerNetwork(config())).toBe('none');
    expect(scannerNetwork(config({ SEAMNEX_SCAN_DB_MODE: 'online' }))).toBe('bridge');
    expect(scannerNetwork(config({ SEAMNEX_SCAN_DB_MODE: 'mirror' }))).toBe('bridge');
  });

  it('honours a named network, which is how a mirror deployment reaches its registry', () => {
    expect(
      scannerNetwork(
        config({ SEAMNEX_SCAN_DB_MODE: 'mirror', SEAMNEX_SCAN_NETWORK: 'seamnex-control' }),
      ),
    ).toBe('seamnex-control');
  });
});

describe('javaDatabaseSeeded', () => {
  it('answers whether JAR-packaged dependencies can be covered', () => {
    expect(javaDatabaseSeeded(config({ SEAMNEX_SCAN_CACHE_DIR: cache() }))).toBe(true);
    expect(javaDatabaseSeeded(config({ SEAMNEX_SCAN_CACHE_DIR: cache({ java: false }) }))).toBe(
      false,
    );
    expect(javaDatabaseSeeded(config({ SEAMNEX_SCAN_CACHE_DIR: '' }))).toBe(false);
  });
});
