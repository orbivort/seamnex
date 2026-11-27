import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/** Nonnegative so an empty portfolio (first-run scenario) is a valid snapshot. */
export const CapacityTotalsSchema = z.object({
  cpuCores: z.number().nonnegative(),
  memoryMb: z.number().int().nonnegative(),
  diskMb: z.number().int().nonnegative(),
});

/**
 * What one instance was **given** versus what it is **using** (FR-4.5).
 *
 * The first four fields are the declared shape from the deploy request — the admission ledger. The
 * `*Consumed*` fields are measurements from `instance_usage_sample`. They are optional and never
 * defaulted to `0`: an absent figure means "not measured", while `0` would be a claim. `measuredAt`
 * carries the sample's age so a board can say how stale the number is instead of implying it is live.
 */
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
  cpuConsumedMilli: z.number().nonnegative().optional(),
  memoryConsumedMb: z.number().nonnegative().optional(),
  diskConsumedMb: z.number().nonnegative().optional(),
  measuredAt: TimestampSchema.nullable().optional(),
});

/**
 * Alerting thresholds in force (FR-4.5), echoed in the snapshot.
 *
 * They live in `settings` and are read by `notification.evaluate()`; carrying them in the snapshot is
 * how the capacity board can draw the same bands without needing `settings.view` — R3 holds
 * `capacity.view` and must not be shown a threshold it cannot verify.
 */
export const CapacityThresholdsSchema = z.object({
  cpuPercent: z.number().min(1).max(100),
  memoryPercent: z.number().min(1).max(100),
  diskPercent: z.number().min(1).max(100),
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
  /**
   * Optional for the same reason as the disk provenance above: a snapshot persisted before the
   * thresholds were configurable has none, and the board must still render it.
   */
  thresholds: CapacityThresholdsSchema.optional(),
  instanceUsage: z.array(InstanceCapacitySchema),
  verdict: AdmissionVerdictSchema,
  forecast: z.array(ForecastPointSchema),
});

export type CapacitySnapshot = z.infer<typeof CapacitySnapshotSchema>;
export type CapacityThresholds = z.infer<typeof CapacityThresholdsSchema>;
export type InstanceCapacity = z.infer<typeof InstanceCapacitySchema>;
export type AdmissionVerdict = z.infer<typeof AdmissionVerdictSchema>;
export type ForecastPoint = z.infer<typeof ForecastPointSchema>;
