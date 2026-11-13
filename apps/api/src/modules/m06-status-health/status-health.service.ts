import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ContainerStatus, InstanceStatus, JobLogLine } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { AppError } from '../../common/problem/app-error';
import { isUuid } from '../../common/http/uuid';
import { maskText } from '../../common/logging/masking';
import { DockerEngineClient } from '../../common/docker/docker.client';
import { instanceNetwork } from '../../common/docker/naming';
import { describeProbe, probeProductHttp } from '../../common/exec/http-probe';
import type { SampleSummary, StatusHealthService } from './status-health.contract';

/** Transitional states render as "provisioning" rather than as an outage (FR-3.7). */
const TRANSITIONAL = new Set([
  'requested',
  'validating',
  'resolving',
  'building',
  'rendering',
  'planned',
  'deploying',
  'integrating',
  'verifying',
  'starting',
  'stopping',
  'restarting',
  'upgrading',
  'rolling_back',
  'deleting',
]);

type InstanceRow = {
  id: string;
  slug: string;
  state: string;
  payload: Record<string, unknown>;
};

/**
 * 4B.1 / 4B.2 — the sampler and the status read model.
 *
 * One Docker call per cycle for the whole fleet (containers filtered on the `seamnex.instance` label),
 * then a bounded fan-out over instances. That shape matters at 20 instances: N container lists would
 * be 20 round trips before the first probe even starts.
 *
 * The HTTP probe runs from a one-shot container on the instance network. An in-process fetch cannot
 * reach a bridge network the API is not attached to, and publishing a port is exactly what the
 * compose policy forbids — so the probe travels the same path a browser would.
 */
@Injectable()
export class PostgresStatusHealthService implements StatusHealthService {
  private readonly logger = new Logger('m06-status-health');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
  ) {}

  async status(instanceId: string, refresh: boolean): Promise<InstanceStatus> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    if (refresh)
      await this.sample(instanceId).catch((error: unknown) => {
        this.logger.warn(`on-demand sample failed for ${instanceId}: ${String(error)}`);
      });

    const result = await this.pool.query<{
      state: string;
      ready: boolean;
      observed_at: Date;
      source: string;
      reason: string | null;
      containers_total: number;
      containers_running: number;
      maintenance_title: string | null;
      maintenance_id: string | null;
      maintenance_start: Date | null;
      maintenance_end: Date | null;
    }>(
      `SELECT s.state, s.ready, s.observed_at, s.source, s.reason,
              COALESCE((SELECT count(*) FROM container_status c WHERE c.instance_id = s.instance_id), 0)::int AS containers_total,
              COALESCE((SELECT count(*) FROM container_status c WHERE c.instance_id = s.instance_id AND c.state = 'running'), 0)::int AS containers_running,
              (SELECT m.scope FROM maintenance_window m
                WHERE m.instance_id = s.instance_id AND m.cancelled_at IS NULL
                  AND now() BETWEEN m.starts_at AND m.ends_at
                ORDER BY m.starts_at DESC LIMIT 1) AS maintenance_title,
              (SELECT m.id FROM maintenance_window m
                WHERE m.instance_id = s.instance_id AND m.cancelled_at IS NULL
                  AND now() BETWEEN m.starts_at AND m.ends_at
                ORDER BY m.starts_at DESC LIMIT 1) AS maintenance_id,
              (SELECT m.starts_at FROM maintenance_window m
                WHERE m.instance_id = s.instance_id AND m.cancelled_at IS NULL
                  AND now() BETWEEN m.starts_at AND m.ends_at
                ORDER BY m.starts_at DESC LIMIT 1) AS maintenance_start,
              (SELECT m.ends_at FROM maintenance_window m
                WHERE m.instance_id = s.instance_id AND m.cancelled_at IS NULL
                  AND now() BETWEEN m.starts_at AND m.ends_at
                ORDER BY m.starts_at DESC LIMIT 1) AS maintenance_end
         FROM instance_status s WHERE s.instance_id = $1`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      const exists = await this.pool.query(
        `SELECT 1 FROM instance WHERE id = $1 AND deleted_at IS NULL`,
        [instanceId],
      );
      if (exists.rowCount === 0) throw notFound(instanceId);
      // A sample is attempted above; if the daemon is unreachable there is still nothing to report.
      throw new AppError({
        code: 'NOT_FOUND',
        detail: 'No status sample has been recorded for this instance yet.',
        remediation:
          'Check that the status sampler is running and the Docker socket proxy is reachable.',
      });
    }

    const maintenance =
      row.maintenance_title === null ||
      row.maintenance_start === null ||
      row.maintenance_end === null
        ? null
        : {
            active: true,
            windowId: row.maintenance_id,
            title: row.maintenance_title,
            startsAt: row.maintenance_start.toISOString(),
            endsAt: row.maintenance_end.toISOString(),
          };

    return {
      instanceId,
      state: row.state as InstanceStatus['state'],
      plainStatus: plainStatus(row.state, row.ready, maintenance !== null),
      ready: row.ready,
      reason: row.reason,
      observedAt: row.observed_at.toISOString(),
      source: row.source as InstanceStatus['source'],
      containersRunning: row.containers_running,
      containersTotal: row.containers_total,
      maintenance,
    };
  }

  async containers(instanceId: string): Promise<ContainerStatus[]> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const result = await this.pool.query<{
      container_id: string;
      service: string;
      role: string | null;
      state: string;
      health: string;
      restart_count: number;
      started_at: Date | null;
      exit_code: number | null;
      exit_reason: string | null;
      image_digest: string | null;
      observed_at: Date;
    }>(
      `SELECT c.container_id, c.service, s.role, c.state, c.health, c.restart_count, c.started_at,
              c.exit_code, c.exit_reason, c.image_digest, c.observed_at
         FROM container_status c
         LEFT JOIN instance_service s ON s.instance_id = c.instance_id AND s.service_name = c.service
        WHERE c.instance_id = $1
        ORDER BY c.service`,
      [instanceId],
    );
    return result.rows.map((row) => ({
      containerId: row.container_id,
      service: row.service,
      role: (row.role ?? 'primary') as ContainerStatus['role'],
      state: row.state as ContainerStatus['state'],
      health: row.health as ContainerStatus['health'],
      restartCount: row.restart_count,
      startedAt: row.started_at?.toISOString() ?? null,
      exitCode: row.exit_code,
      exitReason: row.exit_reason,
      imageDigest: row.image_digest ?? 'sha256:unknown',
      observedAt: row.observed_at.toISOString(),
    }));
  }

  /** FR-1.34 / AC-29: logs without shell access, and masked before they leave the process. */
  async containerLogs(
    instanceId: string,
    containerId: string,
    tail: number,
  ): Promise<JobLogLine[]> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const owned = await this.pool.query<{ container_id: string }>(
      `SELECT container_id FROM container_status WHERE instance_id = $1 AND container_id = $2`,
      [instanceId, containerId],
    );
    if (owned.rowCount === 0) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `Container ${containerId} does not belong to instance ${instanceId}.`,
        remediation: 'Refresh the container list; the container may have been recreated.',
      });
    }

    const raw = await this.docker.logs(containerId, Math.min(Math.max(tail, 1), 1_000));
    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    const now = Date.now();
    return lines.map((line, index) => ({
      seq: index + 1,
      // The endpoint has no per-line timestamp, so the line's position stands in for its time; the
      // UI renders the drawer in order, and a fabricated millisecond would be worse than a relative one.
      ts: new Date(now - (lines.length - index) * 1000).toISOString(),
      stream: 'stdout' as const,
      line: maskText(line),
    }));
  }

  async sample(instanceId?: string): Promise<SampleSummary> {
    const instances = await this.pool.query<InstanceRow>(
      `SELECT id, slug, state, payload FROM instance
        WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id = $1::uuid)
        ORDER BY created_at`,
      [instanceId ?? null],
    );

    // One Docker call for the whole fleet, then a bounded fan-out. The label filter is `seamnex.instance`
    // with no value: every container the platform created carries it.
    const containers = await this.docker
      .containers(['seamnex.instance'], true)
      .catch((error: unknown) => {
        this.logger.warn(`container list failed: ${String(error)}`);
        return [];
      });
    const byInstance = new Map<string, typeof containers>();
    for (const container of containers) {
      const owner = container.labels['seamnex.instance'];
      if (owner === undefined) continue;
      const list = byInstance.get(owner) ?? [];
      list.push(container);
      byInstance.set(owner, list);
    }

    let ready = 0;
    let degraded = 0;
    await mapWithConcurrency(
      instances.rows,
      this.config.SEAMNEX_SAMPLE_CONCURRENCY,
      async (instance) => {
        const observed = byInstance.get(instance.id) ?? [];
        const httpReady = await this.probe(instance, observed);
        const derived = derive(instance.state, observed, httpReady);
        await this.persist(instance, observed, derived, httpReady);
        if (derived.ready) ready += 1;
        else if (derived.state === 'degraded') degraded += 1;
      },
    );

    return { instances: instances.rows.length, ready, degraded };
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * HTTP readiness. Returns `null` when it could not be attempted (no containers, or the probe image
   * is unavailable) — the caller must not read `null` as success.
   */
  private async probe(
    instance: InstanceRow,
    containers: readonly { id: string; state: string }[],
  ): Promise<boolean | null> {
    if (containers.length === 0) return null;
    if (containers.some((container) => container.state !== 'running')) return null;

    const port = typeof instance.payload.httpPort === 'number' ? instance.payload.httpPort : 80;
    const target = `http://${instance.slug}:${port}/`;
    const timeoutMs = this.config.SEAMNEX_SAMPLE_TIMEOUT_MS;
    try {
      const result = await Promise.race([
        probeProductHttp({
          runCli: (file, args, limit) => this.docker.runCli(file, args, limit),
          network: instanceNetwork(instance.slug),
          host: instance.slug,
          port,
          timeoutMs: timeoutMs + 1_000,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      const ok = result?.ok === true;
      await this.pool.query(
        `INSERT INTO probe_result (instance_id, kind, ok, latency_ms, detail)
         VALUES ($1, 'http', $2, $3, $4::jsonb)`,
        [
          instance.id,
          ok,
          timeoutMs,
          JSON.stringify({
            target,
            method: 'ephemeral-container',
            // The status line is evidence: "302 Found" and "no HTTP answer" are different facts, and
            // the sampler used to record neither.
            answer: result === null ? 'timed out' : describeProbe(result),
          }),
        ],
      );
      return ok;
    } catch (error) {
      this.logger.debug(`probe failed for ${instance.slug}: ${String(error)}`);
      return false;
    }
  }

  private async persist(
    instance: InstanceRow,
    containers: readonly {
      id: string;
      service: string;
      state: string;
      status: string;
      image: string;
      labels: Record<string, string>;
    }[],
    derived: Derived,
    httpReady: boolean | null,
  ): Promise<void> {
    /**
     * A recreated container keeps its service name and gets a new id, so the row for the container it
     * replaced is never matched again by the upsert below. The rows accumulated: after one
     * reconfigure the Containers tab listed 18 entries for 9 services and the header claimed
     * "18 / 18 running", which counts ghosts as evidence of health.
     *
     * The prune is skipped when nothing was observed, because an empty list is also what a failed
     * Docker listing looks like — and deleting every row on a transient daemon error would replace
     * a cosmetic defect with a false outage.
     */
    if (containers.length > 0) {
      await this.pool.query(
        `DELETE FROM container_status
          WHERE instance_id = $1 AND NOT (container_id = ANY($2::text[]))`,
        [instance.id, containers.map((container) => container.id)],
      );
    }

    for (const container of containers) {
      const inspect = await this.docker.inspect(container.id).catch(() => null);
      const state = (inspect?.State?.Status ?? container.state) as ContainerStatus['state'];
      const health = healthOf(inspect);
      await this.pool.query(
        `INSERT INTO container_status
           (instance_id, container_id, service, state, health, restart_count, started_at, exit_code, exit_reason, image_digest, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (instance_id, container_id) DO UPDATE
            SET state = EXCLUDED.state, health = EXCLUDED.health, restart_count = EXCLUDED.restart_count,
                started_at = EXCLUDED.started_at, exit_code = EXCLUDED.exit_code,
                exit_reason = EXCLUDED.exit_reason, image_digest = EXCLUDED.image_digest, observed_at = now()`,
        [
          instance.id,
          container.id,
          container.service,
          state,
          health,
          inspect?.RestartCount ?? 0,
          inspect?.State?.StartedAt ?? null,
          inspect?.State?.ExitCode ?? null,
          inspect?.State?.Error ?? null,
          inspect?.Image ?? null,
        ],
      );
      await this.pool.query(
        `INSERT INTO probe_result (instance_id, kind, ok, latency_ms, detail)
         VALUES ($1, 'container', $2, NULL, $3::jsonb)`,
        [
          instance.id,
          state === 'running',
          JSON.stringify({ containerId: container.id, service: container.service }),
        ],
      );
    }

    await this.pool.query(
      `INSERT INTO instance_status (instance_id, state, ready, observed_at, source, reason)
       VALUES ($1, $2, $3, now(), 'poll', $4)
       ON CONFLICT (instance_id) DO UPDATE
          SET state = EXCLUDED.state, ready = EXCLUDED.ready, observed_at = now(),
              source = 'poll', reason = EXCLUDED.reason`,
      [instance.id, derived.state, derived.ready, derived.reason],
    );
    // The instance's own state follows the observed one unless it is mid-transition: a job owns the
    // state then, and overwriting it would make a deploy look finished before it is.
    if (!TRANSITIONAL.has(instance.state)) {
      await this.pool.query(
        `UPDATE instance SET state = $2, updated_at = now() WHERE id = $1 AND state <> 'deleted'`,
        [instance.id, derived.state],
      );
    }
    this.logger.debug(
      { instanceId: instance.id, httpReady, state: derived.state },
      'sample recorded',
    );
  }
}

type Derived = { state: InstanceStatus['state']; ready: boolean; reason: string | null };

/** FR-1.32: `ready` requires running **and** an HTTP answer. */
export function derive(
  previous: string,
  containers: readonly { state: string }[],
  httpReady: boolean | null,
): Derived {
  if (TRANSITIONAL.has(previous)) {
    return {
      state: previous as InstanceStatus['state'],
      ready: false,
      reason: 'transition in progress',
    };
  }
  if (containers.length === 0) {
    return {
      state: previous === 'stopped' ? 'stopped' : 'failed',
      ready: false,
      reason: 'no containers',
    };
  }
  const running = containers.filter((container) => container.state === 'running').length;
  /**
   * A deliberate stop is a state, not a fault. Deriving `degraded` from "nothing is running" erased
   * it within one sample, and `lifecycleAvailability` only offers `start` from `stopped`: the
   * operator's Stop turned into an instance that the console could not start again.
   */
  if (previous === 'stopped' && running === 0) {
    return { state: 'stopped', ready: false, reason: 'stopped; containers are not running' };
  }
  const notRunning = containers.length - running;
  if (notRunning > 0) {
    return {
      state: 'degraded',
      ready: false,
      reason: `${notRunning} of ${containers.length} container(s) not running`,
    };
  }
  if (httpReady === true) return { state: 'ready', ready: true, reason: null };
  if (httpReady === false) {
    return { state: 'degraded', ready: false, reason: 'HTTP readiness probe failed' };
  }
  return { state: 'degraded', ready: false, reason: 'HTTP readiness was not probed' };
}

function healthOf(inspect: unknown): ContainerStatus['health'] {
  const status = (inspect as { State?: { Health?: { Status?: string } } } | null)?.State?.Health
    ?.Status;
  if (status === 'healthy' || status === 'unhealthy' || status === 'starting') return status;
  return 'none';
}

function plainStatus(
  state: string,
  ready: boolean,
  maintenance: boolean,
): InstanceStatus['plainStatus'] {
  if (maintenance) return 'maintenance';
  if (TRANSITIONAL.has(state)) return 'unavailable';
  if (ready) return 'available';
  return state === 'degraded' ? 'degraded' : 'unavailable';
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

function notFound(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No instance ${id}.`,
    remediation: 'Refresh the instance list.',
  });
}
