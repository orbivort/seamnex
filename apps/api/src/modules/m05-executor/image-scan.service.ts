import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import type {
  ImageScanFinding,
  ImageScanReport,
  ImageScanSeverityCounts,
  ImageScanSummary,
  ScanSeverity,
} from '@seamnex/domain';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { DockerEngineClient } from '../../common/docker/docker.client';
import {
  parseBlockingSeverities,
  scanImage,
  type ScanOutcome,
} from '../../common/docker/image-scan';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';

/**
 * NFR-4.6 / S-10 — retained image scans, one row per (instance, digest, scanner).
 *
 * The row is the evidence: which digest was scanned, by which scanner, with which threshold, what it
 * found, and whether that stopped the deployment. The review's finding was that nothing was retained
 * and nothing was scanned; both halves are answered here rather than in the pipeline, so the same
 * code serves the deployment, the instance screen and the retention sweep.
 *
 * Reuse is deliberate. A re-deploy of the same pinned digest reuses a `passed` report instead of
 * rescanning: the image has not changed, the vulnerability database may have, and re-scanning would
 * make every restart depend on a network round trip to the advisory feed. A *blocked* or errored row
 * is rescanned, because the reason to look again is that the answer might now be different.
 */
export type ImageScanLog = (level: 'stdout' | 'system', line: string) => Promise<void>;

export type ScanForDeployInput = {
  readonly instanceId: string;
  readonly references: readonly string[];
  readonly log?: ImageScanLog;
};

type ScanRow = {
  instance_id: string;
  image_ref: string;
  image_digest: string;
  scanner: string;
  scanner_version: string;
  verdict: 'passed' | 'blocked' | 'error';
  blocking_severities: string[];
  severity_counts: Record<string, number>;
  findings: unknown;
  report_key: string | null;
  scanned_at: Date;
};

@Injectable()
export class PostgresImageScanService {
  private readonly logger = new Logger('m05-image-scan');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
  ) {}

  /**
   * Scans everything the deployment is about to start, before `compose up`.
   *
   * Order matters: `imageIdentity` is how the digest is known, and the digest is what makes the
   * report reusable and the row unique. A scan keyed on a mutable tag would file last month's report
   * against this month's image.
   */
  async scanForDeploy(input: ScanForDeployInput): Promise<ImageScanSummary[]> {
    // A deployment run always passes a log sink; a direct call (the retention-triggered rescan) does
    // not, and a discarded line is the right sink there.
    const log: ImageScanLog = input.log ?? (() => Promise.resolve());
    if (!this.config.SEAMNEX_SCAN_ENABLED) {
      /*
       * Disabled is a state, not a pass. The line is written into the job log and the instance
       * carries no `scan` field, so the screen says "not scanned" rather than implying health.
       */
      await log(
        'system',
        'image scanning is disabled (SEAMNEX_SCAN_ENABLED=false): no scan was performed',
      );
      return [];
    }

    const blocking = new Set<ScanSeverity>(
      parseBlockingSeverities(this.config.scanBlockSeverities),
    );
    const summaries: ImageScanSummary[] = [];
    const seen = new Set<string>();

    for (const reference of input.references) {
      if (reference.trim().length === 0 || seen.has(reference)) continue;
      seen.add(reference);

      const identity = await this.docker.imageIdentity(reference);
      const retained = await this.findRow(input.instanceId, identity.digest);
      if (retained !== null && retained.verdict === 'passed') {
        await log(
          'stdout',
          `${reference} (${shortDigest(identity.digest)}): reusing the retained scan from ${retained.scanned_at.toISOString()}`,
        );
        summaries.push(summaryOf(retained));
        continue;
      }

      await log('stdout', `scanning ${reference} (${shortDigest(identity.digest)})`);
      const outcome = await scanImage({
        docker: this.docker,
        config: this.config,
        reference,
        workRoot: this.config.SEAMNEX_SCAN_TMP_DIR,
      });
      const persisted = await this.persist(input.instanceId, reference, identity.digest, outcome);
      summaries.push(summaryOf(persisted));

      if (persisted.verdict === 'passed') {
        await log(
          'stdout',
          `${reference}: ${outcome.severityCounts.critical} critical, ${outcome.severityCounts.high} high, ${outcome.severityCounts.medium} medium`,
        );
        continue;
      }

      const detail =
        persisted.verdict === 'blocked'
          ? `${reference} has findings at a blocking severity (${[...blocking].join(', ') || 'none configured'}).`
          : `${reference} could not be scanned: ${outcome.failure ?? 'unknown scanner failure'}.`;

      await this.audit
        .append({
          action: 'deployment.image_scan.blocked',
          actorType: 'system',
          actorId: 'image-scan',
          targetType: 'instance',
          targetId: input.instanceId,
          outcome: 'failure',
          detail: {
            verdict: persisted.verdict,
            imageRef: reference,
            imageDigest: identity.digest,
            scanner: outcome.scanner,
            scannerVersion: outcome.scannerVersion,
            severityCounts: outcome.severityCounts,
            failure: outcome.failure,
          },
        })
        // An audit outage must not turn a blocked image into a started container: the refusal below
        // still happens, and the log records why the evidence is missing.
        .catch((error: unknown) => {
          this.logger.warn(`image_scan audit append failed: ${(error as Error).message}`);
        });

      if (this.config.SEAMNEX_SCAN_FAIL_OPEN) {
        await log(
          'system',
          `${detail} Continuing because SEAMNEX_SCAN_FAIL_OPEN=true; this deployment is marked as unscanned.`,
        );
        continue;
      }

      await log('system', detail);
      throw new AppError({
        code: 'IMAGE_SCAN_BLOCKED',
        detail: `${detail} The deployment was stopped before any container started.`,
        remediation:
          persisted.verdict === 'blocked'
            ? 'Upgrade the pinned image to a release that fixes the blocking findings, then redeploy.'
            : 'Make the scanner image reachable from the deployment host (SEAMNEX_SCANNER_IMAGE, trusted registry), then redeploy.',
      });
    }

    return summaries;
  }

  /** NFR-4.6: the retained report for one digest. Absence is `NOT_FOUND`, never an empty pass. */
  async report(instanceId: string, digest: string): Promise<ImageScanReport> {
    const row = await this.findRow(instanceId, digest);
    if (row === null) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No retained scan exists for image ${digest} of instance ${instanceId}.`,
        remediation:
          'Deploy the instance (or redeploy it) so the image is scanned before it starts.',
      });
    }
    return {
      ...summaryOf(row),
      instanceId: row.instance_id,
      imageRef: row.image_ref,
      imageDigest: row.image_digest,
      findings: findingsOf(row.findings),
      reportKey: row.report_key,
    };
  }

  /** The newest report per digest, for the image list beside each image. */
  async summaries(instanceId: string): Promise<ReadonlyMap<string, ImageScanSummary>> {
    const result = await this.pool.query<ScanRow>(
      `SELECT DISTINCT ON (image_digest) *
         FROM image_scan_result
        WHERE instance_id = $1
        ORDER BY image_digest, scanned_at DESC`,
      [instanceId],
    );
    const summaries = new Map<string, ImageScanSummary>();
    for (const row of result.rows) summaries.set(row.image_digest, summaryOf(row));
    return summaries;
  }

  /** S-10 retention: reports older than `days` are deleted; the count is what the sweep logs. */
  async prune(days: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM image_scan_result
        WHERE scanned_at < now() - make_interval(days => $1)`,
      [Math.max(1, Math.trunc(days))],
    );
    return result.rowCount ?? 0;
  }

  private async findRow(instanceId: string, digest: string): Promise<ScanRow | null> {
    const result = await this.pool.query<ScanRow>(
      `SELECT *
         FROM image_scan_result
        WHERE instance_id = $1 AND image_digest = $2
        ORDER BY scanned_at DESC
        LIMIT 1`,
      [instanceId, digest],
    );
    return result.rows[0] ?? null;
  }

  private async persist(
    instanceId: string,
    reference: string,
    digest: string,
    outcome: ScanOutcome,
  ): Promise<ScanRow> {
    const result = await this.pool.query<ScanRow>(
      `INSERT INTO image_scan_result (
         instance_id, image_ref, image_digest, scanner, scanner_version, verdict,
         blocking_severities, severity_counts, findings, report_key, scanned_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NULL, now())
       ON CONFLICT (instance_id, image_digest, scanner) DO UPDATE
          SET image_ref = EXCLUDED.image_ref,
              scanner_version = EXCLUDED.scanner_version,
              verdict = EXCLUDED.verdict,
              blocking_severities = EXCLUDED.blocking_severities,
              severity_counts = EXCLUDED.severity_counts,
              findings = EXCLUDED.findings,
              scanned_at = now()
       RETURNING *`,
      [
        instanceId,
        reference,
        digest,
        outcome.scanner,
        outcome.scannerVersion,
        outcome.verdict,
        parseBlockingSeverities(this.config.scanBlockSeverities),
        JSON.stringify(outcome.severityCounts),
        JSON.stringify(outcome.findings),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail:
          'the scan result could not be stored, so the deployment cannot be shown to be scanned.',
      });
    }
    return row;
  }
}

function summaryOf(row: ScanRow): ImageScanSummary {
  return {
    verdict: row.verdict,
    scanner: row.scanner,
    scannerVersion: row.scanner_version,
    scannedAt: row.scanned_at.toISOString(),
    severityCounts: countsOf(row.severity_counts),
    blockingSeverities: row.blocking_severities.filter(isSeverity),
  };
}

function countsOf(value: Record<string, number>): ImageScanSeverityCounts {
  const read = (key: string): number => {
    const count = value[key];
    return typeof count === 'number' && Number.isFinite(count) ? count : 0;
  };
  return {
    critical: read('critical'),
    high: read('high'),
    medium: read('medium'),
    low: read('low'),
    unknown: read('unknown'),
  };
}

function findingsOf(value: unknown): ImageScanFinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ImageScanFinding => {
    if (typeof entry !== 'object' || entry === null) return false;
    const finding = entry as Record<string, unknown>;
    return (
      typeof finding.id === 'string' &&
      typeof finding.package === 'string' &&
      typeof finding.installedVersion === 'string' &&
      typeof finding.title === 'string' &&
      typeof finding.severity === 'string'
    );
  });
}

function isSeverity(value: string): value is ScanSeverity {
  return (
    value === 'critical' ||
    value === 'high' ||
    value === 'medium' ||
    value === 'low' ||
    value === 'unknown'
  );
}

function shortDigest(digest: string): string {
  return digest.startsWith('sha256:') ? digest.slice(7, 19) : digest.slice(0, 12);
}
