import type { CapacitySnapshot, ForecastPoint, Instance } from '@seamnex/domain';
import { admissionVerdict } from '@seamnex/domain';
import { at, daysAgo } from './context';
import { PLATFORM_SETTINGS } from './identity';
import { INSTANCES } from './instances';

export const CAPACITY_HOST = { cpuCores: 16, memoryMb: 65_536, diskMb: 1_048_576 };
export const CAPACITY_RESERVE = { cpuCores: 4, memoryMb: 10_240, diskMb: 102_400 };

/**
 * Design §13.2. One function feeds the capacity board, the deploy wizard preview and
 * `POST /instances`, so admission can no longer be computed three different ways.
 */
export function buildCapacity(
  instances: Instance[],
  oversubscriptionFactor: number,
): CapacitySnapshot {
  const allocated = instances.reduce(
    (totals, instance) => ({
      cpuCores: Math.round((totals.cpuCores + instance.resources.cpu) * 10) / 10,
      memoryMb: totals.memoryMb + instance.resources.memoryMb,
      diskMb: totals.diskMb + instance.resources.diskMb,
    }),
    { cpuCores: 0, memoryMb: 0, diskMb: 0 },
  );

  const verdict = admissionVerdict({
    host: {
      cpu: CAPACITY_HOST.cpuCores,
      memoryMb: CAPACITY_HOST.memoryMb,
      diskMb: CAPACITY_HOST.diskMb,
    },
    reserve: {
      cpu: CAPACITY_RESERVE.cpuCores,
      memoryMb: CAPACITY_RESERVE.memoryMb,
      diskMb: CAPACITY_RESERVE.diskMb,
    },
    allocated: { cpu: allocated.cpuCores, memoryMb: allocated.memoryMb, diskMb: allocated.diskMb },
    request: { cpu: 0, memoryMb: 0, diskMb: 0 },
    oversubscriptionFactor,
  });

  // Admission utilisation, not allocation alone: the reserve is counted in `used` and the limits
  // carry the CPU factor plus the memory/disk headroom ratios, exactly like the verdict above.
  const cpuBase = Math.round(
    ((allocated.cpuCores + CAPACITY_RESERVE.cpuCores) / verdict.limits.cpu) * 100,
  );
  const memoryBase = Math.round(
    ((allocated.memoryMb + CAPACITY_RESERVE.memoryMb) / verdict.limits.memoryMb) * 100,
  );
  const diskBase = Math.round(
    ((allocated.diskMb + CAPACITY_RESERVE.diskMb) / verdict.limits.diskMb) * 100,
  );

  // The forecast starts today, not on the day the fixtures were authored: a board whose first
  // column is a fortnight old reads as stale data the moment the demo opens.
  const forecastStart = Date.parse(`${daysAgo(0).slice(0, 10)}T00:00:00Z`);
  const forecast: ForecastPoint[] = Array.from({ length: 14 }, (_, index) => {
    const day = new Date(forecastStart + index * 86_400_000).toISOString().slice(0, 10);
    return {
      day,
      cpuPercent: Math.min(96, Math.max(0, cpuBase + index * 2)),
      memoryPercent: Math.min(94, Math.max(0, memoryBase + index * 1)),
      diskPercent: Math.min(90, Math.max(0, diskBase + index * 1)),
    };
  });

  return {
    ts: at(-2),
    host: CAPACITY_HOST,
    allocated,
    platformReserve: CAPACITY_RESERVE,
    oversubscriptionFactor,
    // Same shape the API records: a capacity total (the 90 % basis) plus the free/available
    // figures an operator uses to verify it. `host.diskMb` is capacity, never free space.
    diskPath: '/var/lib/seamnex/instances',
    diskAvailableMb: CAPACITY_HOST.diskMb - allocated.diskMb,
    memoryAvailableMb: CAPACITY_HOST.memoryMb - allocated.memoryMb,
    instanceUsage: instances.map((instance) => ({
      instanceId: instance.id,
      entryKey: instance.entryKey,
      product: instance.product,
      slug: instance.slug,
      state: instance.state,
      cpuCores: instance.resources.cpu,
      memoryMb: instance.resources.memoryMb,
      diskMb: instance.resources.diskMb,
      diskQuotaMb: instance.resources.diskMb,
    })),
    verdict: {
      admissible: verdict.admissible,
      headline: verdict.headline,
      detail: verdict.detail,
      shortfall: verdict.shortfall,
      reserveNote: verdict.reserveNote,
    },
    forecast,
  };
}

export const CAPACITY: CapacitySnapshot = buildCapacity(
  INSTANCES,
  PLATFORM_SETTINGS.oversubscriptionFactor,
);
