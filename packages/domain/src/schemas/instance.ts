import { z } from 'zod';
import {
  CONTAINER_STATES,
  DESIRED_STATES,
  HEALTH_STATUSES,
  INSTANCE_STATES,
  PLAIN_STATUSES,
  SERVICE_ROLES,
} from '../enums';
import { EntryKeySchema, IdSchema, NamedRefSchema, SlugSchema, TimestampSchema } from './common';
import { JobLogLineSchema } from './job';
import { EventModeSchema, ResourceShapeSchema } from './catalog';

export const SourceResolutionSchema = z.object({
  path: z.enum(['compose', 'dockerfile', 'scaffold']),
  sourceUrl: z.string().min(1),
  sourceRevision: z.string().min(1),
  resolvedImageRef: z.string().min(1),
  policyVerdict: z.enum(['compliant', 'exception-approved', 'violations']),
  policyNotes: z.array(z.string()),
  resolvedAt: TimestampSchema,
});

export const InstanceRouteSchema = z.object({
  host: z.string().min(1),
  pathPrefix: z.string().min(1),
  publishModel: z.enum(['subdomain', 'subpath']),
  tlsMode: z.enum(['acme', 'internal']),
  authMode: z.enum(['native', 'fa_header', 'fa_delegated', 'fa_gate']),
  published: z.boolean(),
});

export const InstanceServiceSchema = z.object({
  id: IdSchema,
  serviceName: z.string().min(1),
  role: z.enum(SERVICE_ROLES),
  imageRef: z.string().min(1),
  imageDigest: z.string().min(1),
  internalUrl: z.string().min(1),
});

export const InstanceVolumeSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  mountPath: z.string().min(1),
  quotaMb: z.number().int().positive(),
  usedMb: z.number().int().nonnegative(),
});

export const InstanceUsageSchema = z.object({
  cpuPercent: z.number().min(0).max(100),
  memoryMb: z.number().nonnegative(),
  diskMb: z.number().nonnegative(),
});

export const MaintenanceStateSchema = z.object({
  active: z.boolean(),
  windowId: IdSchema.nullable(),
  title: z.string().min(1),
  startsAt: TimestampSchema,
  endsAt: TimestampSchema,
});

export const BackupPostureSchema = z.object({
  lastSuccessAt: TimestampSchema.nullable(),
  lastVerifiedRestoreAt: TimestampSchema.nullable(),
  schedule: z.string().min(1),
  /** IANA zone the schedule is expressed in; times are stored in UTC. */
  scheduleTimezone: z.string().min(1),
  scheduleEnabled: z.boolean(),
  verified: z.boolean(),
});

/** FR-1.12: scheduled and on-demand backups. The schedule is editable per instance. */
export const BackupScheduleRequestSchema = z.object({
  schedule: z.string().min(1),
  timezone: z.string().min(1),
  enabled: z.boolean(),
});

/** FR-1.6/FR-1.13: delete carries an explicit data-retention choice. */
export const LifecycleActionRequestSchema = z.object({
  dataRetention: z.enum(['keep', 'export', 'delete']).optional(),
  /** Upgrade target; omitted means "the version pinned in the catalog". */
  version: z.string().min(1).optional(),
  justification: z.string().min(1).optional(),
});

export const InstanceSchema = z.object({
  id: IdSchema,
  slug: SlugSchema,
  entryKey: EntryKeySchema,
  entryKeys: z.array(EntryKeySchema),
  domain: z.string().min(1),
  product: z.string().min(1),
  description: z.string().min(1),
  domainRoute: z.string().min(1),
  profileKey: z.string().min(1),
  state: z.enum(INSTANCE_STATES),
  desiredState: z.enum(DESIRED_STATES),
  ready: z.boolean(),
  statusSource: z.enum(['poll', 'push', 'manual']),
  observedAt: TimestampSchema,
  stateReason: z.string().nullable(),
  owner: NamedRefSchema,
  domainOwner: NamedRefSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  currentVersion: z.string().min(1),
  availableVersion: z.string().nullable(),
  imageDigest: z.string().min(1),
  source: SourceResolutionSchema,
  route: InstanceRouteSchema,
  resources: ResourceShapeSchema,
  usage: InstanceUsageSchema,
  maintenance: MaintenanceStateSchema.nullable(),
  backup: BackupPostureSchema,
  /** Event modes this product actually exposes (FR-2.14), rendered as trigger badges. */
  eventModes: z.array(EventModeSchema),
  licenseId: z.string().min(1),
  licenseRestricted: z.boolean(),
  integrationVerified: z.boolean(),
  metadataStale: z.boolean(),
});

/** FR-3.7 mapping: derived state, never container detail. */
export const InstanceStatusSchema = z.object({
  instanceId: IdSchema,
  state: z.enum(INSTANCE_STATES),
  plainStatus: z.enum(PLAIN_STATUSES),
  ready: z.boolean(),
  reason: z.string().nullable(),
  observedAt: TimestampSchema,
  source: z.enum(['poll', 'push', 'manual']),
  containersRunning: z.number().int().nonnegative(),
  containersTotal: z.number().int().nonnegative(),
  maintenance: MaintenanceStateSchema.nullable(),
});

export const ContainerStatusSchema = z.object({
  containerId: IdSchema,
  service: z.string().min(1),
  role: z.enum(SERVICE_ROLES),
  state: z.enum(CONTAINER_STATES),
  health: z.enum(HEALTH_STATUSES),
  restartCount: z.number().int().nonnegative(),
  startedAt: TimestampSchema.nullable(),
  exitCode: z.number().int().nullable(),
  exitReason: z.string().nullable(),
  imageDigest: z.string().min(1),
  observedAt: TimestampSchema,
});

export const EnvValueSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().min(1),
  type: z.string().min(1),
  secret: z.boolean(),
  value: z.string().nullable(),
  masked: z.boolean(),
  source: z.enum(['default', 'profile', 'instance', 'secret']),
  overrideCeiling: z.enum(['none', 'profile_only', 'profile_and_instance']),
  appliedAt: TimestampSchema,
  requiresRecreate: z.boolean(),
  drift: z.boolean(),
});

export const DriftRecordSchema = z.object({
  id: IdSchema,
  varName: z.string().min(1),
  declared: z.string().nullable(),
  observed: z.string().nullable(),
  kind: z.enum(['missing', 'undeclared', 'mismatch']),
  detectedAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
});

export const IntegrationCheckSchema = z.object({
  // `relay_login` is not `sso_login`: a relayed password sign-in is evidence of the relay working,
  // never evidence of single sign-on (ADR-BE-22).
  check: z.enum([
    'http',
    'sso_login',
    'dns',
    'backup_registered',
    'webhook_registered',
    'relay_login',
  ]),
  label: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().min(1),
  checkedAt: TimestampSchema,
});

export const InstanceDetailSchema = InstanceSchema.extend({
  services: z.array(InstanceServiceSchema),
  volumes: z.array(InstanceVolumeSchema),
  integrationChecks: z.array(IntegrationCheckSchema),
});

/** Built or pulled image retained for rollback (AC-22). */
export const ImageSchema = z.object({
  digest: z.string().min(1),
  version: z.string().min(1),
  state: z.enum(['current', 'previous', 'available', 'pinned']),
  builtAt: TimestampSchema,
  artefact: z.string().min(1),
});

export const InstancePlanSchema = z.object({
  action: z.string().min(1),
  instanceId: IdSchema,
  from: z.string().min(1),
  to: z.string().min(1),
  changes: z.array(z.object({ field: z.string().min(1), from: z.string(), to: z.string() })),
  preUpgradeBackup: z.boolean(),
  capacityVerdict: z.object({
    admissible: z.boolean(),
    headline: z.string().min(1),
    detail: z.string().min(1),
  }),
  rollbackAvailable: z.boolean(),
});

/** Render diff returned by a post-deployment environment change (AC-28). */
export const EnvUpdateResponseSchema = z.object({
  diff: z.array(
    z.object({
      name: z.string().min(1),
      from: z.string().nullable(),
      to: z.string().nullable(),
      requiresRecreate: z.boolean(),
    }),
  ),
  requiresRecreate: z.boolean(),
  applied: z.boolean(),
  note: z.string().min(1),
});

/**
 * ADR-BE-22 — the product administrator token the relay provisions accounts with.
 *
 * `kind` describes how *this entry* provisions, not what is stored: a `password` entry signs in with
 * the administrator login its installer created and needs no token, and `none` has no provisioning
 * adapter at all. No projection carries the token itself — `configured` and `version` are the whole
 * read model, so a client has no field in which to echo it.
 */
export const AdminCredentialSchema = z.object({
  kind: z.enum(['bearer', 'password', 'none']),
  /** True only for a `bearer` entry: the token is the one credential the platform cannot derive. */
  required: z.boolean(),
  configured: z.boolean(),
  /** The secret name the relay looks up; shown so an operator can match it in the store. */
  name: z.string().min(1),
  version: z.number().int().nonnegative().nullable(),
});

/** Minimum length only: the product, not the platform, decides what a valid token looks like. */
export const AdminCredentialRequestSchema = z.object({
  token: z.string().trim().min(8).max(4096),
});

/**
 * ADR-BE-22 — what an on-demand provisioning pass did.
 *
 * Counts, never an account name or a credential: the route exists so an operator can tell "nothing
 * needed doing" from "nothing was allowed to be done" without reading the scheduler's log, and so a
 * deployment that never opted into the relay reads as `enabled: false` rather than as a failure.
 * The per-candidate reason stays in the audit chain, where it can be read in context.
 */
export const RelayProvisionReportSchema = z.object({
  instanceId: IdSchema,
  enabled: z.boolean(),
  /**
   * False when no entry is allow-listed: the relay is on, and no pass can ever select a candidate.
   * Without it, "nobody is entitled" and "nobody configured this" are the same five zeros.
   */
  configured: z.boolean(),
  /** People the pass selected: entitled, enabled in the IdP, allow-listed by entry, product ready. */
  considered: z.number().int().nonnegative(),
  provisioned: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export type RelayProvisionReport = z.infer<typeof RelayProvisionReportSchema>;

/** Container logs share the job-log line shape so one viewer can render both. */
export const ContainerLogListSchema = z.array(JobLogLineSchema);
export const InstanceListSchema = z.array(InstanceSchema);

/**
 * 4A.7 / CL-09: the wizard asks the server for the admission verdict instead of computing it in the
 * browser. The request mirrors `POST /instances` on purpose: a preview that accepts a different
 * shape than the deploy it previews is a second contract.
 */
export const DeployPreviewRequestSchema = z.object({
  entryKey: EntryKeySchema,
  slug: SlugSchema,
  profile: z.string().min(1).optional(),
  resources: z
    .object({
      cpu: z.number().positive(),
      memoryMb: z.number().positive(),
      diskMb: z.number().positive(),
    })
    .optional(),
  envOverrides: z.record(z.string(), z.string()).optional(),
});

export const ResourceShortfallSchema = z.object({
  cpuMilli: z.number().int().nonnegative(),
  memoryMb: z.number().int().nonnegative(),
  diskMb: z.number().int().nonnegative(),
});

export const DeployPreviewSchema = z.object({
  admissible: z.boolean(),
  headline: z.string().min(1),
  detail: z.string().min(1),
  shortfall: ResourceShortfallSchema,
  /** Where the numbers came from; an estimate is labelled rather than presented as measured. */
  capacitySource: z.enum(['measured', 'snapshot', 'unknown']),
  routeHost: z.string().min(1),
  slugAvailable: z.boolean(),
  policyVerdict: z.enum(['allowed', 'blocked', 'unsafe_approved']),
  warnings: z.array(z.string().min(1)),
  evaluatedAt: TimestampSchema,
});

export type Instance = z.infer<typeof InstanceSchema>;
export type InstanceDetail = z.infer<typeof InstanceDetailSchema>;
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;
export type ContainerStatus = z.infer<typeof ContainerStatusSchema>;
export type SourceResolution = z.infer<typeof SourceResolutionSchema>;
export type InstanceRoute = z.infer<typeof InstanceRouteSchema>;
export type EnvValue = z.infer<typeof EnvValueSchema>;
export type AdminCredential = z.infer<typeof AdminCredentialSchema>;
export type DriftRecord = z.infer<typeof DriftRecordSchema>;
export type IntegrationCheck = z.infer<typeof IntegrationCheckSchema>;
export type InstanceService = z.infer<typeof InstanceServiceSchema>;
export type InstanceVolume = z.infer<typeof InstanceVolumeSchema>;
export type InstancePlan = z.infer<typeof InstancePlanSchema>;
export type BackupPosture = z.infer<typeof BackupPostureSchema>;
export type MaintenanceState = z.infer<typeof MaintenanceStateSchema>;
export type DeployPreview = z.infer<typeof DeployPreviewSchema>;
export type DeployPreviewRequest = z.infer<typeof DeployPreviewRequestSchema>;
export type ResourceShortfall = z.infer<typeof ResourceShortfallSchema>;
