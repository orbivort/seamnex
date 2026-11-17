import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import type * as ImageScan from '../../../../src/common/docker/image-scan';
import { PostgresImageScanService } from '../../../../src/modules/m05-executor/image-scan.service';

/**
 * NFR-4.6 / S-10 — the scan that runs before a container starts.
 *
 * The review's finding had two halves: no product image was ever scanned, and nothing was retained.
 * The cases below are the evidence that both are closed, plus the honesty rules that make the
 * verdict usable: `error` is not `passed`, a retained `passed` report is reused rather than
 * recomputed, and a blocked image stops the deployment with an audit row even when the audit append
 * itself fails.
 */
const FIND_QUERY = 'FROM image_scan_result';
const INSERT_QUERY = 'INSERT INTO image_scan_result';
const SUMMARIES_QUERY = 'DISTINCT ON (image_digest)';
const DELETE_QUERY = 'DELETE FROM image_scan_result';

const scanImageMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/common/docker/image-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageScan>();
  return { ...actual, scanImage: scanImageMock };
});

const counts = (overrides: Record<string, number> = {}) => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  unknown: 0,
  ...overrides,
});

function outcome(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'passed',
    scanner: 'aquasec/trivy',
    scannerVersion: '0.58.0',
    severityCounts: counts(),
    findings: [],
    failure: null,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    instance_id: 'inst-crm',
    image_ref: 'docker.io/library/redis:7.2.5',
    image_digest: 'sha256:abc',
    scanner: 'aquasec/trivy',
    scanner_version: '0.58.0',
    verdict: 'passed',
    blocking_severities: ['critical'],
    severity_counts: counts(),
    findings: [],
    report_key: null,
    scanned_at: new Date('2026-11-01T10:00:00.000Z'),
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    SEAMNEX_SCAN_ENABLED: true,
    SEAMNEX_SCAN_FAIL_OPEN: false,
    SEAMNEX_SCAN_TMP_DIR: 'temp/agent/scan',
    SEAMNEX_SCANNER_IMAGE: 'aquasec/trivy:0.58.0',
    scanBlockSeverities: ['CRITICAL'],
    ...overrides,
  } as unknown as AppConfig;
}

function setup(routes: readonly Route[] = [], options: Record<string, unknown> = {}) {
  const db = fakeDb(routes);
  const audit = { append: vi.fn(async () => ({ seq: '1', hash: 'h' })) };
  const docker = {
    imageIdentity: vi.fn(async () => ({
      digest: 'sha256:abc',
      ref: 'docker.io/library/redis:7.2.5',
    })),
  };
  const service = new PostgresImageScanService(
    db.pool,
    config(options),
    audit as never,
    docker as never,
  );
  return { db, audit, docker, service };
}

beforeEach(() => {
  vi.clearAllMocks();
  scanImageMock.mockResolvedValue(outcome());
});

describe('scanForDeploy', () => {
  it('reports that nothing was scanned when scanning is disabled', async () => {
    const { service } = setup([], { SEAMNEX_SCAN_ENABLED: false });
    const log = vi.fn(async () => undefined);

    await expect(
      service.scanForDeploy({ instanceId: 'inst-crm', references: ['redis:7'], log }),
    ).resolves.toEqual([]);

    // Disabled is a state, not a pass: the job log has to say so.
    expect(log).toHaveBeenCalledWith(
      'system',
      expect.stringContaining('image scanning is disabled'),
    );
    expect(scanImageMock).not.toHaveBeenCalled();
  });

  it('reuses a retained passing report instead of rescanning the same digest', async () => {
    const { service } = setup([[FIND_QUERY, [row()]]]);

    const [summary] = await service.scanForDeploy({
      instanceId: 'inst-crm',
      references: ['redis:7'],
    });

    expect(scanImageMock).not.toHaveBeenCalled();
    expect(summary?.verdict).toBe('passed');
  });

  it('rescans when the retained report is blocked, because the answer may have changed', async () => {
    const { service } = setup([
      [FIND_QUERY, [row({ verdict: 'blocked' })]],
      [INSERT_QUERY, [row()]],
    ]);

    const [summary] = await service.scanForDeploy({
      instanceId: 'inst-crm',
      references: ['redis:7'],
    });

    expect(scanImageMock).toHaveBeenCalledOnce();
    expect(summary?.verdict).toBe('passed');
  });

  it('scans each distinct reference once and skips a blank one', async () => {
    const { service } = setup([
      [FIND_QUERY, []],
      [INSERT_QUERY, [row()]],
    ]);

    await service.scanForDeploy({
      instanceId: 'inst-crm',
      references: ['redis:7', 'redis:7', '  '],
    });

    expect(scanImageMock).toHaveBeenCalledOnce();
  });

  it('stores the report under the resolved digest, not the mutable tag', async () => {
    const { db, service } = setup([
      [FIND_QUERY, []],
      [INSERT_QUERY, [row()]],
    ]);

    await service.scanForDeploy({ instanceId: 'inst-crm', references: ['redis:7'] });

    const insert = db.calls.find((call) => call.sql.includes(INSERT_QUERY));
    expect(insert?.params.slice(0, 3)).toEqual(['inst-crm', 'redis:7', 'sha256:abc']);
  });

  it('blocks the deployment on a blocking severity, with an audit row naming the image', async () => {
    const { audit, service } = setup([
      [FIND_QUERY, []],
      [INSERT_QUERY, [row({ verdict: 'blocked' })]],
    ]);
    scanImageMock.mockResolvedValue(
      outcome({ verdict: 'blocked', severityCounts: counts({ critical: 2 }) }),
    );

    await expect(
      service.scanForDeploy({ instanceId: 'inst-crm', references: ['redis:7'] }),
    ).rejects.toThrow(/stopped before any container started/);

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'deployment.image_scan.blocked',
        actorType: 'system',
        targetId: 'inst-crm',
        detail: expect.objectContaining({ verdict: 'blocked', imageDigest: 'sha256:abc' }),
      }),
    );
  });

  it('says no severity is configured rather than printing an empty blocking set', async () => {
    const { service } = setup(
      [
        [FIND_QUERY, []],
        [INSERT_QUERY, [row({ verdict: 'blocked' })]],
      ],
      { scanBlockSeverities: [] },
    );
    scanImageMock.mockResolvedValue(outcome({ verdict: 'blocked' }));

    // An empty threshold is a real configuration: the image was blocked for another reason and the
    // message must not read as "blocked by ()".
    await expect(
      service.scanForDeploy({ instanceId: 'inst-crm', references: ['redis:7'] }),
    ).rejects.toThrow(/blocking severity \(none configured\)/);
  });

  it('logs a digest that is not a sha256 reference as the daemon reported it', async () => {
    const { docker, service } = setup([
      [FIND_QUERY, []],
      [INSERT_QUERY, [row()]],
    ]);
    docker.imageIdentity.mockResolvedValue({ digest: 'md5:abcdef0123456789', ref: 'redis:7' });
    const log = vi.fn(async () => undefined);

    await service.scanForDeploy({ instanceId: 'inst-crm', references: ['redis:7'], log });

    // The short form used in the job log must not assume the `sha256:` prefix exists.
    expect(log).toHaveBeenCalledWith('stdout', expect.stringContaining('(md5:abcdef01)'));
  });

  it('blocks when the scanner could not run, naming the scanner rather than a finding', async () => {
    const { service } = setup([
      [FIND_QUERY, []],
      [INSERT_QUERY, [row({ verdict: 'error' })]],
    ]);
    scanImageMock.mockResolvedValue(
      outcome({ verdict: 'error', failure: 'the scanner image is not pullable' }),
    );

    await expect(
      service.scanForDeploy({ instanceId: 'inst-crm', references: ['redis:7'] }),
    ).rejects.toThrow(/could not be scanned: the scanner image is not pullable/);
  });

  it('says so when an errored scan carries no reason at all', async () => {
    const { service } = setup([
      [FIND_QUERY, []],
      [INSERT_QUERY, [row({ verdict: 'error' })]],
    ]);
    scanImageMock.mockResolvedValue(outcome({ verdict: 'error', failure: null }));

    await expect(
      service.scanForDeploy({ instanceId: 'inst-crm', references: ['redis:7'] }),
    ).rejects.toThrow(/unknown scanner failure/);
  });

  it('continues past a blocked image when the operator opted into fail-open', async () => {
    const { service } = setup(
      [
        [FIND_QUERY, []],
        [INSERT_QUERY, [row({ verdict: 'blocked' })]],
      ],
      { SEAMNEX_SCAN_FAIL_OPEN: true },
    );
    scanImageMock.mockResolvedValue(outcome({ verdict: 'blocked' }));
    const log = vi.fn(async () => undefined);

    const summaries = await service.scanForDeploy({
      instanceId: 'inst-crm',
      references: ['redis:7'],
      log,
    });

    expect(summaries).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('system', expect.stringContaining('SEAMNEX_SCAN_FAIL_OPEN'));
  });

  it('still refuses the deployment when the audit append fails', async () => {
    const { audit, service } = setup([
      [FIND_QUERY, []],
      [INSERT_QUERY, [row({ verdict: 'blocked' })]],
    ]);
    audit.append.mockRejectedValue(new Error('audit chain unavailable'));
    scanImageMock.mockResolvedValue(outcome({ verdict: 'blocked' }));

    await expect(
      service.scanForDeploy({ instanceId: 'inst-crm', references: ['redis:7'] }),
    ).rejects.toThrow(/IMAGE_SCAN_BLOCKED|stopped before/);
  });

  it('fails closed when the result cannot be stored', async () => {
    const { service } = setup([
      [FIND_QUERY, []],
      [INSERT_QUERY, []],
    ]);

    await expect(
      service.scanForDeploy({ instanceId: 'inst-crm', references: ['redis:7'] }),
    ).rejects.toThrow(/could not be stored/);
  });
});

describe('report', () => {
  it('returns the retained findings for a digest', async () => {
    const { service } = setup([
      [
        FIND_QUERY,
        [
          row({
            report_key: 'scans/abc.json',
            findings: [
              {
                id: 'CVE-2026-0001',
                package: 'openssl',
                installedVersion: '3.0.1',
                fixedVersion: '3.0.2',
                severity: 'high',
                title: 'Buffer overread',
                url: 'https://osv.dev/vulnerability/CVE-2026-0001',
              },
              // A malformed member is dropped rather than rendered as a finding.
              { id: 'CVE-2026-0002' },
            ],
          }),
        ],
      ],
    ]);

    const report = await service.report('inst-crm', 'sha256:abc');

    expect(report.imageDigest).toBe('sha256:abc');
    expect(report.reportKey).toBe('scans/abc.json');
    expect(report.findings.map((finding) => finding.id)).toEqual(['CVE-2026-0001']);
  });

  it('reports a missing report as NOT_FOUND rather than as a clean image', async () => {
    const { service } = setup([[FIND_QUERY, []]]);

    await expect(service.report('inst-crm', 'sha256:none')).rejects.toThrow(/No retained scan/);
  });

  it('keeps the severities the contract names and drops one a stale row still holds', async () => {
    const { service } = setup([
      [
        FIND_QUERY,
        [row({ blocking_severities: ['critical', 'high', 'medium', 'low', 'unknown', 'severe'] })],
      ],
    ]);

    const report = await service.report('inst-crm', 'sha256:abc');

    // A stored value outside the union is not a severity; passing it on would put it in the summary
    // the screen renders as a threshold.
    expect(report.blockingSeverities).toEqual(['critical', 'high', 'medium', 'low', 'unknown']);
  });

  it('treats a findings column that is not an array as no findings', async () => {
    const { service } = setup([[FIND_QUERY, [row({ findings: null })]]]);

    // An unreadable column is "nothing retained", not a finding the screen would have to render.
    expect((await service.report('inst-crm', 'sha256:abc')).findings).toEqual([]);
  });

  it('drops a finding stored as a scalar instead of rendering it', async () => {
    const { service } = setup([
      [
        FIND_QUERY,
        [
          row({
            findings: [
              'not a finding',
              {
                id: 'CVE-2026-0003',
                package: 'zlib',
                installedVersion: '1.3',
                fixedVersion: null,
                severity: 'low',
                title: 'Deflate overread',
                url: null,
              },
            ],
          }),
        ],
      ],
    ]);

    expect((await service.report('inst-crm', 'sha256:abc')).findings.map((f) => f.id)).toEqual([
      'CVE-2026-0003',
    ]);
  });

  it('fills a count the scanner did not report with zero', async () => {
    const { service } = setup([
      [FIND_QUERY, [row({ severity_counts: { critical: 1, high: 'many' } })]],
    ]);

    const report = await service.report('inst-crm', 'sha256:abc');

    expect(report.severityCounts).toEqual({ critical: 1, high: 0, medium: 0, low: 0, unknown: 0 });
  });
});

describe('summaries and retention', () => {
  it('keys the newest report per digest', async () => {
    const { service } = setup([
      [SUMMARIES_QUERY, [row(), row({ image_digest: 'sha256:def', verdict: 'blocked' })]],
    ]);

    const summaries = await service.summaries('inst-crm');

    expect([...summaries.keys()]).toEqual(['sha256:abc', 'sha256:def']);
    expect(summaries.get('sha256:def')?.verdict).toBe('blocked');
  });

  it('prunes reports older than the retention window and reports how many went', async () => {
    const { db, service } = setup([[DELETE_QUERY, { rows: [], rowCount: 3 }]]);

    await expect(service.prune(30)).resolves.toBe(3);
    expect(db.calls.at(-1)?.params).toEqual([30]);
  });

  it('reports zero when the driver does not count the deleted rows', async () => {
    const { service } = setup([[DELETE_QUERY, { rows: [], rowCount: null }]]);

    // `rowCount` is null on a statement the driver did not tag; "0 pruned" is the honest reading.
    await expect(service.prune(30)).resolves.toBe(0);
  });

  it('clamps a nonsensical retention window to one day', async () => {
    const { db, service } = setup([[DELETE_QUERY, { rows: [], rowCount: 0 }]]);

    await expect(service.prune(0)).resolves.toBe(0);
    expect(db.calls.at(-1)?.params).toEqual([1]);
  });
});
