import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  InstanceLogs,
  ObservabilityProfile,
  ObservabilityReport,
  ObservabilityRule,
} from '@seamnex/domain';
import { ObservabilityProfileSchema } from '@seamnex/domain';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { maskText } from '../../common/logging/masking';
import { INSTANCE_METRICS, renderExposition } from './observability.exposition';
import {
  publishedTargetIds,
  removeTarget,
  targetFileName,
  targetIsPublished,
  targetWrittenAt,
  writeTarget,
} from './observability.writer';
import type { ObservabilityService } from './observability.contract';

type InstanceRow = {
  id: string;
  slug: string;
  entry_key: string;
  product: string | null;
  state: string;
  resources: { cpu?: number; memoryMb?: number; diskMb?: number } | null;
};

type SampleRow = {
  sampled_at: Date;
  cpu_milli: number;
  memory_mb: number;
  disk_mb: number;
  containers: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * M21 — the observability fabric (FR-2.6, AC-45, FR-4.6).
 *
 * Three jobs, and the boundaries between them matter:
 *
 *   - **a profile is an artefact.** `observability_profile` had a table and no writer, so "the entry
 *     declares dashboards and rules" was a claim with nothing behind it. `profile()` derives the
 *     baseline from the catalogue entry once and persists it; a later read returns what was stored,
 *     which is what makes the console able to say *what the platform believes* rather than what it
 *     would compute today.
 *   - **a scrape target is generated, not hand-written.** `reconcile()` is the only writer of the
 *     `file_sd` directory, and it removes targets whose instance no longer exists, so a deleted
 *     instance cannot leave Prometheus scraping a 404.
 *   - **a log query is a platform path.** Before this, "queryable per instance" meant an operator
 *     opening Grafana by hand. The API proxies Loki with a UUID-validated selector and masks every
 *     line before it leaves the process, because a log line is where a secret ends up by accident.
 */
@Injectable()
export class PostgresObservabilityService implements ObservabilityService {
  private readonly logger = new Logger('m21-observability');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The persisted profile for an entry, derived and written on first use.
   *
   * A stored row that no longer parses is repaired rather than served: an operator editing the
   * catalogue must not end up with a screen that silently shows nothing.
   */
  async profile(entryKey: string): Promise<ObservabilityProfile> {
    const stored = await this.pool.query<{ dashboards: unknown; rules: unknown }>(
      `SELECT dashboards, rules FROM observability_profile WHERE entry_key = $1`,
      [entryKey],
    );
    const row = stored.rows[0];
    if (row !== undefined) {
      const parsed = ObservabilityProfileSchema.safeParse({
        dashboards: row.dashboards,
        rules: row.rules,
      });
      if (parsed.success) return parsed.data;
      this.logger.warn(
        { entryKey },
        'stored observability profile is not readable; regenerating the baseline',
      );
    }

    const derived = await this.deriveProfile(entryKey);
    await this.pool.query(
      `INSERT INTO observability_profile (entry_key, dashboards, rules)
       VALUES ($1, $2::jsonb, $3::jsonb)
       ON CONFLICT (entry_key) DO UPDATE
         SET dashboards = EXCLUDED.dashboards,
             rules = EXCLUDED.rules,
             updated_at = now()`,
      [entryKey, JSON.stringify(derived.dashboards), JSON.stringify(derived.rules)],
    );
    return derived;
  }

  /** Publishes this instance's scrape target. A no-op when no targets directory is configured. */
  async materialise(instanceId: string): Promise<void> {
    const instance = await this.instance(instanceId);
    await this.profile(instance.entry_key);
    await this.publish(instance);
  }

  /**
   * The periodic pass: one target per live instance, and no target for an instance that is gone.
   *
   * Called from the scheduler role, which is the only process that runs repeatable platform work.
   * The pass is idempotent — `writeTarget` skips unchanged content — so a slow cycle costs reads,
   * not rewrites.
   */
  async reconcile(): Promise<{ written: number; removed: number }> {
    const directory = this.config.SEAMNEX_PROMETHEUS_TARGETS_DIR;
    if (directory.length === 0) return { written: 0, removed: 0 };

    const live = await this.pool.query<InstanceRow>(
      `SELECT i.id, i.slug, i.entry_key, coalesce(i.payload->>'product', e.product) AS product,
              i.state, i.payload->'resources' AS resources
         FROM instance i
         LEFT JOIN catalog_entry e ON e.key = i.entry_key
        WHERE i.deleted_at IS NULL
        ORDER BY i.created_at`,
    );

    let written = 0;
    for (const row of live.rows) {
      await this.profile(row.entry_key);
      const result = await this.publish(row);
      if (result) written += 1;
    }

    const liveIds = new Set(live.rows.map((row) => row.id));
    let removed = 0;
    for (const instanceId of await publishedTargetIds(directory)) {
      if (liveIds.has(instanceId)) continue;
      if (await removeTarget(directory, instanceId)) removed += 1;
    }
    if (removed > 0)
      this.logger.log({ removed }, 'removed scrape targets for instances that no longer exist');
    return { written, removed };
  }

  async report(instanceId: string): Promise<ObservabilityReport> {
    const instance = await this.instance(instanceId);
    const profile = await this.profile(instance.entry_key);
    const directory = this.config.SEAMNEX_PROMETHEUS_TARGETS_DIR;
    const metricsPath = this.metricsPath(instanceId);

    const labels = {
      job: 'seamnex-instance',
      instance_id: instance.id,
      instance_slug: instance.slug,
      entry_key: instance.entry_key,
      product: instance.product ?? instance.entry_key,
    };

    if (directory.length === 0) {
      return {
        instanceId: instance.id,
        entryKey: instance.entry_key,
        product: instance.product ?? instance.entry_key,
        slug: instance.slug,
        profile,
        target: {
          state: 'not_configured',
          metricsPath,
          address: this.config.SEAMNEX_PROMETHEUS_SCRAPE_TARGET,
          labels,
          file: null,
          detail:
            'No scrape-targets directory is configured, so the observability stack cannot see this instance.',
          generatedAt: null,
        },
        logs: this.logAccess(),
        generatedAt: new Date().toISOString(),
      };
    }

    const published = await targetIsPublished(directory, instance.id);
    const writtenAt = published ? await targetWrittenAt(directory, instance.id) : null;
    return {
      instanceId: instance.id,
      entryKey: instance.entry_key,
      product: instance.product ?? instance.entry_key,
      slug: instance.slug,
      profile,
      target: {
        state: published ? 'published' : 'missing',
        metricsPath,
        address: this.config.SEAMNEX_PROMETHEUS_SCRAPE_TARGET,
        labels,
        file: targetFileName(instance.id),
        detail: published
          ? 'The target file exists; Prometheus scrapes it on its next cycle.'
          : 'No target file yet — the scheduler publishes one on its next pass.',
        generatedAt: writtenAt?.toISOString() ?? null,
      },
      logs: this.logAccess(),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * FR-4.6 / AC-45 — one instance's logs through the platform, not through Grafana.
   *
   * The selector is built from a validated UUID, never from caller text. The caller's filter is
   * length-capped and applied as a **line filter** (`|=`, literal contains), so it cannot widen the
   * selector or escape into PromQL/LogQL syntax. Every returned line is masked.
   */
  async logs(
    instanceId: string,
    query: { sinceMinutes: number; limit: number; filter?: string },
  ): Promise<InstanceLogs> {
    const instance = await this.instance(instanceId);
    const retentionDays = this.config.SEAMNEX_OBSERVABILITY_RETENTION_DAYS;
    const loki = this.config.SEAMNEX_LOKI_URL;
    if (loki.length === 0) {
      return {
        instanceId: instance.id,
        source: 'none',
        lines: [],
        retentionDays,
        truncated: false,
        detail:
          'The log store is not configured, so no per-instance history is queryable. Container logs are still readable from the Containers tab (live Docker stream).',
      };
    }

    const sinceMinutes = clamp(query.sinceMinutes, 1, this.config.SEAMNEX_LOG_QUERY_MAX_MINUTES);
    const limit = clamp(query.limit, 1, this.config.SEAMNEX_LOG_QUERY_MAX_LINES);
    const selector = `{instance="${instance.id}"}${lineFilter(query.filter)}`;

    const end = Date.now();
    const start = end - sinceMinutes * 60_000;
    const params = new URLSearchParams({
      query: selector,
      start: `${start}000000`,
      end: `${end}000000`,
      limit: String(limit),
      direction: 'backward',
    });

    let payload: unknown;
    try {
      const response = await fetch(`${loki}/loki/api/v1/query_range?${params.toString()}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`log store answered ${response.status}`);
      payload = await response.json();
    } catch (error) {
      this.logger.warn(
        `log query for ${instance.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new AppError({
        code: 'UNAVAILABLE',
        status: 503,
        detail: 'The log store did not answer the query.',
        remediation:
          'Retry once the observability stack is healthy; the live container log is unaffected.',
      });
    }

    const lines = parseLokiStreams(payload).slice(-limit);
    return {
      instanceId: instance.id,
      source: 'loki',
      lines,
      retentionDays,
      truncated: lines.length >= limit,
      detail: `Masked lines from the platform log store, newest ${lines.length} of the last ${sinceMinutes} minutes.`,
    };
  }

  /** Prometheus text exposition for one instance, rendered from the newest sample. */
  async exposition(instanceId: string): Promise<string> {
    const result = await this.pool.query<
      InstanceRow & {
        sample_at: Date | null;
        sample_cpu: number | null;
        sample_memory: number | null;
        sample_disk: number | null;
      }
    >(
      `SELECT i.id, i.slug, i.entry_key, coalesce(i.payload->>'product', e.product) AS product,
              i.state, i.payload->'resources' AS resources,
              s.sampled_at AS sample_at, s.cpu_milli AS sample_cpu,
              s.memory_mb AS sample_memory, s.disk_mb AS sample_disk
         FROM instance i
         LEFT JOIN catalog_entry e ON e.key = i.entry_key
         LEFT JOIN LATERAL (
           SELECT u.sampled_at, u.cpu_milli, u.memory_mb, u.disk_mb
             FROM instance_usage_sample u
            WHERE u.instance_id = i.id
            ORDER BY u.sampled_at DESC
            LIMIT 1
         ) s ON true
        WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound(instanceId);

    const sample: SampleRow | null =
      row.sample_at === null
        ? null
        : {
            sampled_at: row.sample_at,
            cpu_milli: row.sample_cpu ?? 0,
            memory_mb: row.sample_memory ?? 0,
            disk_mb: row.sample_disk ?? 0,
            containers: 0,
          };
    return renderExposition({
      instanceId: row.id,
      slug: row.slug,
      entryKey: row.entry_key,
      product: row.product ?? row.entry_key,
      up: row.state === 'ready',
      limits: {
        cpuMilli: (row.resources?.cpu ?? 0) * 1000,
        memoryMb: row.resources?.memoryMb ?? 0,
        diskQuotaMb: row.resources?.diskMb ?? 0,
      },
      usage:
        sample === null
          ? null
          : {
              cpuMilli: sample.cpu_milli,
              memoryMb: sample.memory_mb,
              diskMb: sample.disk_mb,
              ageSeconds: Math.max(0, (Date.now() - new Date(sample.sampled_at).getTime()) / 1000),
            },
    });
  }

  // ---------------------------------------------------------------------------------------------

  /** The API path Prometheus is told to scrape. Kept in one place: the file and the report agree. */
  metricsPath(instanceId: string): string {
    return `/api/v1/metrics/instances/${instanceId}`;
  }

  private async publish(instance: InstanceRow): Promise<boolean> {
    const directory = this.config.SEAMNEX_PROMETHEUS_TARGETS_DIR;
    if (directory.length === 0) return false;
    const result = await writeTarget(directory, {
      instanceId: instance.id,
      slug: instance.slug,
      entryKey: instance.entry_key,
      product: instance.product ?? instance.entry_key,
      address: this.config.SEAMNEX_PROMETHEUS_SCRAPE_TARGET,
      metricsPath: this.metricsPath(instance.id),
    });
    return result.changed;
  }

  private async instance(instanceId: string): Promise<InstanceRow> {
    if (!UUID_PATTERN.test(instanceId)) throw notFound(instanceId);
    const result = await this.pool.query<InstanceRow>(
      `SELECT i.id, i.slug, i.entry_key, coalesce(i.payload->>'product', e.product) AS product,
              i.state, i.payload->'resources' AS resources
         FROM instance i
         LEFT JOIN catalog_entry e ON e.key = i.entry_key
        WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound(instanceId);
    return row;
  }

  /**
   * The entry's declared profile, or the documented baseline.
   *
   * The baseline names the four series the platform actually emits for every instance. A rule that
   * cited a metric nothing writes would be worse than no rule, which is why the names come from
   * `INSTANCE_METRICS` rather than from a string literal here.
   */
  private async deriveProfile(entryKey: string): Promise<ObservabilityProfile> {
    const result = await this.pool.query<{ product: string | null; declared: unknown }>(
      `SELECT product, payload->'observability' AS declared FROM catalog_entry WHERE key = $1`,
      [entryKey],
    );
    const row = result.rows[0];
    const declared = ObservabilityProfileSchema.safeParse(row?.declared);
    if (declared.success) return declared.data;

    const product = row?.product ?? entryKey;
    const selector = `{entry_key="${entryKey}"}`;
    const rules: ObservabilityRule[] = [
      {
        name: `${product} is down`,
        expression: `${INSTANCE_METRICS.up}${selector} == 0`,
        severity: 'critical',
        for: '5m',
      },
      {
        name: `${product} memory pressure`,
        expression: `${INSTANCE_METRICS.memoryMb}${selector} / clamp_min(${INSTANCE_METRICS.memoryLimitMb}${selector}, 1) >= 0.9`,
        severity: 'warning',
        for: '10m',
      },
      {
        name: `${product} volume filling`,
        expression: `${INSTANCE_METRICS.diskMb}${selector} / clamp_min(${INSTANCE_METRICS.diskQuotaMb}${selector}, 1) >= 0.85`,
        severity: 'warning',
        for: '15m',
      },
    ];
    return {
      dashboards: [
        {
          uid: 'instance-overview',
          title: `${product} — instance overview`,
          panels: ['Availability', 'Container CPU', 'Container memory', 'Volume disk usage'],
        },
      ],
      rules,
    };
  }

  private logAccess(): ObservabilityReport['logs'] {
    const retentionDays = this.config.SEAMNEX_OBSERVABILITY_RETENTION_DAYS;
    if (this.config.SEAMNEX_LOKI_URL.length === 0) {
      return {
        available: false,
        source: 'none',
        retentionDays,
        detail: 'The log store is not configured; only the live container stream is available.',
      };
    }
    return {
      available: true,
      source: 'loki',
      retentionDays,
      detail: `Queryable per instance through the platform for ${retentionDays} days.`,
    };
  }
}

function notFound(instanceId: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No instance ${instanceId}.`,
    remediation: 'Reload the instance list; the instance may have been deleted.',
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * A caller's search text as a LogQL line filter.
 *
 * `|=` is a literal substring match, so the worst a value can do is match nothing. Quotes and
 * backslashes are escaped because they would otherwise terminate the string early.
 */
function lineFilter(filter: string | undefined): string {
  const value = filter?.trim().slice(0, 200) ?? '';
  if (value.length === 0) return '';
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return ` |= "${escaped}"`;
}

type LokiEntry = {
  ts: string;
  line: string;
  stream: 'stdout' | 'stderr';
  container: string | null;
};

/** Loki's `streams` result → chronological lines. Unknown shapes are skipped, not guessed at. */
function parseLokiStreams(payload: unknown): LokiEntry[] {
  const streams = readPath(payload, ['data', 'result']);
  if (!Array.isArray(streams)) return [];

  const entries: LokiEntry[] = [];
  for (const stream of streams) {
    const values = readPath(stream, ['values']);
    if (!Array.isArray(values)) continue;
    const container = stringOrNull(readPath(stream, ['stream', 'container']));
    const kind = stringOrNull(readPath(stream, ['stream', 'stream']));
    for (const value of values) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const nanos = String(value[0]);
      const line = String(value[1] ?? '');
      // Loki stamps nanoseconds; JS dates are milliseconds, so the first 13 digits are the instant.
      const millis = Number(nanos.slice(0, 13));
      if (!Number.isFinite(millis)) continue;
      entries.push({
        ts: new Date(millis).toISOString(),
        line: maskText(line),
        // The collector writes the Docker stream as a label; guessing from the line's text would
        // mislabel every message that merely mentions "stderr".
        stream: kind === 'stderr' ? 'stderr' : 'stdout',
        container,
      });
    }
  }
  return entries.sort((left, right) => left.ts.localeCompare(right.ts));
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
