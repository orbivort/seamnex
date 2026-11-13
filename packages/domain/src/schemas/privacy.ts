import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/**
 * NFR-4.13. A data-subject request is addressed by its pseudonymous `subject_ref`; the
 * platform never puts a person's name on the queue.
 */
export const PrivacyScopeSchema = z.object({
  scopeType: z.enum(['platform', 'product']),
  scopeId: z.string().min(1),
  label: z.string().min(1),
  state: z.enum(['pending', 'running', 'complete', 'failed']),
  detail: z.string().min(1),
});

export const PrivacyRequestSchema = z.object({
  id: IdSchema,
  subjectRef: z.string().min(1),
  kind: z.enum(['export', 'delete']),
  state: z.enum(['open', 'running', 'complete', 'failed']),
  openedBy: z.string().min(1),
  openedAt: TimestampSchema,
  dueAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
  scopes: z.array(PrivacyScopeSchema),
  evidence: z.array(z.string()),
});

export const PrivacyQueueSchema = z.object({
  generatedAt: TimestampSchema,
  requests: z.array(PrivacyRequestSchema),
});

export type PrivacyScope = z.infer<typeof PrivacyScopeSchema>;
export type PrivacyRequest = z.infer<typeof PrivacyRequestSchema>;
export type PrivacyQueue = z.infer<typeof PrivacyQueueSchema>;
