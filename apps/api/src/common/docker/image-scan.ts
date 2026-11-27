import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ImageScanFinding,
  ImageScanSeverityCounts,
  ScanSeverity,
  ScanVerdict,
} from '@seamnex/domain';
import type { AppConfig } from '../../config/config';
import type { DockerEngineClient } from './docker.client';
import { dockerMountSource } from './mount';
import {
  javaDatabaseSeeded,
  scanCacheDir,
  scanDbMode,
  scannerNetwork,
  vulnDatabaseRepository,
  vulnDatabaseStatus,
} from './vuln-db';

/**
 * NFR-4.6 / S-10 — scan the image the deployment is about to run.
 *
 * The review's finding was exact: Trivy ran over `seamnex-api` in CI, printed to a log and retained
 * nothing, while no product image was ever scanned. Three decisions make this the control rather
 * than the ritual:
 *
 *   1. **The scanner gets a tar, not the socket.** Mounting the daemon socket into a scanner
 *      container is the usual shortcut, and it hands a third-party image the platform's whole
 *      Engine API. The socket proxy already refuses BuildKit sessions for the same reason
 *      (`upstream/D02-01/docker-compose.yml` in the catalogue checkout). `docker save` gives the
 *      scanner the bytes it
 *      needs and nothing else.
 *   2. **The answer is a verdict, not a log line.** `passed`, `blocked` and `error` are distinct:
 *      `error` is "we could not look", and treating it as a pass is the defect S-10 names.
 *   3. **The work directory is removed in a `finally`.** An image tar is hundreds of megabytes; a
 *      leak per deployment fills a host disk within a week.
 *   4. **No network means a pre-seeded database.** A scanner with no route cannot fetch advisories,
 *      so the cache under `SEAMNEX_SCAN_CACHE_DIR` is mounted into it and its age decides whether the
 *      scan may run at all (`vuln-db.ts`). The alternative — opening the route — would make every
 *      deployment depend on a third-party registry staying reachable.
 */

export type ScanOutcome = {
  readonly verdict: ScanVerdict;
  readonly scanner: string;
  readonly scannerVersion: string;
  readonly severityCounts: ImageScanSeverityCounts;
  readonly findings: readonly ImageScanFinding[];
  /** Set when the scan could not run at all; `null` on a completed scan. */
  readonly failure: string | null;
  /**
   * Which remedy the failure calls for: a database that was never seeded is repaired by
   * `pnpm scan:db:update`, a scanner that could not start by fixing `SEAMNEX_SCANNER_IMAGE`. Without
   * the distinction the operator is sent to the scanner image for a problem it cannot cause.
   */
  readonly failureKind?: 'database' | 'scanner';
  /** Coverage the scanner ran without (e.g. no Java database), reported rather than hidden. */
  readonly warnings?: readonly string[];
};

type TrivyVulnerability = {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
};

type TrivyReport = {
  Results?: Array<{ Target?: string; Vulnerabilities?: TrivyVulnerability[] }>;
};

/** `CRITICAL,HIGH` → `['critical','high']`, the casing the contract uses. */
export function parseBlockingSeverities(value: readonly string[]): ScanSeverity[] {
  const known = new Set<ScanSeverity>(['critical', 'high', 'medium', 'low', 'unknown']);
  const parsed: ScanSeverity[] = [];
  for (const raw of value) {
    const severity = raw.trim().toLowerCase();
    if (known.has(severity as ScanSeverity) && !parsed.includes(severity as ScanSeverity)) {
      parsed.push(severity as ScanSeverity);
    }
  }
  return parsed;
}

/** `aquasec/trivy:0.57.1` → `0.57.1`, so a report can say which scanner produced it. */
export function scannerVersionOf(image: string): string {
  const withoutDigest = image.split('@')[0] ?? image;
  const colon = withoutDigest.lastIndexOf(':');
  return colon > withoutDigest.lastIndexOf('/') ? withoutDigest.slice(colon + 1) : 'unknown';
}

/**
 * Saves the image, runs the pinned scanner over it, and parses the report.
 *
 * Never throws for a scanner failure: an unreachable scanner is an `error` outcome, and the caller
 * decides whether that blocks (it does, unless `SEAMNEX_SCAN_FAIL_OPEN`). Throwing here would turn a
 * missing scanner into an unhandled pipeline crash instead of a recorded verdict.
 */
export async function scanImage(input: {
  readonly docker: DockerEngineClient;
  readonly config: AppConfig;
  readonly reference: string;
  readonly workRoot: string;
}): Promise<ScanOutcome> {
  const scanner = input.config.SEAMNEX_SCANNER_IMAGE;
  const scannerVersion = scannerVersionOf(scanner);
  const empty = emptyCounts();

  // Asked before the image is saved: an unseeded cache cannot answer, and a tar of hundreds of
  // megabytes is the wrong way to find that out.
  const database = vulnDatabaseStatus(input.config);
  if (database.ok === false) {
    return {
      verdict: 'error',
      scanner,
      scannerVersion,
      severityCounts: empty,
      findings: [],
      failure: database.failure,
      failureKind: 'database',
      warnings: [],
    };
  }

  const mode = scanDbMode(input.config);
  const cacheDir = scanCacheDir(input.config);
  const repository = vulnDatabaseRepository(input.config);
  const warnings: string[] = [];
  if (mode === 'cached' && !javaDatabaseSeeded(input.config)) {
    // Trivy skips JAR scanning without a java database. The scan still counts as a scan, but the
    // coverage is narrower than "vuln", and a clean pass that silently omitted a whole ecosystem is
    // the kind of claim S-10 exists to stop.
    warnings.push(
      'the Java database is not seeded, so JAR-packaged dependencies were not scanned; run `pnpm scan:db:update` to cover them',
    );
  }

  const directory = join(input.workRoot, `scan-${Date.now()}-${process.pid}`);
  try {
    mkdirSync(directory, { recursive: true });
    const tarPath = join(directory, 'image.tar');
    const reportPath = join(directory, 'report.json');

    await input.docker.saveImage(input.reference, tarPath);
    // The scanner container is a second `docker run`; its mounts are resolved by the daemon, so the
    // host spelling of these directories is what has to be passed.
    const mount = dockerMountSource(directory, input.config.SEAMNEX_DOCKER_PATH_MAP);
    const cacheMount =
      cacheDir.length > 0 ? dockerMountSource(cacheDir, input.config.SEAMNEX_DOCKER_PATH_MAP) : '';

    // The scanner image is pulled through the same trusted-registry guard as any product image.
    await input.docker.pull(scanner);
    const result = await input.docker.runCli(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${mount}:/scan`,
        ...(cacheMount.length > 0 ? ['-v', `${cacheMount}:/cache`] : []),
        '--network',
        scannerNetwork(input.config),
        scanner,
        'image',
        '--input',
        '/scan/image.tar',
        '--format',
        'json',
        '--output',
        '/scan/report.json',
        '--scanners',
        'vuln',
        '--quiet',
        // Trivy keeps its own analysis deadline — five minutes — and it knows nothing about the
        // ceiling this platform kills the process at. A 3.4 GB image therefore failed with
        // `analyze error: pipeline error: context deadline exceeded` *after* the operator raised
        // `SEAMNEX_SCAN_TIMEOUT_MS`, because the inner clock had not moved with the outer one.
        // Derived from the outer ceiling and kept below it, so the scanner gets to say why it gave
        // up rather than being SIGKILLed and reported as `[killed after … ms]`.
        '--timeout',
        `${Math.max(60, Math.floor(input.config.SEAMNEX_SCAN_TIMEOUT_MS / 1000) - 15)}s`,
        ...(cacheMount.length > 0 ? ['--cache-dir', '/cache'] : []),
        // Cached mode has no route to anything, so asking Trivy to refresh would be a guaranteed
        // failure after the database was found; the same goes for the java database.
        ...(mode === 'cached' ? ['--skip-db-update', '--skip-java-db-update'] : []),
        ...(mode !== 'cached' && repository.length > 0 ? ['--db-repository', repository] : []),
      ],
      input.config.SEAMNEX_SCAN_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      return {
        verdict: 'error',
        scanner,
        scannerVersion,
        severityCounts: empty,
        findings: [],
        failure: `scanner exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
        failureKind: 'scanner',
        warnings,
      };
    }

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as TrivyReport;
    const findings = findingsOf(report);
    const blocking = new Set(parseBlockingSeverities(input.config.scanBlockSeverities));
    const blocked = findings.some((finding) => blocking.has(finding.severity));
    return {
      verdict: blocked ? 'blocked' : 'passed',
      scanner,
      scannerVersion,
      severityCounts: countOf(findings),
      findings,
      failure: null,
      warnings,
    };
  } catch (error) {
    return {
      verdict: 'error',
      scanner,
      scannerVersion,
      severityCounts: empty,
      findings: [],
      failure: (error as Error).message.slice(0, 400),
      failureKind: 'scanner',
      warnings,
    };
  } finally {
    // Best-effort: a failed delete must not mask the verdict.
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* the directory is under SEAMNEX_SCAN_TMP_DIR; the retention sweep is the backstop */
    }
  }
}

function findingsOf(report: TrivyReport): ImageScanFinding[] {
  const findings: ImageScanFinding[] = [];
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      const id = vulnerability.VulnerabilityID ?? '';
      if (id.length === 0) continue;
      findings.push({
        id,
        package: vulnerability.PkgName ?? result.Target ?? 'unknown',
        installedVersion: vulnerability.InstalledVersion ?? 'unknown',
        fixedVersion: normaliseFixedVersion(vulnerability.FixedVersion),
        severity: normaliseSeverity(vulnerability.Severity),
        title: (vulnerability.Title ?? vulnerability.Description ?? id).slice(0, 300),
        url: vulnerability.PrimaryURL ?? null,
      });
    }
  }
  return findings;
}

function normaliseSeverity(value: string | undefined): ScanSeverity {
  switch ((value ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      // Trivy emits UNKNOWN and (rarely) an empty string; both are findings, never a pass.
      return 'unknown';
  }
}

function normaliseFixedVersion(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function countOf(findings: readonly ImageScanFinding[]): ImageScanSeverityCounts {
  const counts = emptyCounts();
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function emptyCounts(): ImageScanSeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
}
