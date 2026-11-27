import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, failingDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { TrustedRegistriesReader } from '../../../../src/common/security/trusted-registries';

/**
 * NFR-4.16 — the guard every image fetch passes through.
 *
 * Three properties make this a control rather than a lookup: the allow-list is cached so a deployment
 * does not query per image, a write invalidates the cache so an operator's fix takes effect on the
 * next attempt, and an unreadable parameter is *not* a pass — an unparseable reference, an empty
 * list from a broken row and an unreachable table each have to keep the platform safe.
 */
const REVISION_QUERY = 'FROM trusted_registry_revision';

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return { trustedRegistries: [], ...overrides } as unknown as AppConfig;
}

function revisionRow(overrides: Record<string, unknown> = {}) {
  return {
    version: 4,
    content_hash: 'hash-4',
    entries: ['docker.io/library', 'ghcr.io/seamnex', 7],
    note: 'Adding the platform namespace.',
    created_by: 'usr-sofia',
    created_at: new Date('2026-11-01T10:00:00.000Z'),
    ...overrides,
  };
}

function reader(
  routes: Parameters<typeof fakeDb>[0] = [[REVISION_QUERY, [revisionRow()]]],
  options: Record<string, unknown> = {},
) {
  const db = fakeDb(routes);
  return { db, guard: new TrustedRegistriesReader(config(options), db.pool) };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('snapshot', () => {
  it('serves the newest revision, dropping a non-string member of the jsonb array', async () => {
    const { guard } = reader();

    await expect(guard.snapshot()).resolves.toEqual({
      version: 4,
      contentHash: 'hash-4',
      entries: ['docker.io/library', 'ghcr.io/seamnex'],
      note: 'Adding the platform namespace.',
      createdBy: 'usr-sofia',
      createdAt: '2026-11-01T10:00:00.000Z',
      origin: 'database',
    });
  });

  it('reads the table once inside the cache window', async () => {
    const { db, guard } = reader([
      [REVISION_QUERY, [revisionRow()]],
      [REVISION_QUERY, [revisionRow()]],
    ]);

    await guard.snapshot();
    await guard.snapshot();
    await guard.entries();

    expect(db.calls.filter((call) => call.sql.includes(REVISION_QUERY))).toHaveLength(1);
  });

  it('reads again once the window closes, so an edit elsewhere is picked up within 30 s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'));
    let version = 4;
    const { db, guard } = reader([
      [REVISION_QUERY, () => [revisionRow({ version, entries: [`ghcr.io/v${version}`] })]],
    ]);

    expect((await guard.snapshot()).version).toBe(4);

    version = 5;
    vi.setSystemTime(new Date('2026-11-01T10:00:31.000Z'));

    expect((await guard.snapshot()).version).toBe(5);
    expect(db.calls.filter((call) => call.sql.includes(REVISION_QUERY))).toHaveLength(2);
  });

  it('drops the cache on invalidation, which is how a new revision takes effect immediately', async () => {
    const { db, guard } = reader();

    await guard.snapshot();
    guard.invalidate();
    await guard.snapshot();

    expect(db.calls.filter((call) => call.sql.includes(REVISION_QUERY))).toHaveLength(2);
  });

  it('falls back to the shipped list when no revision has been written yet', async () => {
    const { guard } = reader([[REVISION_QUERY, []]]);

    const snapshot = await guard.snapshot();

    expect(snapshot).toMatchObject({
      version: 0,
      contentHash: '',
      origin: 'shipped',
      note: expect.stringContaining('no revision has been written yet'),
      createdAt: new Date(0).toISOString(),
    });
    expect(snapshot.entries).toContain('docker.io/library');
  });

  it('falls back to the shipped list when the table is unreachable, and keeps enforcing', async () => {
    const db = failingDb(new Error('relation "trusted_registry_revision" does not exist'));
    const guard = new TrustedRegistriesReader(config(), db.pool);

    const snapshot = await guard.snapshot();

    expect(snapshot).toMatchObject({
      origin: 'shipped',
      note: expect.stringContaining('unreachable'),
    });
    // The downgrade is a fallback, not an off switch: a Docker Hub image is still checked.
    await expect(guard.assertTrusted('redis:7.2.5', 'pull')).resolves.toBeUndefined();
    await expect(guard.assertTrusted('bitnami/redis:7', 'pull')).rejects.toThrow(
      /docker\.io\/bitnami/,
    );
  });

  it('names SEAMNEX_TRUSTED_REGISTRIES as the origin when configuration provided the list', async () => {
    const { guard } = reader([[REVISION_QUERY, []]], { trustedRegistries: ['ghcr.io/acme'] });

    await expect(guard.snapshot()).resolves.toMatchObject({
      origin: 'configuration',
      entries: ['ghcr.io/acme'],
    });
  });

  it('treats a row whose entries are not an array as an empty allow-list, which refuses everything', async () => {
    const { guard } = reader([[REVISION_QUERY, [revisionRow({ entries: { 'ghcr.io': true } })]]]);

    expect((await guard.snapshot()).entries).toEqual([]);
    await expect(guard.assertTrusted('redis:7.2.5', 'pull')).rejects.toThrow(
      /not on the trusted-registry allow-list/,
    );
  });
});

describe('assertTrusted', () => {
  it('accepts an image inside a trusted namespace', async () => {
    const { guard } = reader();

    await expect(
      guard.assertTrusted('ghcr.io/seamnex/console:1.4.0', 'pull'),
    ).resolves.toBeUndefined();
    await expect(guard.assertTrusted('redis:7.2.5', 'build')).resolves.toBeUndefined();
  });

  it('refuses an image outside the list, naming the namespace, the remedy and the refused step', async () => {
    const { guard } = reader();

    await expect(guard.assertTrusted('docker.io/bitnami/redis:7', 'start')).rejects.toMatchObject({
      code: 'COMPOSE_POLICY_BLOCKED',
      detail: expect.stringContaining('docker.io/bitnami'),
      remediation: expect.stringContaining('allow-list'),
    });

    await expect(guard.assertTrusted('docker.io/bitnami/redis:7', 'pull')).rejects.toThrow(
      /The pull was refused/,
    );
  });

  it('refuses an unparseable reference instead of guessing where it comes from', async () => {
    const { guard } = reader();

    // The message names the malformed reference, not an allow-list entry: nothing could ever match it.
    await expect(guard.assertTrusted('not a reference', 'pull')).rejects.toThrow(
      /is not a valid image reference/,
    );
  });
});
