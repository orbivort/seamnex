import { z } from 'zod';
import { CREDENTIAL_GRANULARITIES, GUARANTEE_CLASSES } from '../enums';
import { EntryKeySchema, IdSchema, TimestampSchema } from './common';
import { EventModeSchema, OperationSchema } from './catalog';

/**
 * FR-2.14/AC-41: which of the served facts were actually verified at onboarding.
 *
 * The registry used to present catalogue assumptions as verified because the projection coalesced
 * them with a verified row and stamped one `verifiedAt` over the result. Naming the verified subset
 * lets a consumer see provenance without diffing two documents.
 */
export const VERIFIED_FACT_KEYS = [
  'apiBaseUrl',
  'authMethod',
  'guaranteeClass',
  'operations',
  'eventModes',
  'credentialGranularity',
  'sessionMaxMinutes',
  'sloSupported',
] as const;

export type VerifiedFactKey = (typeof VERIFIED_FACT_KEYS)[number];

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
  sloSupported: z.boolean(),
  writeEligible: z.boolean(),
  /** `false` only for `none`: without an API credential not even a read scope can be brokered. */
  workflowEligible: z.boolean(),
  owner: z.string().min(1),
  verifiedAt: TimestampSchema,
  nextReviewAt: TimestampSchema,
  stale: z.boolean(),
  /** Facts backed by the verification row rather than by the catalogue document. */
  verifiedFacts: z.array(z.enum(VERIFIED_FACT_KEYS)),
});

export const OperationsResponseSchema = z.object({
  target: z.string().min(1),
  operations: z.array(OperationSchema),
  eventModes: z.array(EventModeSchema),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type OperationsResponse = z.infer<typeof OperationsResponseSchema>;
