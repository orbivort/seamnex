import { z } from 'zod';
import { BACKUP_STATES, RESTORE_PHASES } from '../enums';
import { IdSchema, TimestampSchema } from './common';

export const BackupSchema = z.object({
  id: IdSchema,
  kind: z.enum(['instance', 'platform']),
  instanceId: IdSchema.nullable(),
  instanceLabel: z.string().min(1),
  state: z.enum(BACKUP_STATES),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  sizeBytes: z.number().int().nonnegative(),
  /**
   * Empty while the job is queued or running: the artefact key and the render set are written by
   * the runner when the capture completes, and the row exists before them so the job has a target.
   */
  objectKey: z.string(),
  includes: z.array(z.string().min(1)),
  verifiedAt: TimestampSchema.nullable(),
  verifyMethod: z.string().nullable(),
  renderSetId: z.string(),
});

export const RestoreRunSchema = z.object({
  id: IdSchema,
  backupId: IdSchema,
  kind: z.enum(['instance', 'platform']),
  phase: z.enum(RESTORE_PHASES),
  state: z.enum(['running', 'succeeded', 'failed']),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  loginVerifiedAt: TimestampSchema.nullable(),
  concurrency: z.number().int().min(4).max(12),
  failedReason: z.string().nullable(),
});

export const RestoreDrillSchema = z.object({
  id: IdSchema,
  instanceId: IdSchema.nullable(),
  instanceLabel: z.string().min(1),
  performedAt: TimestampSchema,
  smokeTest: z.string().min(1),
  passed: z.boolean(),
  evidenceUrl: z.string().min(1),
});

export type Backup = z.infer<typeof BackupSchema>;
export type RestoreRun = z.infer<typeof RestoreRunSchema>;
export type RestoreDrill = z.infer<typeof RestoreDrillSchema>;
