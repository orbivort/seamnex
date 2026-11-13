import { z } from 'zod';
import { CREDENTIAL_GRANULARITIES, GUARANTEE_CLASSES } from '../enums';
import { EntryKeySchema, IdSchema, TimestampSchema } from './common';
import { EventModeSchema, OperationSchema } from './catalog';

export const RegistryEntrySchema = z.object({
  instanceId: IdSchema,
  entryKey: EntryKeySchema,
  product: z.string().min(1),
  slug: z.string().min(1),
  route: z.string().min(1),
  version: z.string().min(1),
  apiBaseUrl: z.string().min(1),
  authMethod: z.string().min(1),
  guaranteeClass: z.enum(GUARANTEE_CLASSES),
  operations: z.array(OperationSchema),
  eventModes: z.array(EventModeSchema),
  credentialGranularity: z.enum(CREDENTIAL_GRANULARITIES),
  writeEligible: z.boolean(),
  /** `false` only for `none`: without an API credential not even a read scope can be brokered. */
  workflowEligible: z.boolean(),
  owner: z.string().min(1),
  verifiedAt: TimestampSchema,
  nextReviewAt: TimestampSchema,
  stale: z.boolean(),
});

export const OperationsResponseSchema = z.object({
  target: z.string().min(1),
  operations: z.array(OperationSchema),
  eventModes: z.array(EventModeSchema),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type OperationsResponse = z.infer<typeof OperationsResponseSchema>;
