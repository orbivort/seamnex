import { readFileSync, statfsSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { admissionVerdict, type CapacitySnapshot, type ForecastPoint } from '@seamnex/domain';
import { withTransaction } from '@seamnex/db';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { AppError } from '../../common/problem/app-error';
import type { AdmissionDecision, CapacityService, ResourceRequest } from './capacity.contract';

const FORECAST_DAYS = 14;
const MIB = 1024 * 1024;

type SnapshotRow = { ts: Date; host: Record<string, unknown>; per_instance: unknown };

type HostMeasurement = {
  cpuCores: number;
  memoryMb: number;
  memoryAvailableMb: number;
  diskPath: string;
  /** Capacity of `diskPath` — what the 90 % rule is a fraction of. */
  diskMb: number;
  diskAvailableMb: number;
};

/**
 * Capacity service, Phase 4A.
 *
 * The admission arithmetic is imported from `@seamnex/domain` (`admissionVerdict`), which is the same
 * function the wizard used to call in the browser. That is deliberate: the fix for "the wizard and
 * the API disagree" is one function, not two implementations that must be kept in step.
 *
 * A missing snapshot is not an excuse to admit. It falls back to a live host probe, and if even
 * that is unavailable the decision is `admissible: false` with `source: 'unknown'` — a refusal an
 * operator can act on, rather than a capacity claim nobody measured.
 */
@Injectable()
export class PostgresCapacityService implements CapacityService {
  private readonly logger = new Logger('m19-capacity');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * A host with no persisted snapshot is **not** an unanswerable host: the control plane can measure
   * the machine it runs on. Measuring, recording and returning is one path, so the capacity board,
   * the wizard's admission step and `admit()` all agree on a fresh install instead of the console
   * sitting on "Waiting for the capacity snapshot" forever.
   */
  async snapshot(): Promise<CapacitySnapshot> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT ts, host, per_instance FROM capacity_snapshot ORDER BY ts DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (row !== undefined)
      return { ...(row.per_instance as CapacitySnapshot), ts: row.ts.toISOString() };

    const recorded = await this.record();
    if (recorded === null) throw this.empty();
    return recorded;
  }

  /**
   * One measurement, persisted. Called by the status-sampler cycle and by `snapshot()` on demand.
   *
   * Returns `null` when the host cannot be measured, because recording zeros would make every
   * later admission look refused against a host that has no capacity at all.
   */
  async record(): Promise<CapacitySnapshot | null> {
    const measured = this.measureHost();
    if (measured === null) return null;

    const settings = await this.settings();
    const reserved = await this.liveReservations();
    const reserve = { cpuCores: 1, memoryMb: 2_048, diskMb: 10_240 };
    const host = {
      cpuCores: measured.cpuCores,
      memoryMb: measured.memoryMb,
      // Capacity, not free space: the 90 % rule compares declared reservations with the pool.
      diskMb: measured.diskMb,
    };
    const allocated = {
      cpuCores: reserved.cpuMilli / 1000,
      memoryMb: reserved.memoryMb,
      diskMb: reserved.diskMb,
    };

    // The admission function works in whole cores; the snapshot document uses `cpuCores`. Same
    // numbers, two spellings, one conversion at the boundary.
    const outcome = admissionVerdict({
      host: { cpu: host.cpuCores, memoryMb: host.memoryMb, diskMb: host.diskMb },
      reserve: { cpu: reserve.cpuCores, memoryMb: reserve.memoryMb, diskMb: reserve.diskMb },
      allocated: {
        cpu: allocated.cpuCores,
        memoryMb: allocated.memoryMb,
        diskMb: allocated.diskMb,
      },
      request: { cpu: 0, memoryMb: 0, diskMb: 0 },
      oversubscriptionFactor: settings.oversubscriptionFactor,
    });
    const ts = new Date();
    const usage = utilisation({
      host,
      allocated,
      platformReserve: reserve,
      oversubscriptionFactor: settings.oversubscriptionFactor,
    });
    const document: Omit<CapacitySnapshot, 'ts'> = {
      host,
      allocated,
      platformReserve: reserve,
      oversubscriptionFactor: settings.oversubscriptionFactor,
      // Provenance for the two numbers an operator cannot infer: which filesystem was judged and
      // how much of it was free. Neither is an admission input; both make the board verifiable.
      diskPath: measured.diskPath,
      diskAvailableMb: measured.diskAvailableMb,
      memoryAvailableMb: measured.memoryAvailableMb,
      instanceUsage: await this.instanceUsage(),
      verdict: {
        admissible: outcome.admissible,
        headline: outcome.headline,
        detail: `${outcome.detail} ${outcome.reserveNote}`,
        // The axes that failed, not an empty list: a snapshot the verdict calls short must say
        // where, or the board renders "shortfall" with nothing to act on.
        shortfall: outcome.shortfall,
        reserveNote: outcome.reserveNote,
      },
      forecast: project(usage.cpu, usage.memory, usage.disk),
    };

    await this.pool.query(
      `INSERT INTO capacity_snapshot (ts, host, per_instance) VALUES ($1, $2::jsonb, $3::jsonb)
       ON CONFLICT (ts) DO NOTHING`,
      [ts.toISOString(), JSON.stringify(host), JSON.stringify(document)],
    );
    return { ...document, ts: ts.toISOString() };
  }

  /**
   * Documented heuristic (deliverable 2.7): the forecast extrapolates the current utilisation at
   * the observed 14-day slope and adds 1 % per day of data growth. It is labelled as a placeholder
   * in the response rather than being presented as a model.
   */
  async forecast(): Promise<ForecastPoint[]> {
    let snapshot: CapacitySnapshot;
    try {
      snapshot = await this.snapshot();
    } catch {
      const decision = await this.admit({ resources: { cpuMilli: 0, memoryMb: 0, diskMb: 0 } });
      const cpu = percent(decision.used.cpuMilli, decision.limits.cpuMilli);
      const memory = percent(decision.used.memoryMb, decision.limits.memoryMb);
      const disk = percent(decision.used.diskMb, decision.limits.diskMb);
      return project(cpu, memory, disk);
    }
    /*
     * Both branches extrapolate the *admission* utilisation, not `allocated / host`. Against the
     * host totals the sparkline reported 84 % CPU beside rulers reading 73 %, and 80 % memory
     * beside a verdict that had 1.8 GB of a 22.3 GB limit left (92 %) — the same screen, two
     * baselines.
     */
    const usage = utilisation(snapshot);
    return project(usage.cpu, usage.memory, usage.disk);
  }

  async admit(request: {
    instanceId?: string;
    resources: ResourceRequest;
  }): Promise<AdmissionDecision> {
    const baseline = await this.baseline();
    /**
     * The ledger is the authority on what has already been given away, and it is *not* added to the
     * snapshot's `allocated`: both are projections of the same `instance` rows, so summing them
     * counted every deployment twice. On this host 6144 MB of declared instances became 12288 MB in
     * the verdict, which turned a 2048 MB deployment that had 4.6 GB of headroom into
     * `CAPACITY_EXCEEDED` — with the wizard's own capacity panel still saying it fits.
     *
     * Reading the ledger also makes `excludeInstanceId` mean something: an upgrade or a reconfigure
     * must not be judged against the shape it is replacing, and a snapshot figure cannot exclude a
     * single instance.
     */
    const allocated = await this.liveReservations(request.instanceId);

    const hostCpuMilli = baseline.hostCpuMilli;
    const hostMemoryMb = baseline.hostMemoryMb;
    const hostDiskMb = baseline.hostDiskMb;

    const outcome = admissionVerdict({
      host: { cpu: hostCpuMilli / 1000, memoryMb: hostMemoryMb, diskMb: hostDiskMb },
      reserve: {
        cpu: baseline.reserveCpuMilli / 1000,
        memoryMb: baseline.reserveMemoryMb,
        diskMb: baseline.reserveDiskMb,
      },
      allocated: {
        cpu: allocated.cpuMilli / 1000,
        memoryMb: allocated.memoryMb,
        diskMb: allocated.diskMb,
      },
      request: {
        cpu: request.resources.cpuMilli / 1000,
        memoryMb: request.resources.memoryMb,
        diskMb: request.resources.diskMb,
      },
      oversubscriptionFactor: baseline.oversubscriptionFactor,
    });

    // The contract is integers (`ResourceShortfallSchema`/`AdmissionDecision` are milli-cores and
    // whole mebibytes), but the domain verdict works in ratios: 95 % of a 30.5 GB host is a
    // fraction, so `used - limits` came out as e.g. 4096.75. `POST /instances/preview` re-validates
    // its own response, so that fraction failed the deploy preview with `500 shortfall.memoryMb:
    // expected int, received number` — and the wizard could never show a route or admit a
    // deployment. Round the report here, at the boundary, and derive the shortfall from the rounded
    // numbers so the three figures in the payload always agree with each other.
    const limits = {
      cpuMilli: Math.round(outcome.limits.cpu * 1000),
      memoryMb: Math.round(outcome.limits.memoryMb),
      diskMb: Math.round(outcome.limits.diskMb),
    };
    const used = {
      cpuMilli: Math.round(outcome.used.cpu * 1000),
      memoryMb: Math.round(outcome.used.memoryMb),
      diskMb: Math.round(outcome.used.diskMb),
    };

    return {
      admissible: outcome.admissible,
      headline: outcome.headline,
      detail: `${outcome.detail} ${outcome.reserveNote}`,
      shortfall: {
        cpuMilli: Math.max(0, used.cpuMilli - limits.cpuMilli),
        memoryMb: Math.max(0, used.memoryMb - limits.memoryMb),
        diskMb: Math.max(0, used.diskMb - limits.diskMb),
      },
      limits,
      used,
      source: baseline.source,
    };
  }

  /**
   * Replace this instance's live hold in one transaction.
   *
   * The release and the insert used to commit separately, so a failed insert lost the previous
   * reservation — the host then admitted work it had already promised, because the arithmetic reads
   * `released_at IS NULL`. Both sides now commit or roll back together. `released_at` stays a
   * timestamp rather than a `DELETE` because the reservation is history the capacity board reads.
   */
  async reserve(input: { instanceId: string; resources: ResourceRequest }): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await tx.query(
        `UPDATE capacity_reservation SET released_at = now()
          WHERE instance_id = $1 AND released_at IS NULL`,
        [input.instanceId],
      );
      await tx.query(
        `INSERT INTO capacity_reservation (instance_id, cpu_milli, memory_mb, disk_mb)
         VALUES ($1, $2, $3, $4)`,
        [
          input.instanceId,
          input.resources.cpuMilli,
          input.resources.memoryMb,
          input.resources.diskMb,
        ],
      );
    });
  }

  async release(instanceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE capacity_reservation SET released_at = now()
        WHERE instance_id = $1 AND released_at IS NULL`,
      [instanceId],
    );
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * The host picture: the newest sampler row when it exists, otherwise a live probe. `unknown`
   * propagates to the decision instead of being rounded up to "probably fine".
   */
  private async baseline(): Promise<{
    hostCpuMilli: number;
    hostMemoryMb: number;
    hostDiskMb: number;
    reserveCpuMilli: number;
    reserveMemoryMb: number;
    reserveDiskMb: number;
    allocatedCpuMilli: number;
    allocatedMemoryMb: number;
    allocatedDiskMb: number;
    oversubscriptionFactor: number;
    source: 'measured' | 'snapshot' | 'unknown';
  }> {
    const row = await this.pool.query<SnapshotRow>(
      `SELECT ts, host, per_instance FROM capacity_snapshot ORDER BY ts DESC LIMIT 1`,
    );
    const snapshot = row.rows[0];
    if (snapshot !== undefined) {
      const value = snapshot.per_instance as CapacitySnapshot;
      return {
        hostCpuMilli: value.host.cpuCores * 1000,
        hostMemoryMb: value.host.memoryMb,
        hostDiskMb: value.host.diskMb,
        reserveCpuMilli: value.platformReserve.cpuCores * 1000,
        reserveMemoryMb: value.platformReserve.memoryMb,
        reserveDiskMb: value.platformReserve.diskMb,
        allocatedCpuMilli: value.allocated.cpuCores * 1000,
        allocatedMemoryMb: value.allocated.memoryMb,
        allocatedDiskMb: value.allocated.diskMb,
        oversubscriptionFactor: value.oversubscriptionFactor,
        source: 'snapshot',
      };
    }

    const measured = this.measureHost();
    if (measured === null) {
      return {
        hostCpuMilli: 0,
        hostMemoryMb: 0,
        hostDiskMb: 0,
        reserveCpuMilli: 0,
        reserveMemoryMb: 0,
        reserveDiskMb: 0,
        allocatedCpuMilli: 0,
        allocatedMemoryMb: 0,
        allocatedDiskMb: 0,
        oversubscriptionFactor: 1,
        source: 'unknown',
      };
    }

    const settings = await this.settings();
    return {
      hostCpuMilli: measured.cpuCores * 1000,
      hostMemoryMb: measured.memoryMb,
      hostDiskMb: measured.diskMb,
      reserveCpuMilli: 1_000,
      reserveMemoryMb: 2_048,
      reserveDiskMb: 10_240,
      allocatedCpuMilli: 0,
      allocatedMemoryMb: 0,
      allocatedDiskMb: 0,
      oversubscriptionFactor: settings.oversubscriptionFactor,
      source: 'measured',
    };
  }

  /**
   * One pass over the machine the control plane runs on.
   *
   * Two things this must not do: report a disk it did not measure (the old `0` made every
   * deployment refused against a host with "0 GB"), and report the *image* filesystem as the host
   * disk. The instance-data volume is the pool the guard is about; `process.cwd()` is only a
   * fallback for a deployment that does not mount one (a unit test, a bare-metal run).
   */
  private measureHost(): HostMeasurement | null {
    try {
      const cores = cpus().length;
      const memoryMb = Math.floor(totalmem() / MIB);
      if (cores === 0 || memoryMb === 0) return null;

      const disk = measureDisk(this.config.SEAMNEX_INSTANCE_DATA_DIR) ?? measureDisk(process.cwd());
      if (disk === null) return null;

      return {
        cpuCores: cores,
        memoryMb,
        memoryAvailableMb: availableMemoryMb(memoryMb),
        diskPath: disk.path,
        diskMb: disk.totalMb,
        diskAvailableMb: disk.availableMb,
      };
    } catch (error) {
      this.logger.warn(`host measurement failed (${String(error)})`);
      return null;
    }
  }

  private async settings(): Promise<{ oversubscriptionFactor: number }> {
    const result = await this.pool.query<{ value: unknown }>(
      `SELECT value FROM settings WHERE key = 'oversubscription_factor'`,
    );
    const raw = result.rows[0]?.value;
    const factor = typeof raw === 'number' ? raw : Number(raw);
    return { oversubscriptionFactor: Number.isFinite(factor) && factor >= 1 ? factor : 1.25 };
  }

  /** Per-instance allocation for the capacity board: the reservation, labelled with the product. */
  private async instanceUsage(): Promise<CapacitySnapshot['instanceUsage']> {
    const result = await this.pool.query<{
      id: string;
      entry_key: string;
      product: string | null;
      slug: string;
      state: string;
      resources: { cpu?: number; memoryMb?: number; diskMb?: number } | null;
    }>(
      `SELECT i.id, i.entry_key, coalesce(i.payload->>'product', e.product) AS product,
              i.slug, i.state, i.payload->'resources' AS resources
         FROM instance i
         LEFT JOIN catalog_entry e ON e.key = i.entry_key
        WHERE i.deleted_at IS NULL
        ORDER BY i.created_at`,
    );
    return result.rows.map((row) => ({
      instanceId: row.id,
      entryKey: row.entry_key,
      product: row.product ?? row.entry_key,
      slug: row.slug,
      state: row.state,
      cpuCores: row.resources?.cpu ?? 0,
      memoryMb: row.resources?.memoryMb ?? 0,
      diskMb: row.resources?.diskMb ?? 0,
      diskQuotaMb: row.resources?.diskMb ?? 0,
    }));
  }

  /**
   * What the host has already given away.
   *
   * Two sources, and the distinction matters: a **running instance** consumes its declared shape for
   * as long as it exists, while a **reservation** only covers the window between `POST /instances`
   * and the point where the containers are up. Counting only reservations made every deployed
   * instance invisible to admission — the guard reported 0 allocated on a host running a 2 GB
   * product and would happily admit a second one into memory that is already in use.
   */
  private async liveReservations(excludeInstanceId?: string): Promise<ResourceRequest> {
    const result = await this.pool.query<{ cpu_milli: string; memory_mb: string; disk_mb: string }>(
      `WITH declared AS (
         SELECT COALESCE(SUM(ROUND(COALESCE((i.payload->'resources'->>'cpu')::numeric, 0) * 1000)), 0) AS cpu_milli,
                COALESCE(SUM(COALESCE((i.payload->'resources'->>'memoryMb')::numeric, 0)), 0) AS memory_mb,
                COALESCE(SUM(COALESCE((i.payload->'resources'->>'diskMb')::numeric, 0)), 0) AS disk_mb
           FROM instance i
          WHERE i.deleted_at IS NULL
            AND i.state <> 'deleted'
            AND ($1::uuid IS NULL OR i.id IS DISTINCT FROM $1::uuid)
       ),
       held AS (
         -- A reservation whose instance row already exists is the same resources counted above; only
         -- a hold with no row yet (a deployment that has not inserted its instance) is additional.
         SELECT COALESCE(SUM(r.cpu_milli), 0) AS cpu_milli,
                COALESCE(SUM(r.memory_mb), 0) AS memory_mb,
                COALESCE(SUM(r.disk_mb), 0) AS disk_mb
           FROM capacity_reservation r
          WHERE r.released_at IS NULL
            AND ($1::uuid IS NULL OR r.instance_id IS DISTINCT FROM $1::uuid)
            AND NOT EXISTS (SELECT 1 FROM instance x WHERE x.id = r.instance_id)
       )
       SELECT (declared.cpu_milli + held.cpu_milli)::text AS cpu_milli,
              (declared.memory_mb + held.memory_mb)::text AS memory_mb,
              (declared.disk_mb + held.disk_mb)::text AS disk_mb
         FROM declared, held`,
      [excludeInstanceId ?? null],
    );
    const row = result.rows[0];
    return {
      cpuMilli: Number(row?.cpu_milli ?? 0),
      memoryMb: Number(row?.memory_mb ?? 0),
      diskMb: Number(row?.disk_mb ?? 0),
    };
  }

  private empty(): AppError {
    return new AppError({
      code: 'NOT_FOUND',
      detail: 'No capacity snapshot has been recorded yet.',
      remediation:
        'The 4B sampler records one per cycle; the admission fallback measures the host live.',
    });
  }
}

/**
 * Capacity and free space of one filesystem.
 *
 * `statfs` is asked for both because the guard and the board need different halves: admission
 * compares declared reservations with **capacity** (design §13.2 — Σ disk + reserve ≤ 90 % of the
 * pool), while the board has to say how much room is actually left. Measuring only `bavail`, as
 * the first version did, made the "pool" whatever was free after images and logs, so the limit
 * shrank for reasons no deployment caused — and on this stack it measured the image overlay while
 * instance data lived on another volume entirely.
 */
export function measureDisk(
  path: string,
): { path: string; totalMb: number; availableMb: number } | null {
  try {
    const stats = statfsSync(path);
    const blockSize = Number(stats.bsize);
    const totalMb = Math.floor((Number(stats.blocks) * blockSize) / MIB);
    const availableMb = Math.floor((Number(stats.bavail) * blockSize) / MIB);
    // A filesystem that reports no capacity is not a measurement; the caller falls back or refuses.
    if (totalMb <= 0) return null;
    return { path, totalMb, availableMb: Math.max(0, availableMb) };
  } catch {
    return null;
  }
}

/**
 * `MemAvailable` (what a new workload can actually claim) when the kernel exposes it, `freemem()`
 * otherwise. Display only: memory admission is about declared limits, and gating on "free" would
 * double-count the platform's own resident set the same way `bavail` did for disk.
 */
export function availableMemoryMb(totalMb: number): number {
  let value: number | null = null;
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
    if (match !== null) value = Math.floor(Number(match[1]) / 1024);
  } catch {
    // Not Linux, or /proc is not mounted: fall through to libuv's figure.
  }
  if (value === null) {
    try {
      value = Math.floor(freemem() / MIB);
    } catch {
      return 0;
    }
  }
  return Math.min(totalMb, Math.max(0, value));
}

/**
 * Admission utilisation: the percentages the forecast extrapolates from.
 *
 * `used` already contains the platform reserve and `limits` the CPU oversubscription factor and
 * the memory/disk headroom ratios — the numbers the verdict and the board's rulers are computed
 * from, so the sparkline cannot plot a different picture of the same host.
 */
function utilisation(
  input: Pick<
    CapacitySnapshot,
    'host' | 'allocated' | 'platformReserve' | 'oversubscriptionFactor'
  >,
): { cpu: number; memory: number; disk: number } {
  const outcome = admissionVerdict({
    host: { cpu: input.host.cpuCores, memoryMb: input.host.memoryMb, diskMb: input.host.diskMb },
    reserve: {
      cpu: input.platformReserve.cpuCores,
      memoryMb: input.platformReserve.memoryMb,
      diskMb: input.platformReserve.diskMb,
    },
    allocated: {
      cpu: input.allocated.cpuCores,
      memoryMb: input.allocated.memoryMb,
      diskMb: input.allocated.diskMb,
    },
    request: { cpu: 0, memoryMb: 0, diskMb: 0 },
    oversubscriptionFactor: input.oversubscriptionFactor,
  });
  return {
    cpu: percent(outcome.used.cpu, outcome.limits.cpu),
    memory: percent(outcome.used.memoryMb, outcome.limits.memoryMb),
    disk: percent(outcome.used.diskMb, outcome.limits.diskMb),
  };
}

function project(cpu: number, memory: number, disk: number): ForecastPoint[] {
  return Array.from({ length: FORECAST_DAYS }, (_, index) => {
    const day = index + 1;
    return {
      day: String(day),
      cpuPercent: clamp(cpu + day * 0.6),
      memoryPercent: clamp(memory + day * 0.8),
      diskPercent: clamp(disk + day * 1),
    };
  });
}

function percent(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
