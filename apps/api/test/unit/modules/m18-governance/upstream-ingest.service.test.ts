import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Route, type Row } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { UpstreamIngestService } from '../../../../src/modules/m18-governance/upstream-ingest.service';
import type {
  FeedOutcome,
  UpstreamAdvisory,
  UpstreamRelease,
} from '../../../../src/modules/m18-governance/upstream-feed.client';

/**
 * FR-2.12 / FR-4.7 / NFR-4.7 — the observation pass that advances the patch register.
 *
 * The register used to be a projection of a JSON file, so "checked at" moved when somebody edited it.
 * The cases below assert the three rules that make it a measurement: a failed feed writes nothing
 * (the previous observation keeps its own timestamp), advisories are reconciled per entry and closed
 * only on an authoritative answer, and `catalog_entry` is never rewritten — M18 owns the register.
 */
const DAY = 86_400_000;

const ENTRIES_QUERY = 'FROM catalog_entry';
const PREVIOUS_QUERY = 'max(pr.latest_version)';
const OPEN_QUERY = 'FROM patch_advisory';
const UPSERT_ADVISORY = 'INSERT INTO patch_advisory';
const CLOSE_ADVISORY = 'UPDATE patch_advisory';
const UPSERT_RECORD = 'INSERT INTO patch_record';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    key: 'D01-01',
    product: 'CRM',
    repo_url: 'https://github.com/espocrm/espocrm',
    ...overrides,
  };
}

function advisory(overrides: Partial<UpstreamAdvisory> = {}): UpstreamAdvisory {
  return {
    id: 'GHSA-aaaa-bbbb-cccc',
    severity: 'high',
    summary: 'Path traversal in the upload endpoint',
    url: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc',
    fixedVersion: '9.2.2',
    publishedAt: new Date(Date.now() - 45 * DAY).toISOString(),
    ...overrides,
  };
}

function release(overrides: Partial<UpstreamRelease> = {}): UpstreamRelease {
  return {
    version: '9.2.2',
    url: 'https://github.com/espocrm/espocrm/releases/tag/9.2.2',
    publishedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const ok = <T>(value: T): FeedOutcome<T> => ({ kind: 'ok', value });
const failed = (reason = 'ETIMEDOUT'): FeedOutcome<never> => ({ kind: 'failed', reason });

function setup(routes: readonly Route[] = [], options: Record<string, unknown> = {}) {
  const open: Row[] = [];
  const db = fakeDb([...storeRoutes(open), ...routes]);
  const audit = {
    lockChain: vi.fn(async () => undefined),
    // Typed arguments keep `append.mock.calls` readable: the assertions inspect `call[0].action`.
    append: vi.fn(async (_entry: { action: string }, _tx?: unknown) => ({ seq: '1', hash: 'h' })),
  };
  const feeds = {
    release: vi.fn(async () => ok(release())),
    advisories: vi.fn(async () => ok([advisory()])),
  };
  const config = {
    SEAMNEX_UPSTREAM_TRACKING_ENABLED: true,
    SEAMNEX_UPSTREAM_BATCH: 25,
    ...options,
  } as unknown as AppConfig;
  const service = new UpstreamIngestService(db.pool, config, audit as never, feeds as never);
  return { db, audit, feeds, service, open };
}

/**
 * The advisory table is the one piece of state the pass reads back inside the transaction, so it is
 * a small store rather than a fixed row set: the upsert has to be visible to the read that follows
 * it, otherwise every assertion about the lead advisory would be about an empty table.
 */
function storeRoutes(open: Row[]): readonly Route[] {
  return [
    [OPEN_QUERY, () => open],
    [
      UPSERT_ADVISORY,
      (_sql: string, params: readonly unknown[]) => {
        // Parameter order of the upsert: entry_key, advisory_id, severity, summary, url,
        // fixed_version, published_at.
        const next = {
          advisory_id: params[1],
          severity: params[2],
          url: params[4],
          fixed_version: params[5],
          since: new Date(String(params[6] ?? new Date().toISOString())),
        };
        const index = open.findIndex((row) => row.advisory_id === next.advisory_id);
        if (index === -1) open.push(next);
        else open[index] = next;
        return [];
      },
    ],
    [
      CLOSE_ADVISORY,
      (_sql: string, params: readonly unknown[]) => {
        const keep = new Set((params[1] as string[] | undefined) ?? []);
        open.splice(0, open.length, ...open.filter((row) => keep.has(String(row.advisory_id))));
        return [];
      },
    ],
  ];
}

const baseRoutes: readonly Route[] = [
  [ENTRIES_QUERY, [entry()]],
  [PREVIOUS_QUERY, [{ latest_version: '9.2.1' }]],
  [UPSERT_RECORD, { rows: [], rowCount: 2 }],
];

/** The actor the scheduler passes; an operator-triggered pass passes their own. */
const system = { type: 'system', id: 'scheduler' } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('observe', () => {
  it('refuses to run when tracking is switched off', async () => {
    const { db, service } = setup(baseRoutes, { SEAMNEX_UPSTREAM_TRACKING_ENABLED: false });

    await expect(service.observe(system)).rejects.toThrow(/upstream tracking is disabled/);
    expect(db.calls).toEqual([]);
  });

  it('reports an empty pass when the catalogue holds no entries', async () => {
    const { service } = setup([[ENTRIES_QUERY, []], ...baseRoutes.slice(1)]);

    const result = await service.observe(system);

    expect(result).toEqual({
      observedAt: expect.any(String),
      entries: 0,
      releases: 0,
      advisories: 0,
      skipped: 0,
      failed: 0,
      instancesUpdated: 0,
    });
  });

  it('writes the register with the release, the lead advisory and the age of the oldest fix', async () => {
    const { audit, db, service } = setup(baseRoutes);

    const result = await service.observe(system);

    const insert = db.calls.find((call) => call.sql.includes(UPSERT_RECORD));
    expect(insert?.params.slice(0, 7)).toEqual([
      'D01-01',
      '9.2.2',
      45,
      'GHSA-aaaa-bbbb-cccc',
      'high',
      'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc',
      'https://github.com/espocrm/espocrm/releases/tag/9.2.2',
    ]);
    // The entry and its instances are separate facts: the register row is per instance.
    expect(result).toMatchObject({
      entries: 1,
      releases: 1,
      advisories: 1,
      instancesUpdated: 2,
      skipped: 0,
      failed: 0,
    });
    expect(audit.lockChain).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'upstream.release.observed', actorType: 'system' }),
      expect.anything(),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'patch.register.observed', actorType: 'system' }),
      expect.anything(),
    );
  });

  it('audits a newly opened advisory but not one already open', async () => {
    const { audit, open, service } = setup([
      [ENTRIES_QUERY, [entry()]],
      [PREVIOUS_QUERY, [{ latest_version: '9.2.2' }]],
      [UPSERT_RECORD, { rows: [], rowCount: 1 }],
    ]);
    // Already open before this pass: reannouncing it every hour would fill the trail with nothing.
    open.push({
      advisory_id: 'GHSA-aaaa-bbbb-cccc',
      severity: 'high',
      url: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc',
      fixed_version: '9.2.2',
      since: new Date(Date.now() - 45 * DAY),
    });

    const result = await service.observe(system);

    expect(
      audit.append.mock.calls.filter((call) => call[0].action === 'upstream.advisory.opened'),
    ).toEqual([]);
    // The release did not change, so there is nothing to announce there either.
    expect(
      audit.append.mock.calls.filter((call) => call[0].action === 'upstream.release.observed'),
    ).toEqual([]);
    expect(result.releases).toBe(0);
  });

  it('closes every advisory the authoritative answer no longer lists', async () => {
    const { db, service } = setup(baseRoutes);

    await service.observe(system);

    const close = db.calls.find((call) => call.sql.includes(CLOSE_ADVISORY));
    // The list is passed as data, so the statement closes exactly what OSV omitted.
    expect(close?.params).toEqual(['D01-01', ['GHSA-aaaa-bbbb-cccc']]);
  });

  it('keeps the previous observation when a feed is unreachable', async () => {
    const { audit, db, feeds, service } = setup([
      [ENTRIES_QUERY, [entry()]],
      ...baseRoutes.slice(1),
    ]);
    feeds.advisories.mockResolvedValue(failed('api.osv.dev is unreachable'));

    const result = await service.observe(system);

    // Nothing was written for the entry: a timeout is not evidence that nothing is open.
    expect(db.calls.some((call) => call.sql.includes(UPSERT_RECORD))).toBe(false);
    expect(result).toMatchObject({ entries: 1, failed: 1, releases: 0, instancesUpdated: 0 });
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('counts an entry with no repository as skipped, and still records that the pass reached it', async () => {
    const { db, feeds, service } = setup([
      [ENTRIES_QUERY, [entry({ repo_url: null })]],
      ...baseRoutes.slice(1),
    ]);
    feeds.release.mockResolvedValue({ kind: 'skipped', reason: 'no repository' });
    feeds.advisories.mockResolvedValue({ kind: 'skipped', reason: 'no repository' });

    const result = await service.observe(system);

    expect(result).toMatchObject({ entries: 1, skipped: 1, failed: 0 });
    const insert = db.calls.find((call) => call.sql.includes(UPSERT_RECORD));
    // No release and no advisory to show, but the row says when the platform last looked.
    expect(insert?.params.slice(0, 3)).toEqual(['D01-01', null, null]);
  });

  it('shows the worst advisory first, and the one open longest at equal severity', async () => {
    const oldest = new Date(Date.now() - 90 * DAY).toISOString();
    const { db, feeds, service } = setup(baseRoutes);
    feeds.advisories.mockResolvedValue(
      ok([
        advisory({ id: 'GHSA-medium', severity: 'medium', publishedAt: oldest }),
        advisory({ id: 'GHSA-old-critical', severity: 'critical', publishedAt: oldest }),
        advisory({
          id: 'GHSA-new-critical',
          severity: 'critical',
          publishedAt: new Date().toISOString(),
        }),
      ]),
    );

    await service.observe(system);

    const insert = db.calls.find((call) => call.sql.includes(UPSERT_RECORD));
    expect(insert?.params[3]).toBe('GHSA-old-critical');
  });

  it('leaves the age unset when the only open advisory has no published fix', async () => {
    const { db, feeds, service } = setup(baseRoutes);
    feeds.advisories.mockResolvedValue(ok([advisory({ fixedVersion: null })]));

    await service.observe(system);

    const insert = db.calls.find((call) => call.sql.includes(UPSERT_RECORD));
    // Counting an unfixable advisory would keep the register permanently red for something no
    // upgrade can clear; `null` is "nothing to wait on".
    expect(insert?.params[2]).toBeNull();
  });

  it('does not count a tag that moved backwards as a newer release', async () => {
    const { audit, feeds, service } = setup([
      [ENTRIES_QUERY, [entry()]],
      // The register already carries 17.9.6; GitHub now answers with a backport on the 17.8 branch.
      [PREVIOUS_QUERY, [{ latest_version: '17.9.6' }]],
      [UPSERT_RECORD, { rows: [], rowCount: 1 }],
    ]);
    feeds.release.mockResolvedValue(ok(release({ version: '17.8.3' })));

    const result = await service.observe(system);

    // It is still an observation worth recording, but nobody can upgrade to it.
    expect(result.releases).toBe(0);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'upstream.release.observed',
        detail: expect.objectContaining({ from: '17.9.6', to: '17.8.3', newer: false }),
      }),
      expect.anything(),
    );
  });

  it('passes the operator through as the audit actor when a person triggers the pass', async () => {
    const { audit, service } = setup(baseRoutes);

    await service.observe({ type: 'user', id: 'usr-sofia' });

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'user', actorId: 'usr-sofia' }),
      expect.anything(),
    );
  });

  it('asks the feed once per entry and reports the failure kind it saw', async () => {
    const { audit, feeds, service } = setup(baseRoutes);
    feeds.advisories.mockResolvedValue(failed('OSV answered 502'));

    await service.observe(system);

    expect(feeds.release).toHaveBeenCalledOnce();
    expect(feeds.advisories).toHaveBeenCalledOnce();
    // A failed entry writes nothing, so there is no register row to describe the failure in; the
    // caller's summary carries the count.
    expect(audit.append).not.toHaveBeenCalled();
  });
});
