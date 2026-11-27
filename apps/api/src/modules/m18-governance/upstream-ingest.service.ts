import { Inject, Injectable, Logger } from '@nestjs/common';
import { withTransaction, type Queryable } from '@seamnex/db';
import type { Pool } from 'pg';
import { updateAvailable } from '@seamnex/domain';
import type { ScanSeverity, UpstreamObservationResult } from '@seamnex/domain';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import type { UpstreamObservationActor, UpstreamObserver } from './governance.contract';
import {
  UpstreamFeedClient,
  type FeedOutcome,
  type UpstreamAdvisory,
  type UpstreamRelease,
} from './upstream-feed.client';

/**
 * FR-2.12 / FR-4.7 / NFR-4.7 — the pass that turns the patch register into an observation.
 *
 * The register was a projection of `catalog_entry.payload.upstream`, so its `checkedAt` moved only
 * when somebody edited a JSON file; the review's finding was that "tracking" was a claim, not a
 * measurement. This pass asks each entry's upstream what it released and what is open, then writes
 * `patch_record` per instance and `patch_advisory` per entry.
 *
 * Three rules keep the honesty property:
 *   - **A failed feed writes nothing.** The previous observation stays, with its own timestamp,
 *     rather than being cleared to "nothing pending" because a socket timed out.
 *   - **`patch_advisory` is keyed by entry, not instance.** An advisory affects the product; every
 *     instance inherits it, and closing one is a later pass not seeing it.
 *   - **`catalog_entry` is never rewritten.** M18 owns `patch_record`; the entry document is M01/M22's
 *     input, and a tracking pass that edited it would make the catalogue a mutable side effect.
 */
@Injectable()
export class UpstreamIngestService implements UpstreamObserver {
  private readonly logger = new Logger('m18-upstream-ingest');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UpstreamFeedClient) private readonly feeds: UpstreamFeedClient,
  ) {}

  async observe(actor: UpstreamObservationActor): Promise<UpstreamObservationResult> {
    if (!this.config.SEAMNEX_UPSTREAM_TRACKING_ENABLED) {
      throw new AppError({
        code: 'UNAVAILABLE',
        detail: 'upstream tracking is disabled (SEAMNEX_UPSTREAM_TRACKING_ENABLED=false).',
        remediation:
          'Enable it and restart the scheduler, or run the observation from a host that may.',
      });
    }

    const entries = await this.loadEntries();
    if (entries.length === 0) {
      return emptyResult();
    }

    /*
     * Sequential, not `Promise.all` over the whole catalogue. Each entry costs two outbound calls,
     * and a batch cap that still fired them all at once would only move the burst into the feeds'
     * rate limiters — where the answer becomes "failed" for entries that were perfectly healthy.
     */
    const observations: EntryObservation[] = [];
    for (const entry of entries) {
      observations.push(await this.observeEntry(entry));
    }

    const written = await this.persist(observations, actor);

    return {
      observedAt: new Date().toISOString(),
      entries: observations.length,
      releases: written.releases,
      advisories: written.advisoryEntries,
      skipped: observations.filter((item) => item.skipped).length,
      failed: observations.filter((item) => item.failed).length,
      instancesUpdated: written.instancesUpdated,
    };
  }

  private async observeEntry(entry: CatalogRow): Promise<EntryObservation> {
    const [release, advisories] = await Promise.all([
      this.feeds.release(entry.repo_url),
      this.feeds.advisories(entry.repo_url),
    ]);

    return {
      entry,
      release,
      advisories,
      observedRelease: release.kind === 'ok' ? release.value : null,
      observedAdvisories: advisories.kind === 'ok' ? advisories.value : null,
      // "Nothing to ask" is not "asked and failed": an entry with no GitHub repository has no feed
      // to be unhealthy, and counting it as a failure would make the pass look broken every run.
      skipped: release.kind === 'skipped' && advisories.kind !== 'failed',
      failed: release.kind === 'failed' || advisories.kind === 'failed',
    };
  }

  /**
   * One transaction for the whole write, with the audit chain locked first (AD-20).
   *
   * The feed calls finished above, so no network wait happens while the chain lock is held. Advisory
   * rows are reconciled before `patch_record` is derived, because the register's numbers come from
   * the table rather than from this pass's answer — which is what lets a partial failure keep the
   * previous state instead of clearing it.
   */
  private async persist(
    observations: readonly EntryObservation[],
    actor: UpstreamObservationActor,
  ): Promise<PersistSummary> {
    const summary: PersistSummary = { instancesUpdated: 0, releases: 0, advisoryEntries: 0 };

    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);

      for (const observation of observations) {
        if (observation.failed) continue;
        const entryKey = observation.entry.key;

        const previous = await tx.query<{ latest_version: string | null }>(
          `SELECT max(pr.latest_version) AS latest_version
             FROM patch_record pr
             JOIN instance i ON i.id = pr.instance_id
            WHERE i.entry_key = $1 AND i.deleted_at IS NULL`,
          [entryKey],
        );

        const known = await this.openAdvisories(tx, entryKey);
        if (observation.observedAdvisories !== null) {
          await this.syncAdvisories(tx, entryKey, observation.observedAdvisories, known, actor);
        }

        const open = await this.openAdvisories(tx, entryKey);
        if (open.length > 0) summary.advisoryEntries += 1;

        const oldest = oldestUnappliedDays(open);
        const lead = leadAdvisory(open);

        const written = await tx.query(
          `INSERT INTO patch_record (
             instance_id, current_version, latest_version, oldest_unapplied_security_days,
             checked_at, advisory_id, advisory_severity, advisory_url, release_url,
             source, last_observed_at
           )
           SELECT i.id, NULL, $2, $3, now(), $4, $5, $6, $7, 'observed', now()
             FROM instance i
            WHERE i.entry_key = $1 AND i.deleted_at IS NULL
           ON CONFLICT (instance_id) DO UPDATE
              SET latest_version =
                    coalesce(EXCLUDED.latest_version, patch_record.latest_version),
                  oldest_unapplied_security_days = EXCLUDED.oldest_unapplied_security_days,
                  checked_at = now(),
                  advisory_id = EXCLUDED.advisory_id,
                  advisory_severity = EXCLUDED.advisory_severity,
                  advisory_url = EXCLUDED.advisory_url,
                  release_url = coalesce(EXCLUDED.release_url, patch_record.release_url),
                  source = 'observed',
                  last_observed_at = now()`,
          [
            entryKey,
            observation.observedRelease?.version ?? null,
            oldest,
            lead?.advisory_id ?? null,
            lead?.severity ?? null,
            lead?.url ?? null,
            observation.observedRelease?.url ?? null,
          ],
        );
        summary.instancesUpdated += written.rowCount ?? 0;

        const before = previous.rows[0]?.latest_version ?? null;
        const after = observation.observedRelease?.version ?? null;
        if (after !== null && after !== before) {
          /*
           * `releases` is what the operator reads as "N with a newer release". GitHub answers with
           * the most recently *published* release, so a maintenance cut on the previous branch can
           * move this value backwards; that is an observation worth auditing, but it is not a
           * release anyone can upgrade to.
           */
          const newer = before === null || updateAvailable(before, after);
          if (newer) summary.releases += 1;
          /*
           * Audited separately from the per-entry observation so the trail can answer "when did the
           * platform first learn 5.4 was out" without reading every register row.
           */
          await this.audit.append(
            {
              action: 'upstream.release.observed',
              actorType: actor.type,
              actorId: actor.id,
              targetType: 'catalog_entry',
              targetId: entryKey,
              outcome: 'success',
              detail: {
                from: before,
                to: after,
                newer,
                url: observation.observedRelease?.url ?? null,
              },
            },
            tx,
          );
        }

        // The register row is the evidence; this per-entry row answers "did the pass reach the
        // product", which a single pass-level count cannot.
        await this.audit.append(
          {
            action: 'patch.register.observed',
            actorType: actor.type,
            actorId: actor.id,
            targetType: 'catalog_entry',
            targetId: entryKey,
            outcome: 'success',
            detail: {
              latestVersion: observation.observedRelease?.version ?? null,
              openAdvisories: open.length,
              oldestUnappliedSecurityDays: oldest,
              releaseReached: observation.release.kind,
              advisoriesReached: observation.advisories.kind,
              failure: feedFailureReason(observation),
            },
          },
          tx,
        );
      }
    });

    if (summary.advisoryEntries > 0) {
      this.logger.log(
        { advisoryEntries: summary.advisoryEntries, instances: summary.instancesUpdated },
        'upstream pass updated the patch register',
      );
    }
    return summary;
  }

  /**
   * Applies one entry's advisory list: upserts what was seen, closes what was not.
   *
   * `known` is the open set *before* this pass, so an advisory absent from it is newly opened —
   * including one that had been closed and reopened, which is the honest reading for an audit trail.
   */
  private async syncAdvisories(
    tx: Queryable,
    entryKey: string,
    advisories: readonly UpstreamAdvisory[],
    known: readonly OpenAdvisoryRow[],
    actor: UpstreamObservationActor,
  ): Promise<void> {
    const previous = new Set(known.map((row) => row.advisory_id));

    for (const advisory of advisories) {
      await tx.query(
        `INSERT INTO patch_advisory (
           entry_key, advisory_id, severity, summary, url, fixed_version, published_at,
           observed_at, closed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), NULL)
         ON CONFLICT (entry_key, advisory_id) DO UPDATE
            SET severity = EXCLUDED.severity,
                summary = EXCLUDED.summary,
                url = EXCLUDED.url,
                fixed_version = EXCLUDED.fixed_version,
                published_at = coalesce(EXCLUDED.published_at, patch_advisory.published_at),
                observed_at = now(),
                closed_at = NULL`,
        [
          entryKey,
          advisory.id,
          advisory.severity,
          advisory.summary,
          advisory.url,
          advisory.fixedVersion,
          advisory.publishedAt,
        ],
      );

      if (previous.has(advisory.id)) continue;
      await this.audit.append(
        {
          action: 'upstream.advisory.opened',
          actorType: actor.type,
          actorId: actor.id,
          targetType: 'catalog_entry',
          targetId: entryKey,
          outcome: 'success',
          detail: {
            advisoryId: advisory.id,
            severity: advisory.severity,
            fixedVersion: advisory.fixedVersion,
          },
        },
        tx,
      );
    }

    /*
     * Closing is only correct when the answer is authoritative: an empty list from OSV is a real
     * "nothing open for this package", and a failed call never reaches this method.
     */
    await tx.query(
      `UPDATE patch_advisory
          SET closed_at = now()
        WHERE entry_key = $1
          AND closed_at IS NULL
          AND NOT (advisory_id = ANY($2::text[]))`,
      [entryKey, advisories.map((advisory) => advisory.id)],
    );
  }

  private async openAdvisories(tx: Queryable, entryKey: string): Promise<OpenAdvisoryRow[]> {
    const result = await tx.query<OpenAdvisoryRow>(
      `SELECT advisory_id, severity, url, fixed_version,
              coalesce(published_at, observed_at) AS since
         FROM patch_advisory
        WHERE entry_key = $1 AND closed_at IS NULL`,
      [entryKey],
    );
    return result.rows;
  }

  private async loadEntries(): Promise<CatalogRow[]> {
    const result = await this.pool.query<CatalogRow>(
      `SELECT key, product, repo_url
         FROM catalog_entry
        ORDER BY key
        LIMIT $1`,
      [this.config.SEAMNEX_UPSTREAM_BATCH],
    );
    return result.rows;
  }
}

type PersistSummary = {
  instancesUpdated: number;
  releases: number;
  advisoryEntries: number;
};

type CatalogRow = {
  key: string;
  product: string;
  repo_url: string | null;
};

type OpenAdvisoryRow = {
  advisory_id: string;
  severity: ScanSeverity;
  url: string | null;
  fixed_version: string | null;
  since: Date;
};

type EntryObservation = {
  readonly entry: CatalogRow;
  readonly release: FeedOutcome<UpstreamRelease | null>;
  readonly advisories: FeedOutcome<readonly UpstreamAdvisory[]>;
  readonly observedRelease: UpstreamRelease | null;
  readonly observedAdvisories: readonly UpstreamAdvisory[] | null;
  readonly skipped: boolean;
  readonly failed: boolean;
};

const SEVERITY_RANK: Readonly<Record<ScanSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

/**
 * NFR-4.7 — the age of the oldest *unapplied* security update.
 *
 * An advisory with no published fix is open but not applicable: counting it would keep the register
 * permanently red for something no upgrade can clear. `null` means there is nothing to wait on,
 * which is different from "we never looked" — the latter keeps the previous row untouched.
 */
function oldestUnappliedDays(open: readonly OpenAdvisoryRow[]): number | null {
  const fixable = open.filter((row) => row.fixed_version !== null);
  const oldest = fixable.reduce<Date | null>(
    (acc, row) => (acc === null || row.since < acc ? row.since : acc),
    null,
  );
  if (oldest === null) return null;
  return Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 86_400_000));
}

/** The advisory the register shows: worst severity first, then the one open longest. */
function leadAdvisory(open: readonly OpenAdvisoryRow[]): OpenAdvisoryRow | null {
  if (open.length === 0) return null;
  const sorted = [...open].sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return rank !== 0 ? rank : a.since.getTime() - b.since.getTime();
  });
  return sorted[0] ?? null;
}

function feedFailureReason(observation: EntryObservation): string | null {
  if (observation.release.kind === 'failed') return observation.release.reason;
  if (observation.advisories.kind === 'failed') return observation.advisories.reason;
  return null;
}

function emptyResult(): UpstreamObservationResult {
  return {
    observedAt: new Date().toISOString(),
    entries: 0,
    releases: 0,
    advisories: 0,
    skipped: 0,
    failed: 0,
    instancesUpdated: 0,
  };
}
