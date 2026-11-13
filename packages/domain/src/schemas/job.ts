import { z } from 'zod';
import { JOB_KINDS, JOB_STATES, JOB_STEP_STATES, LOG_STREAMS } from '../enums';
import { IdSchema, TimestampSchema, pageOf } from './common';

export const JobStepSchema = z.object({
  seq: z.number().int().positive(),
  name: z.string().min(1),
  state: z.enum(JOB_STEP_STATES),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  message: z.string().nullable(),
});

export const JobLogLineSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: TimestampSchema,
  stream: z.enum(LOG_STREAMS),
  line: z.string(),
});

export const JobSchema = z.object({
  id: IdSchema,
  kind: z.enum(JOB_KINDS),
  instanceId: IdSchema.nullable(),
  entryKey: z.string().nullable(),
  label: z.string().min(1),
  state: z.enum(JOB_STATES),
  progress: z.number().min(0).max(100),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  requestedBy: z.string().min(1),
  summary: z.string().min(1),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  steps: z.array(JobStepSchema),
});

export const JobPageSchema = pageOf(JobSchema);
export const JobLogListSchema = z.array(JobLogLineSchema);

export type JobPage = z.infer<typeof JobPageSchema>;

export type Job = z.infer<typeof JobSchema>;
export type JobStep = z.infer<typeof JobStepSchema>;
export type JobLogLine = z.infer<typeof JobLogLineSchema>;
