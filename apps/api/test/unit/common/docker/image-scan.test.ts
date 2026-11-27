import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import {
  parseBlockingSeverities,
  scanImage,
  scannerVersionOf,
} from '../../../../src/common/docker/image-scan';

/**
 * NFR-4.6 / S-10 — the scan itself.
 *
 * The unit under test is the orchestration, so the daemon is doubled and the only real I/O is the
 * report file the "scanner" writes. Four decisions are asserted: the scanner receives a tar (never
 * the socket), a non-zero exit is an `error` verdict rather than an exception, the blocking set comes
 * from configuration, and the work directory is gone afterwards — an image tar per deployment would
 * fill a host disk within a week.
 */
const workRoot = () => mkdtempSync(join(tmpdir(), 'seamnex-scan-'));

/**
 * A Trivy cache the age rule accepts: the database, the metadata that dates it, and the Java database
 * unless a case is about the coverage gap left without one.
 */
function seededCache(
  options: { updatedAt?: Date; metadata?: boolean; java?: boolean } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-trivy-cache-'));
  mkdirSync(join(dir, 'db'), { recursive: true });
  writeFileSync(join(dir, 'db', 'trivy.db'), 'database');
  if (options.metadata !== false) {
    writeFileSync(
      join(dir, 'db', 'metadata.json'),
      JSON.stringify({
        Version: 2,
        DownloadedAt: (options.updatedAt ?? new Date()).toISOString(),
        NextUpdate: new Date(Date.now() + 6 * 3_600_000).toISOString(),
      }),
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
    SEAMNEX_SCANNER_IMAGE: 'aquasec/trivy:0.58.0',
    SEAMNEX_SCAN_TIMEOUT_MS: 120_000,
    SEAMNEX_DOCKER_PATH_MAP: '',
    // `cached` is the shipped posture, so it is what these cases exercise: the scanner keeps no
    // route, the seeded cache is mounted, and Trivy is told not to reach for a database.
    SEAMNEX_SCAN_DB_MODE: 'cached',
    SEAMNEX_SCAN_CACHE_DIR: seededCache(),
    SEAMNEX_SCAN_DB_MAX_AGE_HOURS: 168,
    SEAMNEX_SCAN_DB_REPOSITORY: 'ghcr.io/aquasec/trivy-db',
    SEAMNEX_SCAN_NETWORK: '',
    scanBlockSeverities: ['CRITICAL'],
    ...overrides,
  } as unknown as AppConfig;
}

function docker(report: unknown, options: { code?: number; stderr?: string } = {}) {
  return {
    saveImage: vi.fn(async (_ref: string, _tarPath: string) => ({
      digest: 'sha256:abc',
      ref: 'redis:7.2.5',
    })),
    pull: vi.fn(async () => undefined),
    runCli: vi.fn(async (_command: string, args: readonly string[]) => {
      // Emulate the scanner: the mount ending in `:/scan` is the work directory, `--output` the report.
      const mount = String(args.find((arg) => arg.endsWith(':/scan')) ?? '').replace(
        /:\/scan$/,
        '',
      );
      const target = String(args[args.indexOf('--output') + 1] ?? '/scan/report.json');
      const name = target.replace('/scan/', '');
      writeFileSync(join(mount, name), JSON.stringify(report), 'utf8');
      return { code: options.code ?? 0, stdout: '', stderr: options.stderr ?? '' };
    }),
  };
}

const report = {
  Results: [
    {
      Target: 'redis:7.2.5 (debian 12.5)',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2026-0001',
          PkgName: 'openssl',
          InstalledVersion: '3.0.1',
          FixedVersion: '3.0.2',
          Severity: 'CRITICAL',
          Title: 'Buffer overread in the TLS record layer',
          PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2026-0001',
        },
        {
          VulnerabilityID: 'CVE-2026-0002',
          InstalledVersion: '',
          FixedVersion: '  ',
          Severity: 'weird',
          Description: 'A long description that stands in for a missing title.',
        },
        { PkgName: 'no-id', Severity: 'HIGH' },
        { VulnerabilityID: 'CVE-2026-0003', Severity: 'LOW' },
      ],
    },
  ],
};

describe('parseBlockingSeverities', () => {
  it('normalises case, drops duplicates and ignores a severity the contract does not know', () => {
    expect(parseBlockingSeverities([' CRITICAL ', 'high', 'critical', 'severe', ''])).toEqual([
      'critical',
      'high',
    ]);
  });

  it('answers an empty set when nothing blocks', () => {
    expect(parseBlockingSeverities([])).toEqual([]);
  });
});

describe('scannerVersionOf', () => {
  it('reads the tag, ignoring a registry port', () => {
    expect(scannerVersionOf('aquasec/trivy:0.58.0')).toBe('0.58.0');
    expect(scannerVersionOf('registry.example.test:5000/trivy:0.58.0')).toBe('0.58.0');
  });

  it('reads the tag in front of a digest, and admits when there is none', () => {
    expect(scannerVersionOf('aquasec/trivy:0.58.0@sha256:abc')).toBe('0.58.0');
    expect(scannerVersionOf('aquasec/trivy')).toBe('unknown');
  });
});

describe('scanImage', () => {
  it('blocks on a configured severity and maps the report into findings', async () => {
    const root = workRoot();
    const engine = docker(report);

    const outcome = await scanImage({
      docker: engine as never,
      config: config(),
      reference: 'redis:7.2.5',
      workRoot: root,
    });

    expect(outcome.verdict).toBe('blocked');
    expect(outcome.scannerVersion).toBe('0.58.0');
    expect(outcome.severityCounts).toEqual({ critical: 1, high: 0, medium: 0, low: 1, unknown: 1 });
    expect(outcome.findings[0]).toEqual({
      id: 'CVE-2026-0001',
      package: 'openssl',
      installedVersion: '3.0.1',
      fixedVersion: '3.0.2',
      severity: 'critical',
      title: 'Buffer overread in the TLS record layer',
      url: 'https://avd.aquasec.com/nvd/cve-2026-0001',
    });
    // A vulnerability with no title falls back to its description; a blank fix version is null.
    expect(outcome.findings[1]).toMatchObject({
      package: 'redis:7.2.5 (debian 12.5)',
      fixedVersion: null,
      severity: 'unknown',
      title: 'A long description that stands in for a missing title.',
      url: null,
    });
  });

  it('saves the image to a tar and gives the scanner no socket and no network', async () => {
    const root = workRoot();
    const engine = docker({ Results: [] });

    await scanImage({
      docker: engine as never,
      config: config(),
      reference: 'redis:7.2.5',
      workRoot: root,
    });

    expect(engine.saveImage).toHaveBeenCalledOnce();
    const args = engine.runCli.mock.calls[0]?.[1] ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        '--network',
        'none',
        '--input',
        '/scan/image.tar',
        '--format',
        'json',
      ]),
    );
    // The guard runs over the scanner image too: it is a pull like any other.
    expect(engine.pull).toHaveBeenCalledWith('aquasec/trivy:0.58.0');
    expect(args.join(' ')).not.toContain('docker.sock');
  });

  it('runs offline against the seeded cache and tells the scanner not to fetch a database', async () => {
    const engine = docker({ Results: [] });
    const cache = seededCache();

    await scanImage({
      docker: engine as never,
      config: config({ SEAMNEX_SCAN_CACHE_DIR: cache }),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    const args = engine.runCli.mock.calls[0]?.[1] ?? [];
    expect(args.join(' ')).toContain('--network none');
    expect(args).toEqual(expect.arrayContaining(['--cache-dir', '/cache']));
    // Both skips matter: without them Trivy tries to reach a registry it has no route to and fails.
    expect(args).toEqual(expect.arrayContaining(['--skip-db-update', '--skip-java-db-update']));
    expect(args.some((arg) => arg.endsWith(':/cache'))).toBe(true);
    // Nothing names a repository: `cached` reads what is on disk, not what it could download.
    expect(args.join(' ')).not.toContain('--db-repository');
  });

  it('refuses to scan when the cache was never seeded, before it saves the image', async () => {
    const engine = docker({ Results: [] });
    const empty = mkdtempSync(join(tmpdir(), 'seamnex-trivy-empty-'));

    const outcome = await scanImage({
      docker: engine as never,
      config: config({ SEAMNEX_SCAN_CACHE_DIR: empty }),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    // A missing database is "we could not look", and the remedy is named rather than implied.
    expect(outcome).toMatchObject({ verdict: 'error', failureKind: 'database', findings: [] });
    expect(outcome.failure).toContain('pnpm scan:db:update');
    // The check runs before the tar: hundreds of megabytes is the wrong way to discover this.
    expect(engine.saveImage).not.toHaveBeenCalled();
    expect(engine.runCli).not.toHaveBeenCalled();
  });

  it('refuses a database older than the configured limit', async () => {
    const engine = docker({ Results: [] });
    const stale = seededCache({ updatedAt: new Date(Date.now() - 200 * 3_600_000) });

    const outcome = await scanImage({
      docker: engine as never,
      config: config({ SEAMNEX_SCAN_CACHE_DIR: stale }),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    // A months-old database answers "no findings" for an image nobody really looked at.
    expect(outcome.verdict).toBe('error');
    expect(outcome.failureKind).toBe('database');
    expect(outcome.failure).toContain('over the 168 h limit');
    expect(engine.runCli).not.toHaveBeenCalled();
  });

  it('reports the coverage gap when the Java database was not seeded', async () => {
    const cache = seededCache({ java: false });

    const outcome = await scanImage({
      docker: docker({ Results: [] }) as never,
      config: config({ SEAMNEX_SCAN_CACHE_DIR: cache }),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    // The scan counts, but "passed" must not imply an ecosystem that was skipped.
    expect(outcome.verdict).toBe('passed');
    expect(outcome.warnings?.join(' ')).toContain('JAR-packaged');
  });

  it('uses the configured network and repository in a mode that fetches the database', async () => {
    const engine = docker({ Results: [] });

    await scanImage({
      docker: engine as never,
      config: config({
        SEAMNEX_SCAN_DB_MODE: 'mirror',
        SEAMNEX_SCAN_CACHE_DIR: '',
        SEAMNEX_SCAN_DB_REPOSITORY: 'registry.internal.test/aquasec/trivy-db',
      }),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    const args = engine.runCli.mock.calls[0]?.[1] ?? [];
    // `mirror` needs a route to the mirror, and it names it instead of the public default.
    expect(args.join(' ')).toContain('--network bridge');
    expect(args).toEqual(
      expect.arrayContaining(['--db-repository', 'registry.internal.test/aquasec/trivy-db']),
    );
    expect(args).not.toContain('--skip-db-update');
  });

  it('names every severity the contract knows, and treats a missing one as unknown', async () => {
    const engine = docker({
      Results: [
        {
          Target: 'redis:7.2.5',
          Vulnerabilities: [
            { VulnerabilityID: 'CVE-2026-0010', Severity: 'HIGH' },
            // Trivy omits the key entirely for a finding it could not rate; that is not a pass.
            { VulnerabilityID: 'CVE-2026-0011' },
          ],
        },
      ],
    });

    const outcome = await scanImage({
      docker: engine as never,
      config: config({ scanBlockSeverities: ['HIGH'] }),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    expect(outcome.findings.map((finding) => [finding.id, finding.severity])).toEqual([
      ['CVE-2026-0010', 'high'],
      ['CVE-2026-0011', 'unknown'],
    ]);
    // The blocking set is configuration, so a `HIGH` finding blocks when the operator asked for it.
    expect(outcome.verdict).toBe('blocked');
  });

  it('reads a report with no results and a result with no vulnerabilities as no findings', async () => {
    const withoutResults = await scanImage({
      docker: docker({}) as never,
      config: config(),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });
    expect(withoutResults.verdict).toBe('passed');
    expect(withoutResults.findings).toEqual([]);

    // A `Results` entry with no `Vulnerabilities` key is the same answer, not a crash.
    const withoutVulnerabilities = await scanImage({
      docker: docker({ Results: [{}] }) as never,
      config: config(),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });
    expect(withoutVulnerabilities.verdict).toBe('passed');
    expect(withoutVulnerabilities.findings).toEqual([]);
  });

  it('passes an image whose findings are all below the blocking set', async () => {
    const engine = docker({
      Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-2026-0009', Severity: 'MEDIUM' }] }],
    });

    const outcome = await scanImage({
      docker: engine as never,
      config: config({ scanBlockSeverities: ['CRITICAL', 'HIGH'] }),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    expect(outcome.verdict).toBe('passed');
  });

  it('treats a non-zero exit as an error verdict carrying the scanner output', async () => {
    const engine = docker({}, { code: 2, stderr: 'FATAL failed to download vulnerability DB' });

    const outcome = await scanImage({
      docker: engine as never,
      config: config(),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    expect(outcome).toMatchObject({
      verdict: 'error',
      findings: [],
      failure: 'scanner exited 2: FATAL failed to download vulnerability DB',
    });
  });

  it('falls back to stdout when the scanner writes its failure there', async () => {
    const engine = docker({}, { code: 1 });
    engine.runCli.mockResolvedValueOnce({ code: 1, stdout: 'no such image', stderr: '' });

    const outcome = await scanImage({
      docker: engine as never,
      config: config(),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    expect(outcome.failure).toBe('scanner exited 1: no such image');
  });

  it('reports a failed save as an error verdict, not as a crash', async () => {
    const engine = docker({ Results: [] });
    engine.saveImage.mockRejectedValueOnce(new Error('no such image: redis:7.2.5'));

    const outcome = await scanImage({
      docker: engine as never,
      config: config(),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    expect(outcome).toMatchObject({ verdict: 'error', failure: 'no such image: redis:7.2.5' });
    expect(engine.runCli).not.toHaveBeenCalled();
  });

  it('reports an unreadable report as an error verdict rather than an empty pass', async () => {
    const engine = docker({ Results: [] });
    engine.runCli.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    const outcome = await scanImage({
      docker: engine as never,
      config: config(),
      reference: 'redis:7.2.5',
      workRoot: workRoot(),
    });

    // The scanner claimed success but wrote nothing: that is "we could not look".
    expect(outcome.verdict).toBe('error');
    expect(outcome.failure).toContain('report.json');
  });

  it('removes the work directory even when the scan failed', async () => {
    const root = workRoot();
    const engine = docker({ Results: [] });
    engine.runCli.mockRejectedValueOnce(new Error('timeout'));

    await scanImage({
      docker: engine as never,
      config: config(),
      reference: 'redis:7.2.5',
      workRoot: root,
    });

    expect(existsSync(join(root, 'image.tar'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('hands the daemon the host spelling of the work directory, not the in-container one', async () => {
    const root = workRoot();
    const engine = docker({ Results: [] });

    await scanImage({
      docker: engine as never,
      // `containerPath=hostPath`: this process sees the work root, the daemon sees `/var/lib/seamnex`.
      config: config({ SEAMNEX_DOCKER_PATH_MAP: `${root}=/var/lib/seamnex` }),
      reference: 'redis:7.2.5',
      workRoot: root,
    });

    const args = engine.runCli.mock.calls[0]?.[1] ?? [];
    const mount = args[args.indexOf('-v') + 1] ?? '';
    expect(mount.replace(/\\/g, '/')).toMatch(/^\/var\/lib\/seamnex\/scan-/);
    expect(mount.endsWith(':/scan')).toBe(true);
  });
});
