/** Shared enumerations transcribed from the platform requirements and system design. */

export const PLATFORM_ROLES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** FR-2.16 guarantee classes. Only native, fa_header and fa_delegated may be called SSO. */
export const GUARANTEE_CLASSES = ['native', 'fa_header', 'fa_delegated', 'fa_gate'] as const;
export type GuaranteeClass = (typeof GUARANTEE_CLASSES)[number];

export const AUTH_MODES = ['native', 'fa_header', 'fa_delegated', 'fa_gate'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * What actually happens when the user opens the product, as opposed to what the catalog claims. A
 * `native` entry whose identity client was never registered launches a sign-in prompt, and a tile
 * that says "single sign-on" for it is wrong before the user clicks.
 *
 * `sso_unverified` is the third case, and it is the one that was missing. A registered identity
 * client is not a working login: the client can be registered while the product cannot reach the
 * token endpoint (the IdP was re-created and lost its attachment to the instance network), and the
 * label then promised a single redirect for a flow that fails after the browser has already been
 * redirected back. A shape that has been registered but not proven by a recent end-to-end check is
 * reported as unverified rather than as working.
 */
export const SSO_STATES = ['sso', 'sso_unverified', 'sign_in_required'] as const;
export type SsoState = (typeof SSO_STATES)[number];

export const PACKAGING_KINDS = ['compose', 'dockerfile', 'none'] as const;
export type PackagingKind = (typeof PACKAGING_KINDS)[number];

export const DOMAIN_CLUSTERS = [
  'Revenue & Customer',
  'Core Operations',
  'Enabling Platform',
] as const;
export type DomainCluster = (typeof DOMAIN_CLUSTERS)[number];

export const INSTANCE_STATES = [
  'requested',
  'validating',
  'resolving',
  'building',
  'rendering',
  'planned',
  'deploying',
  'integrating',
  'verifying',
  'ready',
  'degraded',
  'failed',
  'rolling_back',
  'upgrading',
  'stopping',
  'stopped',
  'starting',
  'restarting',
  'deleting',
  'deleted',
] as const;
export type InstanceState = (typeof INSTANCE_STATES)[number];

export const DESIRED_STATES = ['running', 'stopped'] as const;
export type DesiredState = (typeof DESIRED_STATES)[number];

/** Plain-language portal states (FR-3.7). Maintenance is layered on top. */
export const PLAIN_STATUSES = ['available', 'degraded', 'unavailable', 'maintenance'] as const;
export type PlainStatus = (typeof PLAIN_STATUSES)[number];

export const SERVICE_ROLES = ['primary', 'database', 'cache', 'search', 'worker'] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

export const CONTAINER_STATES = [
  'created',
  'running',
  'paused',
  'restarting',
  'exited',
  'dead',
] as const;
export type ContainerState = (typeof CONTAINER_STATES)[number];

export const HEALTH_STATUSES = ['healthy', 'unhealthy', 'starting', 'none'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const JOB_KINDS = [
  'deploy',
  /**
   * Re-render and re-apply the current definition, without changing the version. This is how an
   * environment change that "requires recreate" is actually applied (FR-1.28): without it the
   * values were stored and the containers kept the old ones forever.
   */
  'reconfigure',
  /** FR-1.21: the Dockerfile path builds an image before the container starts. */
  'build',
  'start',
  'stop',
  'restart',
  'upgrade',
  'rollback',
  'delete',
  'backup',
  'restore',
  'export',
  'prepull',
  'scaffold',
  /**
   * Kinds the writer roles already persist. They were missing here, so `JobQueryService`
   * projected them as `deploy` — a platform restore showed up in the jobs list as a deploy.
   * The list must stay a superset of `deployment_job_kind_check`.
   */
  'verify',
  'dsar',
  'platform-backup',
  'platform-restore',
  'synthetic',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JOB_STEP_STATES = ['pending', 'running', 'succeeded', 'failed', 'skipped'] as const;
export type JobStepState = (typeof JOB_STEP_STATES)[number];

export const LOG_STREAMS = ['system', 'stdout', 'stderr'] as const;
export type LogStream = (typeof LOG_STREAMS)[number];

export const ENV_TYPES = ['string', 'integer', 'boolean', 'enum', 'url', 'secret'] as const;
export type EnvType = (typeof ENV_TYPES)[number];

export const ENV_SOURCES = ['default', 'profile', 'instance', 'secret'] as const;
export type EnvSource = (typeof ENV_SOURCES)[number];

export const OVERRIDE_CEILINGS = ['none', 'profile_only', 'profile_and_instance'] as const;
export type OverrideCeiling = (typeof OVERRIDE_CEILINGS)[number];

export const ENTITLEMENT_SYNC_STATES = ['applied', 'pending', 'edge_only', 'unsupported'] as const;
export type EntitlementSyncState = (typeof ENTITLEMENT_SYNC_STATES)[number];

export const CREDENTIAL_GRANULARITIES = ['scoped', 'account', 'none'] as const;
export type CredentialGranularity = (typeof CREDENTIAL_GRANULARITIES)[number];

export const LIFECYCLE_ACTIONS = [
  'start',
  'stop',
  'restart',
  'reconfigure',
  'upgrade',
  'rollback',
  'delete',
  'export',
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export const WORKFLOW_STATES = ['draft', 'validated', 'active', 'disabled', 'failed'] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const RUN_STATES = ['queued', 'running', 'succeeded', 'failed', 'waiting_approval'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TRIGGERS = ['webhook', 'schedule', 'poll', 'manual'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const WORKFLOW_NODE_KINDS = [
  'trigger',
  'action',
  'condition',
  'mapping',
  'approval',
] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export const OPERATION_MODES = ['read', 'write'] as const;
export type OperationMode = (typeof OPERATION_MODES)[number];

/**
 * The verb a **product** operation is called with.
 *
 * `mode` is a policy attribute ("may this workflow write?"), not an HTTP verb: an upsert is a POST,
 * an update a PATCH, and reading a single record a GET on a path that carries its id. Deriving the
 * verb from `mode` made every write a POST and every read a GET on the collection root. Named apart
 * from `OperationMethod` in `contract.ts`, which is the verb of *this* API's own endpoints.
 */
export const PRODUCT_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ProductHttpMethod = (typeof PRODUCT_HTTP_METHODS)[number];

export const ACCESS_MODES = ['read_only', 'read_write'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const BREAK_GLASS_STATES = [
  'requested',
  'approved',
  'rejected',
  'active',
  'expired',
  'revoked',
] as const;
export type BreakGlassState = (typeof BREAK_GLASS_STATES)[number];

export const RESTORE_PHASES = [
  'preparing',
  'idp',
  'control_plane',
  'login_verified',
  'products',
  'verify',
  'complete',
  'failed',
] as const;
export type RestorePhase = (typeof RESTORE_PHASES)[number];

export const BACKUP_STATES = ['running', 'succeeded', 'failed'] as const;
export type BackupState = (typeof BACKUP_STATES)[number];

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ACCESS_REQUEST_KINDS = ['entitlement', 'membership', 'instance_param'] as const;
export type AccessRequestKind = (typeof ACCESS_REQUEST_KINDS)[number];

export const ACCESS_REQUEST_STATES = ['open', 'approved', 'rejected', 'expired'] as const;
export type AccessRequestState = (typeof ACCESS_REQUEST_STATES)[number];

export const SCENARIOS = [
  'healthy',
  'degraded',
  'maintenance',
  'policy-exception',
  'empty',
  'offline',
] as const;
export type Scenario = (typeof SCENARIOS)[number];
