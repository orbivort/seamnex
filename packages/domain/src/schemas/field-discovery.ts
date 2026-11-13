import { z } from 'zod';
import { EntryKeySchema, IdSchema, TimestampSchema } from './common';

/**
 * FR-5.5 authoring support: what a write operation accepts, and what a node last received.
 *
 * The field list is discovered from the product at authoring time (never curated in the catalog), so
 * every answer carries its own confidence: `available` means the product described its schema,
 * `unsupported` means the product has no schema endpoint this platform knows, `unavailable` means the
 * call failed. Only `available` is allowed to make a mapping an error — a product outage must not
 * turn into an unactivatable workflow.
 */
export const FIELD_DISCOVERY_STATUSES = ['available', 'unsupported', 'unavailable'] as const;

export const FIELD_DESCRIPTOR_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'object',
  'array',
  'unknown',
] as const;

export const FieldDescriptorSchema = z.object({
  /** The name the product expects in the request body. */
  name: z.string().min(1),
  /** The product's own label, when it publishes one. */
  label: z.string().nullable(),
  type: z.enum(FIELD_DESCRIPTOR_TYPES),
  required: z.boolean(),
});

export const NodeFieldsSchema = z.object({
  nodeId: IdSchema,
  entryKey: EntryKeySchema.nullable(),
  operation: z.string().nullable(),
  status: z.enum(FIELD_DISCOVERY_STATUSES),
  fields: z.array(FieldDescriptorSchema),
  /**
   * When the list was read. A snapshot older than the TTL is re-read on the next request rather than
   * served with an age marker, so `fetchedAt` is evidence, not a freshness verdict the console has
   * to interpret — an `available` answer is always one this process would act on.
   */
  fetchedAt: TimestampSchema.nullable(),
  /** Why the list is missing or was refused; safe to show, never a raw product response. */
  detail: z.string().nullable(),
});

/**
 * A redacted sample of the item a node received. `item` is deliberately `unknown`: the shape is the
 * product's, and the API has already redacted and capped it before it reaches this contract.
 */
export const NodeSampleSchema = z.object({
  nodeId: IdSchema,
  /** The node that produced the item (the target node's inbound edge source). */
  sourceNodeId: IdSchema.nullable(),
  runId: IdSchema.nullable(),
  capturedAt: TimestampSchema.nullable(),
  item: z.unknown().nullable(),
  /** The stored item was capped or redacted; the UI says so rather than implying completeness. */
  truncated: z.boolean(),
});

export type FieldDiscoveryStatus = (typeof FIELD_DISCOVERY_STATUSES)[number];
export type FieldDescriptor = z.infer<typeof FieldDescriptorSchema>;
export type NodeFields = z.infer<typeof NodeFieldsSchema>;
export type NodeSample = z.infer<typeof NodeSampleSchema>;
