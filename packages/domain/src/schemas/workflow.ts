import { z } from 'zod';
import {
  OPERATION_MODES,
  RUN_STATES,
  RUN_TRIGGERS,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_STATES,
} from '../enums';
import { EntryKeySchema, IdSchema, TimestampSchema } from './common';

/**
 * FR-5.5 mapping entry. `transform` covers value/type conversion and date or unit
 * normalization; `required`/`onMissing` are the explicit handling of a missing required
 * field. Authoring is descoped for the MVP (see docs/mvp-platform-exceptions.md); the
 * shape is contractual so the backend can implement it without a further schema change.
 */
export const FieldMappingSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  transform: z.string().nullable(),
  required: z.boolean().optional(),
  onMissing: z.enum(['fail', 'skip', 'default']).optional(),
  defaultValue: z.string().nullable().optional(),
});

export const WorkflowNodeSchema = z.object({
  id: IdSchema,
  kind: z.enum(WORKFLOW_NODE_KINDS),
  label: z.string().min(1),
  product: z.string().min(1),
  entryKey: EntryKeySchema.nullable(),
  operation: z.string().nullable(),
  mode: z.enum(OPERATION_MODES),
  x: z.number(),
  y: z.number(),
  summary: z.string().min(1),
  mappings: z.array(FieldMappingSchema),
});

export const WorkflowEdgeSchema = z.object({
  id: IdSchema,
  source: IdSchema,
  target: IdSchema,
  mappings: z.array(FieldMappingSchema),
});

export const ValidationIssueSchema = z.object({
  id: IdSchema,
  nodeId: IdSchema.nullable(),
  severity: z.enum(['error', 'warning']),
  code: z.string().min(1),
  message: z.string().min(1),
  remediation: z.string().min(1),
});

export const CredentialScopeSchema = z.object({
  id: IdSchema,
  instanceId: IdSchema,
  product: z.string().min(1),
  operations: z.array(z.string().min(1)),
  mode: z.enum(OPERATION_MODES),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
  brokered: z.boolean(),
});

/**
 * FR-5.4 trigger configuration. `config` is the human-readable summary; the structured
 * fields are what the scheduler reads. `cron` applies to `schedule`, `minimumIntervalMinutes`
 * to `poll` (a product with no event mechanism), and `timezone` governs both.
 */
export const WorkflowTriggerSchema = z.object({
  type: z.enum(RUN_TRIGGERS),
  label: z.string().min(1),
  config: z.string().min(1),
  timezone: z.string().nullable(),
  cron: z.string().nullable().optional(),
  minimumIntervalMinutes: z.number().int().positive().nullable().optional(),
});

/**
 * FR-5.1: rename or re-describe. Mapping edits stay out of scope (exception EX-2).
 *
 * `description: null` clears the field. An empty string is *not* a description: it used to be
 * persisted by the create path, and every later read then failed the `min(1)` check below.
 */
export const WorkflowPatchRequestSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().min(1).nullable().optional(),
});

export const WorkflowSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /**
   * `null` means "no description was written"; the column is nullable and the API no longer
   * synthesises `"<name>."` for it. A synthesised value cannot be distinguished from a real one by
   * the screen, and it made the create path's empty string fail this schema on every later read.
   */
  description: z.string().min(1).nullable(),
  owner: z.object({ id: IdSchema, name: z.string().min(1) }),
  state: z.enum(WORKFLOW_STATES),
  version: z.number().int().positive(),
  irHash: z.string().min(1),
  trigger: WorkflowTriggerSchema,
  writeTargets: z.array(
    z.object({
      entryKey: EntryKeySchema,
      product: z.string().min(1),
      mode: z.enum(OPERATION_MODES),
    }),
  ),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  credentialScopes: z.array(CredentialScopeSchema),
  validation: z.object({
    valid: z.boolean(),
    checkedAt: TimestampSchema.nullable(),
    issues: z.array(ValidationIssueSchema),
  }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastRunAt: TimestampSchema.nullable(),
  lastRunState: z.enum(RUN_STATES).nullable(),
  enabled: z.boolean(),
});

export const WorkflowRunNodeSchema = z.object({
  nodeId: IdSchema,
  label: z.string().min(1),
  state: z.enum(RUN_STATES),
  attempt: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

export const WorkflowRunSchema = z.object({
  id: IdSchema,
  workflowId: IdSchema,
  workflowName: z.string().min(1),
  version: z.number().int().positive(),
  trigger: z.enum(RUN_TRIGGERS),
  state: z.enum(RUN_STATES),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
  replayOf: IdSchema.nullable(),
  recordsProcessed: z.number().int().nonnegative(),
  nodes: z.array(WorkflowRunNodeSchema),
  error: z.string().nullable(),
});

/** `POST /workflows/:id/validate` result: blocking errors plus remediation. */
export const WorkflowValidationResultSchema = z.object({
  valid: z.boolean(),
  checkedAt: TimestampSchema,
  issues: z.array(ValidationIssueSchema),
});

/** One endpoint, four outcomes: validate, activate/disable/duplicate, or a run. */
export const WorkflowActionResponseSchema = z.union([
  WorkflowValidationResultSchema,
  WorkflowSchema,
  WorkflowRunSchema,
]);

/**
 * The portable document version, in one place: the export writes it, the import refuses anything
 * else, and the console's import hint quotes it. It was `seamnex/v1` on export and `seamnex.workflow/v1` on
 * import, so a workflow exported by the platform could not be imported back into it.
 */
export const WORKFLOW_EXPORT_API_VERSION = 'seamnex.workflow/v1';

export const WorkflowExportSchema = z.object({
  apiVersion: z.literal(WORKFLOW_EXPORT_API_VERSION),
  exportedAt: TimestampSchema,
  irHash: z.string().min(1),
  workflow: WorkflowSchema,
});

/** FR-5.11: import a previously exported document; it lands as a disabled draft. */
export const WorkflowImportRequestSchema = z.object({
  document: WorkflowExportSchema,
});

// ---------------------------------------------------------------------------------------------
// 4E.1 / CL-02 — authoring endpoints. The IR shape is frozen in this file already; these are the
// mutations that write it. Every one returns the whole workflow, so the canvas re-renders from one
// response instead of stitching a patch into local state.
// ---------------------------------------------------------------------------------------------

export const WorkflowNodeCreateRequestSchema = z.object({
  node: WorkflowNodeSchema,
  /** Optional: connect the new node in the same edit, which is what a canvas drop does. */
  connectFrom: IdSchema.nullable().optional(),
});

export const WorkflowNodePatchRequestSchema = z.object({
  label: z.string().min(1).optional(),
  operation: z.string().min(1).nullable().optional(),
  mode: z.enum(OPERATION_MODES).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  summary: z.string().min(1).optional(),
});

export const WorkflowMappingsRequestSchema = z.object({
  mappings: z.array(FieldMappingSchema),
});

export const WorkflowTriggerUpdateSchema = z.object({
  type: z.enum(RUN_TRIGGERS),
  cron: z.string().min(1).nullable().optional(),
  timezone: z.string().min(1).nullable().optional(),
  minimumIntervalMinutes: z.number().int().positive().nullable().optional(),
});

/** FR-5.4 trigger binding: a unique path token per endpoint, HMAC-signed deliveries only. */
export const TriggerEndpointSchema = z.object({
  id: IdSchema,
  instanceId: IdSchema,
  workflowId: IdSchema.nullable(),
  eventName: z.string().min(1),
  state: z.enum(['active', 'failed']),
  registeredAt: TimestampSchema,
  /** Only returned once, at creation: the URL carries the path token. */
  url: z.string().min(1).nullable(),
  secret: z.string().min(1).nullable(),
});

export const TriggerEndpointListSchema = z.array(TriggerEndpointSchema);

export const TriggerEndpointCreateRequestSchema = z.object({
  eventName: z.string().min(1),
  workflowId: IdSchema.optional(),
});

/** 4E.3: an operation-scoped token, bounded by a workflow version and a 90-day ceiling. */
export const CredentialScopeCreateRequestSchema = z.object({
  workflowId: IdSchema,
  operations: z.array(z.string().min(1)).min(1),
  mode: z.enum(OPERATION_MODES),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(90 * 24 * 60 * 60)
    .optional(),
  idempotencyKey: z.string().min(8).optional(),
});

export const CredentialScopeMintResultSchema = z.object({
  scopeId: IdSchema,
  secretRef: z.string().min(1),
  expiresAt: TimestampSchema,
  mode: z.enum(OPERATION_MODES),
  operations: z.array(z.string().min(1)),
});

/** FR-5.10: an approval node issues a one-time token; the decision consumes it. */
export const WorkflowApprovalDecisionRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().min(1).optional(),
});

export const WorkflowApprovalDecisionResultSchema = z.object({
  runId: IdSchema,
  nodeId: IdSchema,
  state: z.enum(RUN_STATES),
  decidedAt: TimestampSchema,
});

export type WorkflowValidationResult = z.infer<typeof WorkflowValidationResultSchema>;

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type WorkflowRunNode = z.infer<typeof WorkflowRunNodeSchema>;
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export type CredentialScope = z.infer<typeof CredentialScopeSchema>;
export type FieldMapping = z.infer<typeof FieldMappingSchema>;
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;
export type WorkflowExport = z.infer<typeof WorkflowExportSchema>;
export type WorkflowPatchRequest = z.infer<typeof WorkflowPatchRequestSchema>;
export type WorkflowImportRequest = z.infer<typeof WorkflowImportRequestSchema>;
export type WorkflowNodeCreateRequest = z.infer<typeof WorkflowNodeCreateRequestSchema>;
export type WorkflowNodePatchRequest = z.infer<typeof WorkflowNodePatchRequestSchema>;
export type WorkflowMappingsRequest = z.infer<typeof WorkflowMappingsRequestSchema>;
export type WorkflowTriggerUpdate = z.infer<typeof WorkflowTriggerUpdateSchema>;
export type TriggerEndpoint = z.infer<typeof TriggerEndpointSchema>;
export type TriggerEndpointCreateRequest = z.infer<typeof TriggerEndpointCreateRequestSchema>;
export type CredentialScopeCreateRequest = z.infer<typeof CredentialScopeCreateRequestSchema>;
export type CredentialScopeMintResult = z.infer<typeof CredentialScopeMintResultSchema>;
export type WorkflowApprovalDecisionRequest = z.infer<typeof WorkflowApprovalDecisionRequestSchema>;
export type WorkflowApprovalDecisionResult = z.infer<typeof WorkflowApprovalDecisionResultSchema>;
