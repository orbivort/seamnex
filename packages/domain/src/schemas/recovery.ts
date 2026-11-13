import { z } from 'zod';
import { RESTORE_PHASES } from '../enums';
import { BackupSchema, RestoreDrillSchema, RestoreRunSchema } from './backup';
import { TimestampSchema } from './common';

/** Per-phase progress of a platform-state restore (idp → control_plane → login_verified → products → verify). */
export const RestorePhaseStatusSchema = z.object({
  phase: z.enum(RESTORE_PHASES),
  label: z.string().min(1),
  state: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  detail: z.string().min(1),
});

export const PlatformRestoreRunSchema = RestoreRunSchema.extend({
  phases: z.array(RestorePhaseStatusSchema),
  justification: z.string().min(1),
  requestedBy: z.string().min(1),
  /** FR-1.36: product routes stay unpublished until an administrative login succeeds. */
  routesUnpublishedUntilLogin: z.boolean(),
});

export const RecoveryGateSchema = z.object({
  routesPublished: z.boolean(),
  loginVerifiedAt: TimestampSchema.nullable(),
  detail: z.string().min(1),
});

export const RecoveryContentSchema = z.object({
  label: z.string().min(1),
  detail: z.string().min(1),
  included: z.boolean(),
});

export const RecoveryOverviewSchema = z.object({
  generatedAt: TimestampSchema,
  backups: z.array(BackupSchema),
  runs: z.array(PlatformRestoreRunSchema),
  drills: z.array(RestoreDrillSchema),
  gate: RecoveryGateSchema,
  contents: z.array(RecoveryContentSchema),
  lastBackupAt: TimestampSchema.nullable(),
  lastVerifiedRestoreAt: TimestampSchema.nullable(),
});

/**
 * CL-20: a small polling surface for the restore gate. `GET /recovery` carries the whole overview;
 * this answers only "is the gate open, and which phase is running", which is what the edge and the
 * sign-in page need without loading backups and drills.
 */
export const PlatformRestoreStatusSchema = z.object({
  run: PlatformRestoreRunSchema.nullable(),
  gate: RecoveryGateSchema,
  generatedAt: TimestampSchema,
});

export type RestorePhaseStatus = z.infer<typeof RestorePhaseStatusSchema>;
export type PlatformRestoreStatus = z.infer<typeof PlatformRestoreStatusSchema>;
export type PlatformRestoreRun = z.infer<typeof PlatformRestoreRunSchema>;
export type RecoveryGate = z.infer<typeof RecoveryGateSchema>;
export type RecoveryContent = z.infer<typeof RecoveryContentSchema>;
export type RecoveryOverview = z.infer<typeof RecoveryOverviewSchema>;
