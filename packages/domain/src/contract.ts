import { z } from 'zod';
import { CREDENTIAL_GRANULARITIES, WORKFLOW_STATES } from './enums';
import { ANY_OF_POLICY_KEYS, POLICY_KEYS, type PolicyKey } from './policy';
import { AuthSessionSchema, SignInRequestSchema } from './schemas/auth';
import { JobAcceptedSchema } from './schemas/common';
import {
  AccessRequestCreateSchema,
  EntitlementResponseSchema,
  LauncherResponseSchema,
  LauncherTileSchema,
  LaunchEventSchema,
  LaunchTargetSchema,
  LaunchTicketSchema,
  LogoutResponseSchema,
  MeSchema,
  RequestableProductSchema,
  StatusBannerSchema,
} from './schemas/portal';
import {
  CatalogEntrySchema,
  CatalogReloadResultSchema,
  EnvImportRequestSchema,
  EnvImportResultSchema,
  EnvPlanSchema,
  EnvProfileSchema,
  EnvSchemaVarSchema,
  ScaffoldConfirmationSchema,
  ScaffoldDraftSchema,
} from './schemas/catalog';
import {
  AdminCredentialRequestSchema,
  AdminCredentialSchema,
  BackupPostureSchema,
  BackupScheduleRequestSchema,
  ContainerLogListSchema,
  ContainerStatusSchema,
  DeployPreviewRequestSchema,
  DeployPreviewSchema,
  RelayProvisionReportSchema,
  DriftRecordSchema,
  EnvUpdateResponseSchema,
  EnvValueSchema,
  ImageSchema,
  InstanceDetailSchema,
  InstanceListSchema,
  InstancePlanSchema,
  InstanceStatusSchema,
  LifecycleActionRequestSchema,
} from './schemas/instance';
import { JobLogListSchema, JobPageSchema, JobSchema } from './schemas/job';
import { NodeFieldsSchema, NodeSampleSchema } from './schemas/field-discovery';
import {
  CredentialScopeCreateRequestSchema,
  CredentialScopeMintResultSchema,
  TriggerEndpointCreateRequestSchema,
  TriggerEndpointListSchema,
  TriggerEndpointSchema,
  WorkflowApprovalDecisionRequestSchema,
  WorkflowApprovalDecisionResultSchema,
  WorkflowImportRequestSchema,
  WorkflowMappingsRequestSchema,
  WorkflowNodeCreateRequestSchema,
  WorkflowNodePatchRequestSchema,
  WorkflowPatchRequestSchema,
  WorkflowTriggerUpdateSchema,
} from './schemas/workflow';
import {
  AccessRequestSchema,
  AuditExportSchema,
  AuditPageSchema,
  AuditProofSchema,
  AuditRangeVerificationSchema,
  AuditRangeVerifyRequestSchema,
  BreakGlassRevealSchema,
  BreakGlassSessionSchema,
  DsarRequestSchema,
  LicenseGateSchema,
  LicenseRecordSchema,
  MaintenanceWindowCreateRequestSchema,
  MaintenanceWindowPatchRequestSchema,
  MaintenanceWindowSchema,
  PatchRecordSchema,
  PolicyExceptionSchema,
  PostureSummarySchema,
} from './schemas/governance';
import { CapacitySnapshotSchema, ForecastPointSchema } from './schemas/capacity';
import {
  AlertChannelSchema,
  AlertTestResultSchema,
  DisableUserResponseSchema,
  IdpGroupSchema,
  IdpUserSchema,
  PlatformSettingsSchema,
  SyncRunSchema,
  UserEntitlementsSchema,
} from './schemas/identity';
import {
  WorkflowActionResponseSchema,
  WorkflowExportSchema,
  WorkflowRunSchema,
  WorkflowSchema,
} from './schemas/workflow';
import { OperationsResponseSchema, RegistryEntrySchema } from './schemas/registry';
import { PlatformRestoreStatusSchema, RecoveryOverviewSchema } from './schemas/recovery';
import { PrivacyQueueSchema, PrivacyRequestSchema } from './schemas/privacy';
import { BackupSchema, RestoreDrillSchema } from './schemas/backup';

/**
 * The single machine-readable list of platform API operations.
 *
 * `packages/mocks` serves them and `packages/api-client` consumes them; a parity test
 * asserts that neither side can add, rename or drop a route without this file changing.
 * The OpenAPI document is generated from here, so it cannot drift from the fixtures.
 */
export type OperationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type OperationTag =
  | 'portal'
  | 'catalog'
  | 'instances'
  | 'jobs'
  | 'workflows'
  | 'governance'
  | 'admin'
  | 'recovery'
  | 'privacy'
  | 'registry'
  | 'prototype';

/**
 * A query parameter the operation accepts. Declared as data so the client can reject an
 * unknown key before it leaves the browser and the OpenAPI document can describe it.
 */
export type QueryParam = {
  name: string;
  type: 'string' | 'integer' | 'boolean';
  required?: boolean;
  description: string;
  /** Closed set of allowed values. */
  values?: readonly string[];
  /**
   * A dynamic key family rather than a single key, e.g. `env` accepts `env.MAIL_HOST`.
   * The client accepts `<name>.` prefixed keys and nothing else.
   */
  prefix?: boolean;
};

/** The declared shape of an operation before the policy key is attached. */
export type DeclaredOperation = {
  method: OperationMethod;
  /** Path relative to the `/api/v1` server prefix; `:param` becomes `{param}` in OpenAPI. */
  path: string;
  summary: string;
  tag: OperationTag;
  /** Response body contract. Omitted only when `noContent` is set. */
  response?: z.ZodType;
  request?: z.ZodType;
  /** Declared query surface; anything else is a contract violation on the client. */
  query?: readonly QueryParam[];
  /** Long-running operation: the response is `202` with a job id to poll. */
  accepted?: boolean;
  /** Success is `204` with an empty body; no response schema exists. */
  noContent?: boolean;
  /**
   * Participates in optimistic concurrency: the client sends `If-Match` from the last GET
   * of the same path, and the server may answer `412`. Operations that do not declare it
   * never receive the header.
   */
  conditional?: boolean;
  /**
   * The response carries an `ETag` validator for a later write to the same path.
   *
   * Declared on the *read* as well as the write: the client stores the validator of the last GET
   * of a path and replays it as `If-Match`, so a `conditional` write whose read publishes no
   * validator can never satisfy its precondition — every save answers `412`.
   */
  etag?: true;
  /** `external` = consumed by BI or scripts, not by a screen in this repository. */
  consumer?: 'ui' | 'external';
  contentType?: 'application/json' | 'text/event-stream';
  /**
   * Declared anonymous: no session is required and the PDP is skipped. The set is pinned to
   * `ANONYMOUS_OPERATIONS` by the route-policy check.
   */
  anonymous?: true;
  /** Contract-driven throttling (ADR-BE-05 / deliverable 3.2). Only sign-in declares it. */
  rateLimit?: { bucket: 'auth'; limit: number; windowSeconds: number };
};

/**
 * ADR-BE-05: a mounted operation always carries the capability the PDP evaluates. The key is
 * attached from `POLICY_KEYS` when the registry is built, so a route without one cannot exist.
 *
 * `policyAnyOf` is attached from `ANY_OF_POLICY_KEYS` and only present on the few operations whose
 * readers do not share a capability (see `policy.ts`). When it is present the PDP evaluates the set
 * as one decision; `policyKey` remains the declared name reported in refusals and the OpenAPI
 * document, so no consumer has to know about the set.
 */
export type ApiOperation = DeclaredOperation & {
  policyKey: PolicyKey;
  policyAnyOf?: readonly PolicyKey[];
};

const DeployRequestSchema = z.object({
  entryKey: z.string().min(1),
  slug: z.string().min(1),
  profile: z.string().optional(),
  resources: z
    .object({
      cpu: z.number().positive(),
      memoryMb: z.number().positive(),
      diskMb: z.number().positive(),
    })
    .optional(),
  envOverrides: z.record(z.string(), z.string()).optional(),
});

const EnvUpdateRequestSchema = z.object({ values: z.record(z.string(), z.string()) });

/**
 * Omit `description` to leave it unset. An empty string is refused rather than stored: the column
 * keeps `NULL`, and a stored `''` used to make `GET /workflows` fail its own response schema.
 */
const WorkflowDraftRequestSchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().min(1).optional(),
  triggerType: z.enum(['schedule', 'webhook', 'poll', 'manual']),
  sourceInstanceId: z.string().min(1),
  targetInstanceId: z.string().min(1),
});

export const IntegrationMetadataRequestSchema = z.object({
  // FR-2.14: the value is a fact the whole platform branches on; a free-text string used to be
  // persisted into the catalog document and only failed later, as an unreadable projection.
  credentialGranularity: z.enum(CREDENTIAL_GRANULARITIES).optional(),
  sessionMaxMinutes: z.number().int().positive().optional(),
});

/**
 * NFR-4.13: the queue is addressed by an opaque pseudonymous reference, never by a name or an
 * address. A 64-character HMAC from the identity-provider export and a short prototype reference
 * (`sub_44c1`) both qualify; an `@` or a space disqualifies the value, which is what stops an
 * operator from pasting a person's email address into a privacy queue.
 */
const SUBJECT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{3,63}$/;

const PrivacyRequestCreateSchema = z.object({
  subjectRef: z
    .string()
    .regex(
      SUBJECT_REF_PATTERN,
      'Use the opaque subject reference from the identity-provider export (4–64 characters, no spaces).',
    ),
  kind: z.enum(['export', 'delete']),
});

const RestoreStartSchema = z.object({
  backupId: z.string().min(1),
  justification: z.string().min(1),
});

/** AC-15/FR-4.3: a signed audit export covers an explicit range. */
const AuditExportRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

/** FR-4.6: the channel list is replaced wholesale; at least one channel must survive. */
const AlertChannelsPutSchema = z.array(AlertChannelSchema).min(1);

/**
 * FR-2.4: a mapping change applies to future syncs. `propagate` forces an immediate
 * product-side propagation instead of waiting for the next cycle.
 */
const GroupMappingRequestSchema = z.object({
  role: z.string().min(1),
  scopeType: z.string().min(1),
  scopeLabel: z.string().min(1),
  propagate: z.boolean().default(false),
});

const op = (operation: DeclaredOperation): DeclaredOperation => operation;

const DECLARED_OPERATIONS: readonly DeclaredOperation[] = [
  // Session surface (deliverable 3.2). Anonymous by declaration; PDP skipped, allowlist pinned.
  op({
    method: 'GET',
    path: '/auth/session',
    summary: 'Current session state, or `authenticated: false` when no session exists.',
    tag: 'portal',
    response: AuthSessionSchema,
    anonymous: true,
  }),
  op({
    method: 'POST',
    path: '/auth/session',
    summary:
      'Exchange an authorization code (PKCE) plus second factor for a seamnex_session cookie.',
    tag: 'portal',
    response: AuthSessionSchema,
    request: SignInRequestSchema,
    anonymous: true,
    rateLimit: { bucket: 'auth', limit: 10, windowSeconds: 300 },
  }),

  // Portal and identity
  op({
    method: 'GET',
    path: '/me',
    summary: 'Current identity, role and MFA state.',
    tag: 'portal',
    response: MeSchema,
  }),
  op({
    method: 'GET',
    path: '/me/entitlements',
    summary: 'Every product the caller can reach, with product-level role.',
    tag: 'portal',
    response: EntitlementResponseSchema,
  }),
  op({
    method: 'GET',
    path: '/me/launcher',
    summary: 'Launcher tiles derived from entitlements and plain-language status.',
    tag: 'portal',
    response: LauncherResponseSchema,
  }),
  op({
    method: 'POST',
    path: '/me/logout',
    summary: 'Global sign-out; names products with a residual session.',
    tag: 'portal',
    response: LogoutResponseSchema,
  }),
  op({
    method: 'GET',
    path: '/portal/status-banner',
    summary: 'Portal-wide availability banner, or null when nothing is degraded.',
    tag: 'portal',
    response: StatusBannerSchema.nullable(),
  }),
  op({
    method: 'GET',
    path: '/portal/launch-targets/:instanceId',
    summary: 'Launch resolution: target URL, auth class and what happens on launch.',
    tag: 'portal',
    response: LaunchTargetSchema,
  }),
  op({
    method: 'POST',
    path: '/portal/launch-tickets/:instanceId',
    summary: 'Single-use ticket that plants the platform session on a forward-auth product host.',
    tag: 'portal',
    response: LaunchTicketSchema,
  }),
  op({
    method: 'POST',
    path: '/portal/launch-events/:instanceId',
    summary:
      'Records that a person opened a product, so a failed sign-in has a trail to investigate.',
    tag: 'portal',
    response: LaunchEventSchema,
  }),
  op({
    method: 'GET',
    path: '/portal/requestable',
    summary: 'Products the caller may request access to, with any open request (FR-3.13).',
    tag: 'portal',
    response: z.array(RequestableProductSchema),
  }),
  op({
    method: 'GET',
    path: '/portal/products/:slug',
    summary: 'One entitled product tile by slug, so a deep link does not need the whole launcher.',
    tag: 'portal',
    response: LauncherTileSchema,
  }),

  // Catalog
  op({
    method: 'GET',
    path: '/catalog',
    summary: 'Catalog projection, server-side filtered by q, cluster and packaging.',
    tag: 'catalog',
    response: z.array(CatalogEntrySchema),
    query: [
      { name: 'q', type: 'string', description: 'Free-text match on product, domain or key.' },
      { name: 'cluster', type: 'string', description: 'Domain cluster.' },
      {
        name: 'packaging',
        type: 'string',
        description: 'Packaging kind.',
        values: ['compose', 'dockerfile', 'none'],
      },
    ],
  }),
  op({
    method: 'POST',
    path: '/catalog/reload',
    summary: 'Re-read the catalog repository and reconcile the projection (M1/M22).',
    tag: 'catalog',
    response: CatalogReloadResultSchema,
  }),
  op({
    method: 'GET',
    path: '/catalog/:key',
    summary: 'One catalog entry with expected and verified integration metadata.',
    tag: 'catalog',
    response: CatalogEntrySchema,
  }),
  op({
    method: 'GET',
    path: '/catalog/:key/env-schema',
    summary: 'Declared environment variables with type and override ceiling.',
    tag: 'catalog',
    response: z.array(EnvSchemaVarSchema),
  }),
  op({
    method: 'GET',
    path: '/catalog/:key/env-plan',
    summary: 'Resolved environment preview: default, profile and instance precedence.',
    tag: 'catalog',
    response: EnvPlanSchema,
    query: [
      { name: 'profile', type: 'string', description: 'Environment profile key.' },
      {
        name: 'env',
        type: 'string',
        description: 'Instance override for one declared variable, as `env.<NAME>`.',
        prefix: true,
      },
    ],
  }),
  op({
    method: 'POST',
    path: '/catalog/:key/env-import',
    summary: 'Map a pasted .env or Compose environment into the declared schema (FR-1.30).',
    tag: 'catalog',
    response: EnvImportResultSchema,
    request: EnvImportRequestSchema,
  }),
  op({
    method: 'GET',
    path: '/env-profiles',
    summary: 'Environment profiles available to deployments.',
    tag: 'catalog',
    response: z.array(EnvProfileSchema),
  }),
  op({
    method: 'PATCH',
    path: '/catalog/:key/integration-metadata',
    summary: 'Verify integration metadata; staleness clock restarts.',
    tag: 'catalog',
    response: CatalogEntrySchema,
    request: IntegrationMetadataRequestSchema,
  }),
  op({
    method: 'GET',
    path: '/catalog/:key/scaffold',
    summary: 'Generated artefact draft for an entry with no Compose file or Dockerfile.',
    tag: 'catalog',
    response: ScaffoldDraftSchema,
  }),
  op({
    method: 'POST',
    path: '/catalog/:key/scaffold/:draftId/confirm',
    summary: 'Confirm the draft and commit the artefacts (FR-1.22).',
    tag: 'catalog',
    response: ScaffoldConfirmationSchema,
  }),
  /**
   * CL-18: NFR-2.4 measures apply, not download, so an operator needs a way to warm the image
   * cache before a deployment window. It is a job, not a blocking call: a pull takes minutes.
   */
  op({
    method: 'POST',
    path: '/catalog/:key/prefetch',
    summary: 'Pre-pull the images a catalog entry references (CL-18).',
    tag: 'catalog',
    response: JobAcceptedSchema,
    accepted: true,
  }),

  // Instances
  op({
    method: 'GET',
    path: '/instances',
    summary: 'Fleet inventory, server-side filtered by state, entryKey and q.',
    tag: 'instances',
    response: InstanceListSchema,
    query: [
      {
        name: 'q',
        type: 'string',
        description: 'Free-text match on product, domain, slug or key.',
      },
      { name: 'state', type: 'string', description: 'Derived lifecycle state.' },
      { name: 'entryKey', type: 'string', description: 'Catalog entry key.' },
    ],
  }),
  op({
    method: 'GET',
    path: '/instances/:id',
    summary: 'Instance detail with services, volumes and integration checks.',
    tag: 'instances',
    response: InstanceDetailSchema,
  }),
  op({
    method: 'GET',
    path: '/instances/:id/status',
    summary: 'Derived status: running and ready are distinct.',
    tag: 'instances',
    response: InstanceStatusSchema,
    query: [
      {
        name: 'refresh',
        type: 'boolean',
        description: 'FR-1.33: force an on-demand observation instead of reading the last poll.',
      },
    ],
  }),
  op({
    method: 'GET',
    path: '/instances/:id/containers',
    summary: 'Per-container truth: state, health, restarts, exit code and digest.',
    tag: 'instances',
    response: z.array(ContainerStatusSchema),
  }),
  op({
    method: 'GET',
    path: '/instances/:id/env',
    summary: 'Resolved environment with masked secrets and drift flags.',
    tag: 'instances',
    response: z.array(EnvValueSchema),
  }),
  op({
    method: 'PUT',
    path: '/instances/:id/env',
    summary: 'Change environment values; returns the render diff (AC-28).',
    tag: 'instances',
    response: EnvUpdateResponseSchema,
    request: EnvUpdateRequestSchema,
  }),
  /**
   * ADR-BE-22 — the administrator token the relay's provisioning calls the product's API with.
   *
   * OpenProject accepts only a personal access token for `/api/v3`, and a token can be minted only
   * inside an authenticated session (the seeded administrator is behind `force_password_change`),
   * so the operator supplies one and the platform never invents it. Without this surface the sweep
   * recorded `admin_credential_missing` forever and every launch fell back to the product's form,
   * with nothing in the console naming the missing value.
   */
  op({
    method: 'GET',
    path: '/instances/:id/admin-credential',
    summary: 'Status of the product administrator token used to provision relay accounts.',
    tag: 'instances',
    response: AdminCredentialSchema,
  }),
  op({
    method: 'PUT',
    path: '/instances/:id/admin-credential',
    summary: 'Store or replace the product administrator token used for relay provisioning.',
    tag: 'instances',
    response: AdminCredentialSchema,
    request: AdminCredentialRequestSchema,
  }),
  /**
   * ADR-BE-22 — provision now, rather than waiting for the sweep.
   *
   * A deployment emits the same request when it records, and a launch asks for one subject, but
   * neither is reachable by an operator who has just replaced a token and wants to know whether the
   * mapping appeared. Restarting the scheduler used to be that action; this replaces it with one
   * that reports what it did, in counts, and leaves the reason per candidate in the audit chain.
   */
  op({
    method: 'POST',
    path: '/instances/:id/relay/provision',
    summary: 'Provision the relay product accounts for this instance now.',
    tag: 'instances',
    response: RelayProvisionReportSchema,
  }),
  op({
    method: 'GET',
    path: '/instances/:id/drift',
    summary: 'Declarative drift between the repository and runtime state.',
    tag: 'instances',
    response: z.array(DriftRecordSchema),
  }),
  op({
    method: 'GET',
    path: '/instances/:id/backups',
    summary: 'Instance backups with verification state.',
    tag: 'instances',
    response: z.array(BackupSchema),
  }),
  op({
    method: 'GET',
    path: '/instances/:id/containers/:cid/logs',
    summary: 'Recent container logs, retrievable without host shell access (AC-29).',
    tag: 'instances',
    response: ContainerLogListSchema,
  }),
  op({
    method: 'POST',
    path: '/instances/:id/backups',
    summary: 'Start an instance backup job.',
    tag: 'instances',
    response: JobAcceptedSchema,
    accepted: true,
  }),
  op({
    method: 'PUT',
    path: '/instances/:id/backup-schedule',
    summary: 'Change the scheduled backup cadence and timezone (FR-1.12).',
    tag: 'instances',
    response: BackupPostureSchema,
    request: BackupScheduleRequestSchema,
  }),
  op({
    method: 'POST',
    path: '/backups/:id/verify',
    summary: 'Verify a backup artefact (202: the scratch-stack check is a job).',
    tag: 'instances',
    response: JobAcceptedSchema,
    accepted: true,
  }),
  op({
    method: 'POST',
    path: '/backups/:id/restore',
    summary: 'Restore a backup into a scratch stack and smoke-test it (202: job hand-off).',
    tag: 'instances',
    response: JobAcceptedSchema,
    /*
     * The handler reads `justification`, so the operation has to declare it: without a schema the
     * dispatcher handed the raw body through and any JSON reached the service. The body stays
     * optional (`{}` is a valid restore), which is why every field is optional rather than the
     * operation being bodyless.
     */
    request: z.object({ justification: z.string().min(1).optional() }),
    accepted: true,
  }),
  op({
    method: 'GET',
    path: '/instances/:id/images',
    summary: 'Image history retained for rollback (AC-22).',
    tag: 'instances',
    response: z.array(ImageSchema),
  }),
  op({
    method: 'GET',
    path: '/instances/:id/plan',
    summary: 'Lifecycle plan: changes, pre-upgrade backup, capacity verdict.',
    tag: 'instances',
    response: InstancePlanSchema,
    query: [{ name: 'action', type: 'string', description: 'Lifecycle action to plan for.' }],
  }),
  op({
    method: 'POST',
    path: '/instances',
    summary: 'Deploy a catalog entry (slug, environment, admission checked).',
    tag: 'instances',
    response: JobAcceptedSchema,
    request: DeployRequestSchema,
    accepted: true,
  }),
  op({
    method: 'POST',
    path: '/instances/:id/:action',
    summary: 'Lifecycle action: start, stop, restart, upgrade, rollback, delete or export.',
    tag: 'instances',
    response: JobAcceptedSchema,
    request: LifecycleActionRequestSchema,
    accepted: true,
  }),
  /**
   * CL-09: admission is a server decision. The wizard may still *explain* the verdict, but it no
   * longer computes it; a browser-side estimate that disagrees with the API is worse than none.
   * Declared before `/:id/:action` so the static segment is registered first.
   */
  op({
    method: 'POST',
    path: '/instances/preview',
    summary: 'Server-authoritative admission and routing preview for a deploy (CL-09).',
    tag: 'instances',
    response: DeployPreviewSchema,
    request: DeployPreviewRequestSchema,
  }),

  // Trigger registration (CL-19, backend-first: the console authoring surface is descoped).
  op({
    method: 'GET',
    path: '/instances/:id/triggers',
    summary: 'Registered trigger endpoints for an instance.',
    tag: 'instances',
    response: TriggerEndpointListSchema,
    consumer: 'external',
  }),
  op({
    method: 'POST',
    path: '/instances/:id/triggers',
    summary: 'Register a trigger endpoint; the URL and secret are returned once (CL-19).',
    tag: 'instances',
    response: TriggerEndpointSchema,
    request: TriggerEndpointCreateRequestSchema,
    consumer: 'external',
  }),
  op({
    method: 'DELETE',
    path: '/instances/:id/triggers/:triggerId',
    summary: 'Revoke a trigger endpoint and release its token hash.',
    tag: 'instances',
    noContent: true,
    consumer: 'external',
  }),

  // Credential scopes (4E.3).
  op({
    method: 'POST',
    path: '/instances/:id/credential-scopes',
    summary: 'Mint an operation-scoped credential for a workflow version (4E.3).',
    tag: 'instances',
    response: CredentialScopeMintResultSchema,
    request: CredentialScopeCreateRequestSchema,
    consumer: 'external',
  }),
  op({
    method: 'DELETE',
    path: '/credential-scopes/:id',
    summary: 'Revoke a credential scope; revoking is idempotent.',
    tag: 'instances',
    noContent: true,
    consumer: 'external',
  }),

  // Jobs
  op({
    method: 'GET',
    path: '/jobs',
    summary: 'Cursor-paged job history, filtered by instance, kind and state.',
    tag: 'jobs',
    response: JobPageSchema,
    query: [
      { name: 'instanceId', type: 'string', description: 'Only jobs for this instance.' },
      { name: 'kind', type: 'string', description: 'Job kind.' },
      { name: 'state', type: 'string', description: 'Job state.' },
      { name: 'cursor', type: 'string', description: 'Opaque cursor from the previous page.' },
      { name: 'limit', type: 'integer', description: 'Page size, default 100, maximum 100.' },
    ],
  }),
  op({
    method: 'GET',
    path: '/jobs/:id',
    summary: 'Job with per-step progress.',
    tag: 'jobs',
    response: JobSchema,
  }),
  op({
    method: 'GET',
    path: '/jobs/:id/logs',
    summary: 'Masked job log lines.',
    tag: 'jobs',
    response: JobLogListSchema,
  }),
  op({
    method: 'GET',
    path: '/jobs/:id/stream',
    summary: 'Server-sent events: job state changes and new log lines.',
    tag: 'jobs',
    response: z.unknown(),
    contentType: 'text/event-stream',
  }),
  op({
    method: 'POST',
    path: '/jobs/:id/cancel',
    summary: 'Cancel a queued or running job.',
    tag: 'jobs',
    response: JobSchema,
  }),
  op({
    method: 'POST',
    path: '/jobs/:id/retry',
    summary: 'Retry a failed job; returns the new job id.',
    tag: 'jobs',
    response: JobAcceptedSchema,
    accepted: true,
  }),

  // Workflows
  op({
    method: 'GET',
    path: '/workflows',
    summary: 'Workflow definitions with state and last run, filtered by q and state.',
    tag: 'workflows',
    response: z.array(WorkflowSchema),
    query: [
      { name: 'q', type: 'string', description: 'Free-text match on name or description.' },
      {
        name: 'state',
        type: 'string',
        description: 'Workflow state, exact match.',
        values: WORKFLOW_STATES,
      },
      {
        name: 'limit',
        type: 'integer',
        description: 'Page size, 1–200. Omitted returns every match.',
      },
      { name: 'offset', type: 'integer', description: 'Rows to skip; used with limit.' },
    ],
  }),
  op({
    method: 'GET',
    path: '/workflows/:id',
    summary: 'One workflow with nodes, edges, write targets and validation.',
    tag: 'workflows',
    response: WorkflowSchema,
  }),
  op({
    method: 'POST',
    path: '/workflows',
    summary: 'Create a draft from discovered operations.',
    tag: 'workflows',
    response: WorkflowSchema,
    request: WorkflowDraftRequestSchema,
  }),
  op({
    method: 'DELETE',
    path: '/workflows/:id',
    summary: 'Delete a workflow and release its trigger endpoints.',
    tag: 'workflows',
    noContent: true,
  }),
  op({
    method: 'POST',
    path: '/workflows/:id/:action',
    summary: 'Validate, activate, disable, run or duplicate a workflow.',
    tag: 'workflows',
    response: WorkflowActionResponseSchema,
  }),
  op({
    method: 'PATCH',
    path: '/workflows/:id',
    summary: 'Rename or re-describe a workflow; mapping edits stay read-only.',
    tag: 'workflows',
    response: WorkflowSchema,
    request: WorkflowPatchRequestSchema,
    conditional: true,
  }),
  op({
    method: 'POST',
    path: '/workflows/import',
    summary: 'Import an exported workflow document as a disabled draft (FR-5.11).',
    tag: 'workflows',
    response: WorkflowSchema,
    request: WorkflowImportRequestSchema,
  }),
  op({
    method: 'GET',
    path: '/workflows/:id/runs',
    summary: 'Run history with per-node outcomes.',
    tag: 'workflows',
    response: z.array(WorkflowRunSchema),
  }),
  op({
    method: 'GET',
    path: '/workflow-runs/:runId',
    summary: 'One run, inspectable node by node.',
    tag: 'workflows',
    response: WorkflowRunSchema,
  }),
  op({
    method: 'POST',
    path: '/workflow-runs/:runId/replay',
    summary: 'Replay a run without duplicating the record.',
    tag: 'workflows',
    response: WorkflowRunSchema,
  }),
  op({
    method: 'GET',
    path: '/workflows/:id/export',
    summary: 'Portable workflow export with an IR hash.',
    tag: 'workflows',
    response: WorkflowExportSchema,
  }),

  // Authoring (CL-02). Each mutation returns the whole workflow: one response re-renders the canvas.
  op({
    method: 'POST',
    path: '/workflows/:id/nodes',
    summary: 'Add a node and optionally connect it to an existing one (CL-02).',
    tag: 'workflows',
    response: WorkflowSchema,
    request: WorkflowNodeCreateRequestSchema,
  }),
  op({
    method: 'PATCH',
    path: '/workflows/:id/nodes/:nodeId',
    summary: 'Edit a node label, operation, mode or position.',
    tag: 'workflows',
    response: WorkflowSchema,
    request: WorkflowNodePatchRequestSchema,
  }),
  op({
    method: 'DELETE',
    path: '/workflows/:id/nodes/:nodeId',
    summary: 'Remove a node and every edge attached to it.',
    tag: 'workflows',
    response: WorkflowSchema,
  }),
  op({
    method: 'PUT',
    path: '/workflows/:id/nodes/:nodeId/mappings',
    summary: 'Replace the field mappings of one node (FR-5.5).',
    tag: 'workflows',
    response: WorkflowSchema,
    request: WorkflowMappingsRequestSchema,
  }),
  /**
   * FR-5.5 authoring support. The field list comes from the product itself at authoring time: a
   * curation in the catalog would publish fields the product has not got, and a run would fail on a
   * mapping the author was told was valid. `refresh` forces a live call past the cache TTL.
   */
  op({
    method: 'GET',
    path: '/workflows/:id/nodes/:nodeId/fields',
    summary: 'Fields the node operation accepts, discovered from the product (FR-5.5).',
    tag: 'workflows',
    response: NodeFieldsSchema,
    query: [
      {
        name: 'refresh',
        type: 'boolean',
        description: 'Re-read the product schema instead of the cached snapshot (rate-limited).',
      },
    ],
  }),
  op({
    method: 'GET',
    path: '/workflows/:id/nodes/:nodeId/sample',
    summary: 'Redacted item the node last received, used to pick source paths (FR-5.5).',
    tag: 'workflows',
    response: NodeSampleSchema,
  }),
  op({
    method: 'PUT',
    path: '/workflows/:id/trigger',
    summary: 'Set the trigger type with its cron, timezone or minimum interval (FR-5.4).',
    tag: 'workflows',
    response: WorkflowSchema,
    request: WorkflowTriggerUpdateSchema,
  }),
  /**
   * FR-5.10: an approval node blocks a run until a human decides. The token is single-use and is
   * carried in the notification link; the decision endpoint is external because no screen posts it.
   */
  op({
    method: 'POST',
    path: '/workflow-approvals/:token/decision',
    summary: 'Approve or reject a waiting approval node with its one-time token (FR-5.10).',
    tag: 'workflows',
    response: WorkflowApprovalDecisionResultSchema,
    request: WorkflowApprovalDecisionRequestSchema,
    consumer: 'external',
  }),

  // Governance
  op({
    method: 'GET',
    path: '/audit-events',
    summary: 'Cursor-paged hash-chained audit log, filtered by action, actor, outcome and target.',
    tag: 'governance',
    response: AuditPageSchema,
    query: [
      {
        name: 'action',
        type: 'string',
        description:
          'Full audit action or a dotted namespace prefix (`auth` matches `auth.session.created`).',
      },
      { name: 'actor', type: 'string', description: 'Actor name or user id, partial match.' },
      {
        name: 'outcome',
        type: 'string',
        description: 'Audit outcome.',
        values: ['success', 'denied', 'failure'],
      },
      { name: 'target', type: 'string', description: 'Target id or label, partial match.' },
      { name: 'cursor', type: 'string', description: 'Opaque cursor from the previous page.' },
      { name: 'limit', type: 'integer', description: 'Page size, default 100, maximum 100.' },
    ],
  }),
  op({
    method: 'GET',
    path: '/audit-events/:seq/proof',
    summary: 'Inclusion proof from the record to the anchored day.',
    tag: 'governance',
    response: AuditProofSchema,
  }),
  op({
    method: 'POST',
    path: '/audit-events/export',
    summary: 'Export a signed audit range.',
    tag: 'governance',
    response: AuditExportSchema,
    request: AuditExportRequestSchema,
  }),
  /** CL-11: "Verify chain" proved the newest row only; this verifies an explicit range. */
  op({
    method: 'POST',
    path: '/audit-events/verify',
    summary: 'Verify the hash chain across an explicit sequence range (CL-11).',
    tag: 'governance',
    response: AuditRangeVerificationSchema,
    request: AuditRangeVerifyRequestSchema,
  }),
  op({
    method: 'GET',
    path: '/licenses',
    summary: 'License register with resale and hosted-service constraints.',
    tag: 'governance',
    response: z.array(LicenseRecordSchema),
  }),
  op({
    method: 'PUT',
    path: '/licenses/:instanceId/hosted-service',
    summary: 'Toggle a hosted-service configuration; restricted licenses are blocked.',
    tag: 'governance',
    response: LicenseGateSchema,
    request: z.object({ enabled: z.boolean() }),
  }),
  op({
    method: 'GET',
    path: '/patch-register',
    summary: 'Patch register with severity and remediation state (AC-44).',
    tag: 'governance',
    response: z.array(PatchRecordSchema),
  }),
  op({
    method: 'GET',
    path: '/posture',
    summary: 'Posture summary: unverified restores, stale metadata, expiring certificates.',
    tag: 'governance',
    response: PostureSummarySchema,
  }),
  op({
    method: 'GET',
    path: '/break-glass-sessions',
    summary: 'Time-boxed break-glass sessions and their state.',
    tag: 'governance',
    response: z.array(BreakGlassSessionSchema),
  }),
  op({
    method: 'POST',
    path: '/break-glass-sessions',
    summary: 'Request a break-glass session with a justification (AC-47).',
    tag: 'governance',
    response: BreakGlassSessionSchema,
    request: z.object({
      instanceId: z.string().min(1),
      accessMode: z.enum(['read_only', 'read_write']),
      justification: z.string().min(1),
    }),
  }),
  /**
   * CL-12 / CL-17: the elevation's in-product credential is revealed once, for
   * `SEAMNEX_REVEAL_TTL_SECONDS`, and the reveal is audited. Declared before `/:id/:action` so the static
   * segment is unambiguous in the generated document.
   */
  op({
    method: 'POST',
    path: '/break-glass-sessions/:id/reveal',
    summary: 'Reveal the elevation credential once; single use, seconds of validity (CL-12).',
    tag: 'governance',
    response: BreakGlassRevealSchema,
  }),
  op({
    method: 'POST',
    path: '/break-glass-sessions/:id/:action',
    summary: 'Approve, reject or revoke a break-glass session.',
    tag: 'governance',
    response: BreakGlassSessionSchema,
  }),
  op({
    method: 'GET',
    path: '/capacity',
    summary: 'Host totals, per-instance ledger and admission verdict.',
    tag: 'governance',
    response: CapacitySnapshotSchema,
  }),
  op({
    method: 'GET',
    path: '/capacity/forecast',
    summary: 'Fourteen-day capacity forecast.',
    tag: 'governance',
    response: z.array(ForecastPointSchema),
  }),

  // Administration
  op({
    method: 'GET',
    path: '/admin/users',
    summary:
      'Directory projection filtered by q, ordered by username and capped at 500 rows per call.',
    tag: 'admin',
    response: z.array(IdpUserSchema),
    query: [
      {
        name: 'q',
        type: 'string',
        description: 'Free-text match on display name, username or e-mail.',
      },
      {
        /*
         * Keyset, not an offset: `username` is the sort key and is unique (the mirror enforces a
         * unique index on `lower(username)`), so a cursor cannot skip or repeat a row the way an
         * offset does while the directory is being synced.
         */
        name: 'after',
        type: 'string',
        description:
          'Keyset cursor: the last `username` of the previous page. Omit for the first page.',
      },
    ],
  }),
  op({
    method: 'GET',
    path: '/admin/users/:id',
    summary: 'One directory user with groups and product roles.',
    tag: 'admin',
    response: IdpUserSchema,
  }),
  op({
    method: 'GET',
    path: '/admin/users/:id/entitlements',
    summary: 'Entitlements enumerated before a disable.',
    tag: 'admin',
    response: UserEntitlementsSchema,
  }),
  op({
    method: 'POST',
    path: '/admin/users/:id/disable',
    summary: 'Disable platform-wide, terminate sessions and record the audit (AC-12).',
    tag: 'admin',
    response: DisableUserResponseSchema,
  }),
  op({
    method: 'GET',
    path: '/admin/groups',
    summary: 'Directory groups and their durable role mappings.',
    tag: 'admin',
    response: z.array(IdpGroupSchema),
  }),
  op({
    method: 'PUT',
    path: '/admin/groups/:id/mapping',
    summary: 'Change a group-to-role mapping; propagation follows within one sync cycle.',
    tag: 'admin',
    response: IdpGroupSchema,
    request: GroupMappingRequestSchema,
  }),
  op({
    method: 'GET',
    path: '/admin/identity-sync',
    summary: 'Identity sync runs and their outcomes.',
    tag: 'admin',
    response: z.array(SyncRunSchema),
  }),
  op({
    method: 'POST',
    path: '/admin/identity-sync/run',
    summary: 'Force a sync cycle.',
    tag: 'admin',
    response: SyncRunSchema,
  }),
  op({
    method: 'GET',
    path: '/admin/settings',
    summary: 'Platform settings with a version ETag.',
    tag: 'admin',
    response: PlatformSettingsSchema,
    etag: true,
  }),
  op({
    method: 'PUT',
    path: '/admin/settings',
    summary: 'Update settings; requires If-Match against the current ETag (412 otherwise).',
    tag: 'admin',
    response: PlatformSettingsSchema,
    request: z.record(z.string(), z.number()),
    conditional: true,
  }),
  op({
    method: 'GET',
    path: '/admin/settings/alerts',
    summary: 'Alert channels and thresholds.',
    tag: 'admin',
    response: z.array(AlertChannelSchema),
  }),
  op({
    method: 'PUT',
    path: '/admin/settings/alerts',
    summary: 'Replace alert channels.',
    tag: 'admin',
    response: z.array(AlertChannelSchema),
    request: AlertChannelsPutSchema,
  }),
  /** CL-06: a saved channel that cannot deliver is a silent gap; this proves it end to end. */
  op({
    method: 'POST',
    path: '/admin/settings/alerts/:id/test',
    summary: 'Send a test delivery through one alert channel (CL-06).',
    tag: 'admin',
    response: AlertTestResultSchema,
  }),
  op({
    method: 'GET',
    path: '/admin/access-requests',
    summary: 'Membership requests awaiting a decision.',
    tag: 'admin',
    response: z.array(AccessRequestSchema),
  }),
  op({
    method: 'POST',
    path: '/admin/access-requests',
    summary: 'Open a membership or entitlement request with a justification (FR-3.13).',
    tag: 'admin',
    response: AccessRequestSchema,
    request: AccessRequestCreateSchema,
  }),
  op({
    method: 'POST',
    path: '/admin/access-requests/:id/:decision',
    summary: 'Approve or reject a membership request (second party only).',
    tag: 'admin',
    response: AccessRequestSchema,
  }),
  op({
    method: 'GET',
    path: '/admin/maintenance-windows',
    summary: 'Maintenance windows and their suppression effect.',
    tag: 'admin',
    response: z.array(MaintenanceWindowSchema),
  }),
  // CL-05: the prototype could only list windows; suppression that cannot be scheduled is not a
  // control. Create, edit and cancel are the three writes a window needs.
  op({
    method: 'POST',
    path: '/admin/maintenance-windows',
    summary: 'Schedule a maintenance window (CL-05).',
    tag: 'admin',
    response: MaintenanceWindowSchema,
    request: MaintenanceWindowCreateRequestSchema,
  }),
  op({
    method: 'PATCH',
    path: '/admin/maintenance-windows/:id',
    summary: 'Move a scheduled maintenance window.',
    tag: 'admin',
    response: MaintenanceWindowSchema,
    request: MaintenanceWindowPatchRequestSchema,
  }),
  op({
    method: 'DELETE',
    path: '/admin/maintenance-windows/:id',
    summary: 'Cancel a maintenance window; alerts stop being suppressed immediately.',
    tag: 'admin',
    noContent: true,
  }),
  op({
    method: 'GET',
    path: '/admin/policy-exceptions',
    summary: 'Policy exceptions awaiting a second-party decision (NFR-4.15).',
    tag: 'admin',
    response: z.array(PolicyExceptionSchema),
  }),
  op({
    method: 'POST',
    path: '/admin/policy-exceptions/:id/:decision',
    summary: 'Approve or reject a policy exception.',
    tag: 'admin',
    response: PolicyExceptionSchema,
  }),
  op({
    method: 'GET',
    path: '/admin/dsar',
    summary: 'Data-subject request queue by pseudonymous reference.',
    tag: 'admin',
    response: z.array(DsarRequestSchema),
  }),

  // Recovery
  op({
    method: 'GET',
    path: '/recovery',
    summary: 'Platform backup contents, restore runs and drill state.',
    tag: 'recovery',
    response: RecoveryOverviewSchema,
  }),
  /** CL-20: the edge and the sign-in page only need the gate; the overview is too heavy to poll. */
  op({
    method: 'GET',
    path: '/platform/restore-status',
    summary: 'Restore phase and gate state for polling (CL-20).',
    tag: 'recovery',
    response: PlatformRestoreStatusSchema,
  }),
  op({
    method: 'POST',
    path: '/recovery/backups',
    summary: 'Create a platform-state backup including the IdP realm (202: job hand-off).',
    tag: 'recovery',
    response: JobAcceptedSchema,
    accepted: true,
  }),
  op({
    method: 'POST',
    path: '/recovery/restores',
    summary: 'Start the IdP-first restore sequence (FR-1.36, AC-30); 202 while it runs.',
    tag: 'recovery',
    response: JobAcceptedSchema,
    request: RestoreStartSchema,
    accepted: true,
  }),
  op({
    method: 'POST',
    path: '/restore-drills',
    summary: 'Schedule a restore drill for an instance.',
    tag: 'recovery',
    response: RestoreDrillSchema,
    request: z.object({ instanceId: z.string().min(1) }),
  }),

  // Privacy
  op({
    method: 'GET',
    path: '/privacy/requests',
    summary: 'Export and erasure queue with per-scope progress.',
    tag: 'privacy',
    response: PrivacyQueueSchema,
  }),
  op({
    method: 'POST',
    path: '/privacy/requests',
    summary: 'Open a data-subject export or erasure request.',
    tag: 'privacy',
    response: PrivacyRequestSchema,
    request: PrivacyRequestCreateSchema,
  }),
  op({
    method: 'POST',
    path: '/privacy/requests/:id/advance',
    summary: 'Advance a request to the next scope or terminal state.',
    tag: 'privacy',
    response: PrivacyRequestSchema,
  }),

  // Integration registry
  op({
    method: 'GET',
    path: '/registry/instances',
    summary: 'Machine-readable integration inventory per instance (AC-41).',
    tag: 'registry',
    response: z.array(RegistryEntrySchema),
  }),
  op({
    method: 'GET',
    path: '/registry/instances/:slug',
    summary: 'One registry entry with operations, events and credential scopes.',
    tag: 'registry',
    response: RegistryEntrySchema,
    consumer: 'external',
  }),
  op({
    method: 'GET',
    path: '/registry/stale',
    summary: 'Entries whose verified metadata is past review.',
    tag: 'registry',
    response: z.array(RegistryEntrySchema),
  }),
  /**
   * CL-07: the canvas needs the operations a target actually exposes; without this endpoint an
   * author types a URL, which is exactly what FR-5.2 forbids.
   */
  op({
    method: 'GET',
    path: '/registry/operations',
    summary: 'Discovered operations and event modes for one registry target (CL-07).',
    tag: 'registry',
    response: OperationsResponseSchema,
    query: [
      {
        name: 'target',
        type: 'string',
        description: 'Instance id, slug or catalog entry key.',
        required: true,
      },
    ],
  }),
];

/**
 * Attaches the policy key. A declared operation with no entry in `POLICY_KEYS` throws while the
 * registry module is loaded, which fails every build, test and boot that touches the contract
 * (deliverable 3.4: a route without a policy key fails the build).
 */
export const API_OPERATIONS: readonly ApiOperation[] = DECLARED_OPERATIONS.map((operation) => {
  const key = operationKey(operation);
  const policyKey = POLICY_KEYS[key];
  if (policyKey === undefined) {
    throw new Error(`Operation ${key} has no policy key; add it to packages/domain/src/policy.ts`);
  }
  const policyAnyOf = ANY_OF_POLICY_KEYS[key];
  return policyAnyOf === undefined
    ? { ...operation, policyKey }
    : { ...operation, policyKey, policyAnyOf };
});

export function operationKey(operation: Pick<ApiOperation, 'method' | 'path'>): string {
  return `${operation.method} ${operation.path}`;
}

export const OPERATION_KEYS: ReadonlySet<string> = new Set(API_OPERATIONS.map(operationKey));

export type JsonSchema = Record<string, unknown>;

/** Zod-to-JSON-Schema conversion; never throws during document generation. */
export function jsonSchemaFor(schema: z.ZodType): JsonSchema {
  try {
    return z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'output',
      unrepresentable: 'any',
    }) as JsonSchema;
  } catch {
    return { description: 'This contract could not be expressed as JSON Schema.' };
  }
}

const PROBLEM_RESPONSE = {
  description: 'application/problem+json',
  content: {
    'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } },
  },
};

export type OpenApiDocument = {
  openapi: string;
  info: Record<string, unknown>;
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, JsonSchema> };
};

/**
 * The version recorded in the OpenAPI document: the workspace copy of the last released version,
 * `0.0.0` before the first release.
 *
 * `docs/openapi.json` is committed, and two tests assert that the document served by
 * `GET /api/v1/openapi.json` is byte-identical to it. The copy therefore moves in one commit with
 * its own regeneration — `scripts/bump-version.mjs` writes this constant, `version-bump.yml` runs
 * the generator — and `pnpm check:version` fails while the three disagree. The running release is
 * reported by `GET /api/v1/healthz` (`version`, `revision`) and by the image's OCI labels, so a
 * deployment built from a tag answers with that tag whatever a checkout carries. The compatibility
 * boundary is `/api/v1` in the path, not this field.
 *
 * `pnpm check:version` fails if a literal replaces this constant.
 */
export const CONTRACT_DOCUMENT_VERSION = '0.0.0';

/**
 * Builds the OpenAPI 3.1 document from the shared contracts.
 * `z.toJSONSchema` runs at generation time, so a schema that cannot be expressed is
 * reported instead of silently producing a wrong document.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of API_OPERATIONS) {
    const path = operation.path.replace(/:(\w+)/g, '{$1}');
    const parameters = [
      ...[...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
        name: match[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      ...(operation.query ?? []).map((query) => ({
        name: query.name,
        in: 'query',
        required: query.required ?? false,
        description: query.description,
        schema: {
          type: query.type,
          ...(query.values === undefined ? {} : { enum: [...query.values] }),
          ...(query.prefix === true ? { 'x-prefix': true } : {}),
        },
      })),
    ];

    const successContent =
      operation.contentType === 'text/event-stream'
        ? { 'text/event-stream': { schema: { type: 'string' } } }
        : { 'application/json': { schema: jsonSchemaFor(operation.response ?? z.unknown()) } };

    const success = operation.noContent
      ? { '204': { description: 'No content; the operation succeeded without a body.' } }
      : {
          [operation.accepted ? '202' : '200']: {
            description: operation.accepted ? 'Accepted; poll the job link.' : 'Success.',
            // The validator a later `If-Match` replays. A read that publishes none leaves the
            // paired conditional write with nothing to send, so it is part of the document.
            ...(operation.etag === true
              ? {
                  headers: {
                    ETag: {
                      description:
                        'Validator of this representation; replay it as `If-Match` on a write.',
                      schema: { type: 'string' },
                    },
                  },
                }
              : {}),
            content: successContent,
          },
        };

    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = {
      operationId: `${operation.method.toLowerCase()}-${path.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')}`,
      summary: operation.summary,
      tags: [operation.tag],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(operation.request
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: jsonSchemaFor(operation.request) } },
            },
          }
        : {}),
      ...(operation.consumer === 'external' ? { 'x-consumer': 'external' } : {}),
      'x-policy-key': operation.policyKey,
      ...(operation.anonymous ? { 'x-anonymous': true } : {}),
      ...(operation.rateLimit ? { 'x-rate-limit': operation.rateLimit } : {}),
      responses: {
        ...success,
        '400': PROBLEM_RESPONSE,
        '401': PROBLEM_RESPONSE,
        '403': PROBLEM_RESPONSE,
        '404': PROBLEM_RESPONSE,
        '409': PROBLEM_RESPONSE,
        ...(operation.conditional ? { '412': PROBLEM_RESPONSE } : {}),
        '422': PROBLEM_RESPONSE,
        ...(operation.rateLimit ? { '429': PROBLEM_RESPONSE } : {}),
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Seamnex API',
      version: CONTRACT_DOCUMENT_VERSION,
      description:
        'Seamnex — self-hosted FOSS domain platform. Generated from packages/domain/src/contract.ts. Authorization is deny-by-default against the §5.2 capability matrix; every denied request writes an access.denied audit record. Long operations answer 202 and are polled through the returned job link, or streamed through /jobs/{id}/stream.',
    },
    servers: [{ url: '/api/v1' }],
    paths,
    components: {
      schemas: {
        ProblemDetail: jsonSchemaFor(
          z.object({
            type: z.string(),
            title: z.string(),
            status: z.number().int(),
            detail: z.string(),
            code: z.string(),
            fieldErrors: z.array(
              z.object({ field: z.string(), code: z.string(), message: z.string() }),
            ),
            remediation: z.string(),
          }),
        ),
      },
    },
  };
}
