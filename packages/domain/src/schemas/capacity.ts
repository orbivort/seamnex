import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/** Nonnegative so an empty portfolio (first-run scenario) is a valid snapshot. */
export const CapacityTotalsSchema = z.object({
  cpuCores: z.number().nonnegative(),
  memoryMb: z.number().int().nonnegative(),
  diskMb: z.number().int().nonnegative(),
});

export const InstanceCapacitySchema = z.object({
  instanceId: IdSchema,
  entryKey: z.string().min(1),
  product: z.string().min(1),
  slug: z.string().min(1),
  state: z.string().min(1),
  cpuCores: z.number().nonnegative(),
  memoryMb: z.number().nonnegative(),
  diskMb: z.number().nonnegative(),
  diskQuotaMb: z.number().nonnegative(),
});

export const ForecastPointSchema = z.object({
  day: z.string().min(1),
  cpuPercent: z.number(),
  memoryPercent: z.number(),
  diskPercent: z.number(),
});

export const AdmissionVerdictSchema = z.object({
  admissible: z.boolean(),
  headline: z.string().min(1),
  detail: z.string().min(1),
  shortfall: z.array(z.string()),
  reserveNote: z.string().min(1),
});

export const CapacitySnapshotSchema = z.object({
  ts: TimestampSchema,
  host: CapacityTotalsSchema,
  allocated: CapacityTotalsSchema,
  platformReserve: CapacityTotalsSchema,
  /** The factor the verdict was computed with, so a client preview can reuse it. */
  oversubscriptionFactor: z.number().positive(),
  /**
   * Where the disk axis was measured. `host.diskMb` is this filesystem's **capacity**;
   * `diskAvailableMb` is what was free at sample time. Both are optional because a snapshot
   * persisted before the guard measured the instance-data volume has neither, and a board must
   * still render it.
   */
  diskPath: z.string().min(1).optional(),
  diskAvailableMb: z.number().nonnegative().optional(),
  /** Machine memory not in use at sample time (`MemAvailable`), for display only. */
  memoryAvailableMb: z.number().nonnegative().optional(),
  instanceUsage: z.array(InstanceCapacitySchema),
  verdict: AdmissionVerdictSchema,
  forecast: z.array(ForecastPointSchema),
});

export type CapacitySnapshot = z.infer<typeof CapacitySnapshotSchema>;
export type InstanceCapacity = z.infer<typeof InstanceCapacitySchema>;
export type AdmissionVerdict = z.infer<typeof AdmissionVerdictSchema>;
export type ForecastPoint = z.infer<typeof ForecastPointSchema>;
