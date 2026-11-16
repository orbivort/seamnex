import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { PostgresObservabilityService } from '../../../../src/modules/m21-observability/observability.service';
import { INSTANCE_METRICS } from '../../../../src/modules/m21-observability/observability.exposition';

/**
 * FR-2.6 / AC-45. The three claims this module makes are all checkable: a profile is a persisted
 * artefact, a scrape target is a file that exists for live instances and no others, and a log query
 * is a platform path that cannot be widened by the caller and never returns an unmasked line.
 */
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

const PROFILE_ROW = {
  dashboards: [{ uid: 'instance-overview', title: 'EspoCRM — instance overview', panels: ['CPU'] }],
  rules: [
    { name: 'down', expression: 'seamnex_instance_up == 0', severity: 'critical', for: '5m' },
  ],
};

const INSTANCE_ROW = {
  id: INSTANCE_ID,
  slug: 'crm',
  entry_key: 'D01-01',
  product: 'EspoCRM',
  state: 'ready',
  resources: { cpu: 2, memoryMb: 4_096, diskMb: 20_480 },
};

const directories: string[] = [];

async function targetDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'seamnex-targets-'));
  directories.push(directory);
  return directory;
}

function setup(
  routes: Parameters<typeof fakeDb>[0] = [],
  config: Partial<Record<string, unknown>> = {},
) {
  const db = fakeDb(routes);
  const resolved = {
    SEAMNEX_PROMETHEUS_TARGETS_DIR: '',
    SEAMNEX_PROMETHEUS_SCRAPE_TARGET: 'api:8080',
    SEAMNEX_LOKI_URL: '',
    SEAMNEX_OBSERVABILITY_RETENTION_DAYS: 30,
    SEAMNEX_LOG_QUERY_MAX_MINUTES: 1_440,
    SEAMNEX_LOG_QUERY_MAX_LINES: 500,
    ...config,
  } as unknown as AppConfig;
  return { db, service: new PostgresObservabilityService(db.pool, resolved) };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('profile', () => {
  it('derives the documented baseline from the catalogue entry and writes it once', async () => {
    const { db, service } = setup([
      ['FROM observability_profile', []],
      ['FROM catalog_entry', [{ product: 'EspoCRM', declared: null }]],
      ['INSERT INTO observability_profile', []],
    ]);

    const profile = await service.profile('D01-01');

    expect(profile.dashboards[0]?.uid).toBe('instance-overview');
    expect(profile.rules).toHaveLength(3);
    // The rules cite metric names the exposition actually emits, not strings invented here.
    expect(profile.rules[0]?.expression).toBe('seamnex_instance_up{entry_key="D01-01"} == 0');

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO observability_profile'));
    expect(insert?.params[0]).toBe('D01-01');
    expect(String(insert?.params[2])).toContain('seamnex_instance_memory_mb');
  });

  it('returns a stored profile without rewriting it', async () => {
    const { db, service } = setup([['FROM observability_profile', [PROFILE_ROW]]]);

    await expect(service.profile('D01-01')).resolves.toEqual(PROFILE_ROW);
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO observability_profile'))).toBe(
      false,
    );
  });

  it('repairs a stored profile that no longer parses', async () => {
    const { db, service } = setup([
      ['FROM observability_profile', [{ dashboards: 'not-an-array', rules: null }]],
      ['FROM catalog_entry', [{ product: 'EspoCRM', declared: null }]],
      ['INSERT INTO observability_profile', []],
    ]);

    const profile = await service.profile('D01-01');

    expect(profile.dashboards).toHaveLength(1);
    expect(db.calls.some((call) => call.sql.includes('ON CONFLICT (entry_key) DO UPDATE'))).toBe(
      true,
    );
  });

  it('honours a profile the entry declares itself', async () => {
    const { service } = setup([
      ['FROM observability_profile', []],
      [
        'FROM catalog_entry',
        [
          {
            product: 'EspoCRM',
            declared: {
              dashboards: [{ uid: 'crm', title: 'CRM', panels: ['Logins'] }],
              rules: [
                {
                  name: 'no logins',
                  expression: 'rate(logins[5m]) == 0',
                  severity: 'warning',
                  for: '30m',
                },
              ],
            },
          },
        ],
      ],
      ['INSERT INTO observability_profile', []],
    ]);

    const profile = await service.profile('D01-01');

    expect(profile.dashboards[0]?.uid).toBe('crm');
    expect(profile.rules[0]?.expression).toBe('rate(logins[5m]) == 0');
  });
});

describe('scrape targets', () => {
  it('publishes one target file per instance and reports it as published', async () => {
    const directory = await targetDirectory();
    const { service } = setup(
      [
        ['FROM observability_profile', [PROFILE_ROW]],
        ['FROM instance i', [INSTANCE_ROW]],
      ],
      { SEAMNEX_PROMETHEUS_TARGETS_DIR: directory },
    );

    await service.materialise(INSTANCE_ID);

    const files = await readdir(directory);
    expect(files).toEqual([`instance-${INSTANCE_ID}.json`]);
    const document = JSON.parse(await readFile(join(directory, files[0] as string), 'utf8'));
    expect(document[0].targets).toEqual(['api:8080']);
    expect(document[0].labels).toMatchObject({
      job: 'seamnex-instance',
      instance_id: INSTANCE_ID,
      instance_slug: 'crm',
      entry_key: 'D01-01',
      product: 'EspoCRM',
      __metrics_path__: `/api/v1/metrics/instances/${INSTANCE_ID}`,
    });

    const report = await service.report(INSTANCE_ID);
    expect(report.target).toMatchObject({
      state: 'published',
      metricsPath: `/api/v1/metrics/instances/${INSTANCE_ID}`,
      file: `instance-${INSTANCE_ID}.json`,
    });
  });

  it('says no target is configured rather than pretending one is scraped', async () => {
    const { service } = setup([
      ['FROM observability_profile', [PROFILE_ROW]],
      ['FROM instance i', [INSTANCE_ROW]],
    ]);

    const report = await service.report(INSTANCE_ID);

    expect(report.target.state).toBe('not_configured');
    expect(report.target.file).toBeNull();
    expect(report.target.detail).toContain('No scrape-targets directory');
  });

  it('reconciles the directory against the live portfolio', async () => {
    const directory = await targetDirectory();
    await writeFile(join(directory, `instance-${OTHER_ID}.json`), '[]\n', 'utf8');
    const { service } = setup(
      [
        ['FROM observability_profile', [PROFILE_ROW]],
        ['FROM instance i', [INSTANCE_ROW]],
      ],
      { SEAMNEX_PROMETHEUS_TARGETS_DIR: directory },
    );

    const result = await service.reconcile();

    expect(result).toEqual({ written: 1, removed: 1 });
    expect(await readdir(directory)).toEqual([`instance-${INSTANCE_ID}.json`]);
  });

  it('treats a missing instance as not found and an invalid id as not found', async () => {
    const { service } = setup([['FROM instance i', []]]);

    await expect(service.report('not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.report(INSTANCE_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('logs', () => {
  it('reports the log store as unavailable when it is not configured', async () => {
    const { service } = setup([['FROM instance i', [INSTANCE_ROW]]]);

    await expect(
      service.logs(INSTANCE_ID, { sinceMinutes: 15, limit: 100 }),
    ).resolves.toMatchObject({
      source: 'none',
      lines: [],
      retentionDays: 30,
    });
  });

  it('queries the store by instance id, caps the range and masks every line', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: 'success',
        data: {
          resultType: 'streams',
          result: [
            {
              stream: { instance: INSTANCE_ID, container: 'crm-web', stream: 'stderr' },
              values: [
                [`${Date.parse('2026-01-01T00:00:02Z')}000000`, 'boom: db password=hunter2'],
                [`${Date.parse('2026-01-01T00:00:01Z')}000000`, 'started'],
              ],
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { service } = setup([['FROM instance i', [INSTANCE_ROW]]], {
      SEAMNEX_LOKI_URL: 'http://loki.test',
    });

    const result = await service.logs(INSTANCE_ID, {
      sinceMinutes: 99_999,
      limit: 99_999,
      filter: 'boom" |= "anything',
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    const query = new URL(url).searchParams;
    // The caller's filter is a literal line filter: it cannot close the selector.
    expect(query.get('query')).toBe(`{instance="${INSTANCE_ID}"} |= "boom\\" |= \\"anything"`);
    expect(query.get('limit')).toBe('500');
    expect(Number(query.get('end')) - Number(query.get('start'))).toBe(1_440 * 60_000 * 1_000_000);
    expect(result.source).toBe('loki');
    expect(result.lines.map((line) => line.line)).toEqual([
      'started',
      'boom: db password=********',
    ]);
    expect(result.lines[1]).toMatchObject({ stream: 'stderr', container: 'crm-web' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('answers 503 rather than an empty log when the store does not respond', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 502 })),
    );
    const { service } = setup([['FROM instance i', [INSTANCE_ROW]]], {
      SEAMNEX_LOKI_URL: 'http://loki.test',
    });

    await expect(service.logs(INSTANCE_ID, { sinceMinutes: 15, limit: 100 })).rejects.toMatchObject(
      { code: 'UNAVAILABLE', status: 503 },
    );
  });
});

describe('exposition', () => {
  it('renders measured consumption beside the declared limits', async () => {
    const { service } = setup([
      [
        'FROM instance i',
        [
          {
            ...INSTANCE_ROW,
            sample_at: new Date(Date.now() - 5_000),
            sample_cpu: 480,
            sample_memory: 1_200,
            sample_disk: 3_000,
          },
        ],
      ],
    ]);

    const body = await service.exposition(INSTANCE_ID);

    expect(body).toContain(`seamnex_instance_up{instance_id="${INSTANCE_ID}"`);
    expect(body).toContain('seamnex_instance_up{');
    expect(body).toMatch(/seamnex_instance_up\{[^}]*\} 1/);
    expect(body).toMatch(/seamnex_instance_cpu_millicores\{[^}]*\} 480/);
    expect(body).toMatch(/seamnex_instance_cpu_limit_millicores\{[^}]*\} 2000/);
    expect(body).toMatch(/seamnex_instance_memory_limit_mb\{[^}]*\} 4096/);
  });

  it('omits the usage series when nothing was measured', async () => {
    const { service } = setup([
      [
        'FROM instance i',
        [
          {
            ...INSTANCE_ROW,
            sample_at: null,
            sample_cpu: null,
            sample_memory: null,
            sample_disk: null,
          },
        ],
      ],
    ]);

    const body = await service.exposition(INSTANCE_ID);

    expect(body).toContain('seamnex_instance_up{');
    expect(body).not.toContain('seamnex_instance_cpu_millicores{');
    expect(body).toContain('seamnex_instance_memory_limit_mb{');
  });

  it('emits every series name the exported catalogue declares', async () => {
    const { service } = setup([
      [
        'FROM instance i',
        [
          {
            ...INSTANCE_ROW,
            sample_at: new Date(Date.now() - 5_000),
            sample_cpu: 480,
            sample_memory: 1_200,
            sample_disk: 3_000,
          },
        ],
      ],
    ]);

    const body = await service.exposition(INSTANCE_ID);

    // The alert rules cite `INSTANCE_METRICS`; a name in that catalogue that no document carries is a
    // rule that can never fire, which is the class of claim this module exists to remove.
    for (const name of Object.values(INSTANCE_METRICS)) {
      expect(body).toContain(`${name}{`);
    }
  });

  it('treats an exposition for an unknown instance as not found', async () => {
    const { service } = setup([['FROM instance i', []]]);

    await expect(service.exposition(OTHER_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('renders zero limits and zero usage without inventing a product or a state', async () => {
    const { service } = setup([
      [
        'FROM instance i',
        [
          {
            ...INSTANCE_ROW,
            product: null,
            state: 'failed',
            resources: null,
            sample_at: new Date(Date.now() - 5_000),
            sample_cpu: null,
            sample_memory: null,
            sample_disk: null,
          },
        ],
      ],
    ]);

    const body = await service.exposition(INSTANCE_ID);

    // A ready flag is the platform's verdict, and the fallback product is the entry key, not "null".
    expect(body).toMatch(/seamnex_instance_up\{[^}]*\} 0/);
    expect(body).toContain('product="D01-01"');
    expect(body).toMatch(/seamnex_instance_cpu_limit_millicores\{[^}]*\} 0/);
    expect(body).toMatch(/seamnex_instance_memory_limit_mb\{[^}]*\} 0/);
    expect(body).toMatch(/seamnex_instance_disk_quota_mb\{[^}]*\} 0/);
    expect(body).toMatch(/seamnex_instance_cpu_millicores\{[^}]*\} 0/);
    expect(body).toMatch(/seamnex_instance_memory_mb\{[^}]*\} 0/);
    expect(body).toMatch(/seamnex_instance_disk_mb\{[^}]*\} 0/);
  });
});

describe('profile without a catalogue row', () => {
  it('names the baseline after the entry key rather than inventing a product', async () => {
    const { service } = setup([
      ['FROM observability_profile', []],
      ['FROM catalog_entry', []],
      ['INSERT INTO observability_profile', []],
    ]);

    const profile = await service.profile('D99-99');

    expect(profile.dashboards[0]?.title).toBe('D99-99 — instance overview');
    expect(profile.rules[0]?.name).toBe('D99-99 is down');
  });
});

describe('reconcile with no configured directory', () => {
  it('does nothing rather than walking a directory it does not have', async () => {
    const { db, service } = setup();

    await expect(service.reconcile()).resolves.toEqual({ written: 0, removed: 0 });
    expect(db.calls).toHaveLength(0);
  });

  it('does not publish from materialise when there is nowhere to publish', async () => {
    const { db, service } = setup([
      ['FROM observability_profile', [PROFILE_ROW]],
      ['FROM instance i', [INSTANCE_ROW]],
    ]);

    await expect(service.materialise(INSTANCE_ID)).resolves.toBeUndefined();

    // The profile was still derived; only the file projection was skipped.
    expect(db.calls.some((call) => call.sql.includes('FROM observability_profile'))).toBe(true);
  });
});

describe('report before the first projection', () => {
  it('says the target is missing and that the log path is queryable', async () => {
    const directory = await targetDirectory();
    const { service } = setup(
      [
        ['FROM observability_profile', [PROFILE_ROW]],
        ['FROM instance i', [{ ...INSTANCE_ROW, product: null }]],
      ],
      { SEAMNEX_PROMETHEUS_TARGETS_DIR: directory, SEAMNEX_LOKI_URL: 'http://loki.test' },
    );

    const report = await service.report(INSTANCE_ID);

    expect(report.product).toBe('D01-01');
    expect(report.target).toMatchObject({
      state: 'missing',
      file: `instance-${INSTANCE_ID}.json`,
      generatedAt: null,
    });
    expect(report.target.detail).toContain('No target file yet');
    // FR-4.6: configured means queryable, and the report states the retention it promises.
    expect(report.logs).toMatchObject({ available: true, source: 'loki', retentionDays: 30 });
    expect(report.logs.detail).toContain('30 days');
  });

  it('reports the entry key as the product when the deployment configures no targets directory', async () => {
    const { service } = setup([
      ['FROM observability_profile', [PROFILE_ROW]],
      ['FROM instance i', [{ ...INSTANCE_ROW, product: null }]],
    ]);

    const report = await service.report(INSTANCE_ID);

    expect(report.target.state).toBe('not_configured');
    expect(report.product).toBe('D01-01');
    expect(report.target.labels.product).toBe('D01-01');
  });

  it('publishes a target labelled with the entry key when the instance records no product', async () => {
    const directory = await targetDirectory();
    const { service } = setup(
      [
        ['FROM observability_profile', [PROFILE_ROW]],
        ['FROM instance i', [{ ...INSTANCE_ROW, product: null }]],
      ],
      { SEAMNEX_PROMETHEUS_TARGETS_DIR: directory },
    );

    await expect(service.reconcile()).resolves.toEqual({ written: 1, removed: 0 });

    const document = JSON.parse(
      await readFile(join(directory, `instance-${INSTANCE_ID}.json`), 'utf8'),
    );
    expect(document[0].labels.product).toBe('D01-01');
  });
});

describe('logs with a malformed store response', () => {
  it('skips the parts it cannot read instead of guessing at them', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          result: [
            null,
            'not-a-stream',
            { stream: { container: 'crm-web' }, values: 'nope' },
            {
              stream: { stream: 'stderr' },
              values: [
                'not-an-array',
                [`${Date.parse('2026-01-01T00:00:03Z')}000000`],
                ['not-a-number', 'dropped'],
                [`${Date.parse('2026-01-01T00:00:04Z')}000000`, undefined],
                [`${Date.parse('2026-01-01T00:00:02Z')}000000`, 'second'],
              ],
            },
            { values: [[`${Date.parse('2026-01-01T00:00:01Z')}000000`, 'first']] },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { service } = setup([['FROM instance i', [INSTANCE_ROW]]], {
      SEAMNEX_LOKI_URL: 'http://loki.test',
    });

    const result = await service.logs(INSTANCE_ID, { sinceMinutes: 15, limit: 500 });

    // Chronological order, unknown stream labels read as stdout, and no container is invented.
    expect(result.lines.map((line) => line.line)).toEqual(['first', 'second', '']);
    expect(result.lines.map((line) => line.stream)).toEqual(['stdout', 'stderr', 'stderr']);
    expect(result.lines.every((line) => line.container === null)).toBe(true);
    expect(result.truncated).toBe(false);
    const query = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]).searchParams;
    // No filter means no line filter: a caller cannot append to the selector by omission either.
    expect(query.get('query')).toBe(`{instance="${INSTANCE_ID}"}`);
  });

  it('reads an unrecognised payload as no lines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: { result: {} } })),
    );
    const { service } = setup([['FROM instance i', [INSTANCE_ROW]]], {
      SEAMNEX_LOKI_URL: 'http://loki.test',
    });

    const result = await service.logs(INSTANCE_ID, { sinceMinutes: 15, limit: 100 });

    expect(result.lines).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.detail).toContain('newest 0 of the last 15 minutes');
  });

  it('clamps an unreadable window and limit and marks a capped result as truncated', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          result: [
            {
              stream: {},
              values: [
                [`${Date.parse('2026-01-01T00:00:01Z')}000000`, 'older'],
                [`${Date.parse('2026-01-01T00:00:02Z')}000000`, 'newer'],
              ],
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { service } = setup([['FROM instance i', [INSTANCE_ROW]]], {
      SEAMNEX_LOKI_URL: 'http://loki.test',
    });

    const result = await service.logs(INSTANCE_ID, {
      sinceMinutes: Number.NaN,
      limit: Number.NaN,
    });

    const query = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]).searchParams;
    // NaN is not a window: the floor is applied rather than a range nobody can reason about.
    expect(query.get('limit')).toBe('1');
    expect(Number(query.get('end')) - Number(query.get('start'))).toBe(60_000 * 1_000_000);
    expect(result.lines.map((line) => line.line)).toEqual(['newer']);
    expect(result.truncated).toBe(true);
  });

  it('answers 503 when the store rejects with a value that is not an Error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'EHOSTUNREACH';
      }),
    );
    const { service } = setup([['FROM instance i', [INSTANCE_ROW]]], {
      SEAMNEX_LOKI_URL: 'http://loki.test',
    });

    await expect(service.logs(INSTANCE_ID, { sinceMinutes: 15, limit: 100 })).rejects.toMatchObject(
      { code: 'UNAVAILABLE', status: 503 },
    );
  });
});
