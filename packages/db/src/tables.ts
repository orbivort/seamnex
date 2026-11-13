/**
 * Row shapes for the tables the control plane reads directly.
 *
 * These are hand-written on purpose (ADR-BE-04): a generated type would be a second schema, and
 * the first schema — the SQL — is the one reviewers can read. Columns that are nullable in the
 * database are optional here, so a consumer must handle the absent case.
 */

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobStepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type LogStream = 'system' | 'stdout' | 'stderr';

export type DeploymentJobRow = {
  id: string;
  instance_id: string | null;
  lane: string;
  kind: string;
  state: JobState;
  idempotency_key: string | null;
  requested_by: string | null;
  error_code: string | null;
  error_detail: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

export type JobStepRow = {
  job_id: string;
  seq: number;
  name: string;
  state: JobStepState;
  started_at: Date | null;
  finished_at: Date | null;
  message: string | null;
};

export type JobLogRow = {
  id: string;
  job_id: string;
  seq: number;
  ts: Date;
  stream: LogStream;
  line: string;
};

export type AuditOutcome = 'success' | 'failure' | 'denied';
export type AuditActorType = 'user' | 'service' | 'system';

export type AuditEventRow = {
  id: string;
  seq: string;
  ts: Date;
  actor_type: AuditActorType;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  outcome: AuditOutcome;
  detail: Record<string, unknown>;
  request_id: string | null;
  prev_hash: string;
  hash: string;
};

export type OutboxRow = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  claimed_at: Date | null;
  dispatched_at: Date | null;
  attempts: number;
  last_error: string | null;
};

export type SettingRow = {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: Date;
};

export type SecretRow = {
  id: string;
  /** `product_account` is one user's credential for one product instance (ADR-BE-22). */
  scope: 'instance' | 'idp_client' | 'workflow' | 'platform' | 'product_account';
  owner_id: string;
  name: string;
  created_at: Date;
};

export type SecretVersionRow = {
  id: string;
  secret_id: string;
  version: number;
  dek_id: string;
  dek_wrapped: Buffer;
  ciphertext: Buffer;
  aad: string;
  rotated_at: Date;
  created_by: string | null;
};

export type InstanceRow = {
  id: string;
  entry_key: string;
  slug: string;
  domain_route: string;
  profile_key: string | null;
  state: string;
  desired_state: 'running' | 'stopped';
  source_path: 'compose' | 'dockerfile' | 'scaffold' | null;
  owner_user_id: string | null;
  node_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

/* ------------------------------------------------------------------------------------------------
 * Phase 2 read models (ADR-BE-09). Same policy: one hand-written shape per table, nullable
 * columns optional, timestamps as `Date` because the pool parses `timestamptz`. `bigint` columns
 * arrive as strings — `pg` does not widen int8 to JS number.
 * ---------------------------------------------------------------------------------------------- */

export type CatalogEntryRow = {
  key: string;
  domain: string;
  product: string;
  repo_url: string | null;
  license_id: string | null;
  guarantee_class: 'native' | 'fa_header' | 'fa_delegated' | 'fa_gate';
  packaging: 'compose' | 'dockerfile' | 'none';
  primary_instance_id: string | null;
  cluster: string | null;
  created_at: Date;
  updated_at: Date;
};

export type CatalogRevisionRow = {
  id: string;
  entry_key: string;
  git_sha: string;
  content_hash: string;
  loaded_at: Date;
};

export type EnvSchemaVarRow = {
  entry_key: string;
  name: string;
  type: 'string' | 'integer' | 'boolean' | 'enum' | 'url' | 'secret';
  required: boolean;
  default_value: string | null;
  constraint_text: string | null;
  conditional: boolean;
  secret: boolean;
  override_ceiling: 'none' | 'profile_only' | 'profile_and_instance';
  description: string | null;
};

export type EnvProfileRow = {
  key: string;
  target: 'production' | 'staging';
  updated_by: string | null;
  updated_at: Date;
};

export type EnvProfileValueRow = {
  profile_key: string;
  var_name: string;
  value_enc: Buffer | null;
  secret_ref: string | null;
  updated_at: Date;
};

export type InstanceServiceRow = {
  instance_id: string;
  service_name: string;
  role: 'primary' | 'database' | 'cache' | 'search' | 'worker';
  image_ref: string;
  image_digest: string | null;
  internal_url: string | null;
};

export type InstanceVolumeRow = {
  instance_id: string;
  name: string;
  mount_path: string;
  host_path: string | null;
  quota_mb: number | null;
};

export type InstanceParamRow = {
  instance_id: string;
  git_sha: string | null;
  content_hash: string;
  params: Record<string, unknown>;
  read_at: Date;
};

export type SourceResolutionRow = {
  id: string;
  instance_id: string;
  path: 'compose' | 'dockerfile' | 'scaffold';
  source_url: string | null;
  source_revision: string | null;
  resolved_image_ref: string | null;
  resolved_image_digest: string | null;
  policy_verdict: 'allowed' | 'blocked' | 'unsafe_approved' | null;
  created_at: Date;
};

export type InstanceEnvValueRow = {
  instance_id: string;
  var_name: string;
  source: 'default' | 'profile' | 'instance' | 'secret';
  value_enc: Buffer | null;
  secret_ref: string | null;
  applied_render_set_id: string | null;
  resolved_at: Date;
};

export type InstanceStatusRow = {
  instance_id: string;
  state: string;
  ready: boolean;
  observed_at: Date;
  source: string;
  reason: string | null;
};

export type ContainerStatusRow = {
  instance_id: string;
  container_id: string;
  service: string;
  state: string;
  health: string;
  restart_count: number;
  started_at: Date | null;
  exit_code: number | null;
  exit_reason: string | null;
  image_digest: string | null;
  observed_at: Date;
};

export type DriftRecordRow = {
  id: string;
  scope: string;
  instance_id: string | null;
  expected_hash: string | null;
  observed_hash: string | null;
  direction: 'repo_ahead' | 'runtime_ahead' | 'unknown';
  detail: Record<string, unknown>;
  detected_at: Date;
  resolved_at: Date | null;
};

export type BackupRow = {
  id: string;
  kind: 'instance' | 'platform';
  instance_id: string | null;
  render_set_id: string | null;
  state: string;
  started_at: Date;
  finished_at: Date | null;
  size_bytes: string | null;
  object_key: string | null;
  manifest: Record<string, unknown>;
  verified_at: Date | null;
  verify_method: string | null;
  error_code: string | null;
};

export type ImageArtefactRow = {
  id: string;
  instance_id: string;
  image_digest: string;
  source_revision: string | null;
  size_bytes: string | null;
  object_key: string;
  manifest: Record<string, unknown>;
  created_at: Date;
};

export type EntitlementRow = {
  id: string;
  subject_idp_id: string;
  instance_id: string;
  product_role: string;
  source: 'group' | 'direct';
  sync_state: 'applied' | 'pending' | 'edge_only' | 'unsupported';
  synced_at: Date;
};

/**
 * ADR-BE-22: one platform subject's account on one product instance, and the secret that holds its
 * password. The row exists so the relay never has to guess a login, and so offboarding has something
 * to delete besides the product-side account it can no longer authenticate to.
 */
export type ProductAccountRow = {
  id: string;
  instance_id: string;
  subject_idp_id: string;
  login: string;
  /** `secret.id`; no foreign key, matching every other credential reference in this schema. */
  secret_ref: string;
  state: 'pending' | 'active' | 'disabled' | 'failed';
  last_error: string | null;
  attempt: number;
  /**
   * Consecutive `credential_rejected` outcomes (0026). The relay stops attempting after a bounded
   * number so a broken credential cannot walk a person into the product's brute-force lock.
   */
  consecutive_failures: number;
  created_at: Date;
  updated_at: Date;
  provisioned_at: Date | null;
  rotated_at: Date | null;
};

export type InstanceRouteRow = {
  instance_id: string;
  host: string;
  path_prefix: string | null;
  publish_model: string;
  tls_mode: string;
  auth_mode: 'native' | 'fa_header' | 'fa_delegated' | 'fa_gate';
  published: boolean;
  /** 4C.4: a gated route projects no router at all until the gate opens. */
  gated: boolean;
  updated_at: Date;
};

export type BackupScheduleRow = {
  instance_id: string;
  cadence: 'off' | 'daily' | 'weekly' | 'monthly';
  hour_utc: number;
  weekday: number | null;
  timezone: string;
  retention_days: number;
  next_run_at: Date | null;
  updated_by: string | null;
  updated_at: Date;
};

export type IntegrationMetadataRow = {
  instance_id: string;
  entry_key: string;
  api_base_url: string | null;
  auth_method: string | null;
  guarantee_class_verified: 'native' | 'fa_header' | 'fa_delegated' | 'fa_gate' | null;
  operation_inventory: unknown;
  event_modes: unknown;
  credential_granularity: 'scoped' | 'account' | 'none';
  session_max_minutes: number | null;
  slo_supported: boolean | null;
  verified_by: string | null;
  verified_at: Date | null;
  next_review_at: Date | null;
};

export type IntegrationCheckRow = {
  id: string;
  instance_id: string;
  check_type:
    'http' | 'sso_login' | 'dns' | 'backup_registered' | 'webhook_registered' | 'relay_login';
  ok: boolean;
  detail: string | null;
  checked_at: Date;
};

export type IdpUserRow = {
  idp_id: string;
  username: string;
  email: string | null;
  enabled: boolean;
  updated_at: Date;
};

export type IdpGroupRow = {
  idp_id: string;
  path: string;
  parent_id: string | null;
  updated_at: Date;
};

export type GroupMappingRow = {
  id: string;
  group_idp_id: string;
  role: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  scope_type: 'platform' | 'domain' | 'instance';
  scope_id: string | null;
  propagate_to_product: boolean;
  created_by: string;
  created_at: Date;
};

export type RoleBindingRow = {
  id: string;
  subject_idp_id: string;
  role: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  scope_type: 'platform' | 'domain' | 'instance';
  scope_id: string | null;
  granted_by: string;
  granted_at: Date;
  expires_at: Date | null;
};

export type SyncRunRow = {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  changes: number;
  p95_latency_ms: number | null;
  errors: number;
  detail: Record<string, unknown>;
};

export type AlertChannelRow = {
  id: string;
  type: 'email' | 'webhook';
  target: string;
  config_enc: Buffer | null;
  enabled: boolean;
  updated_at: Date;
};

export type AccessRequestRow = {
  id: string;
  requester_idp_id: string;
  kind: 'entitlement' | 'membership' | 'instance_param';
  target: string;
  justification: string;
  state: 'open' | 'approved' | 'rejected' | 'expired';
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
};

export type RegistrySnapshotRow = {
  instance_id: string;
  payload: Record<string, unknown>;
  built_at: Date;
  stale: boolean;
};

export type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  owner_idp_id: string;
  state: 'draft' | 'validated' | 'active' | 'disabled' | 'failed';
  current_version_id: string | null;
  write_targets: string[];
  created_at: Date;
  updated_at: Date;
};

export type WorkflowVersionRow = {
  id: string;
  workflow_id: string;
  version: number;
  ir: Record<string, unknown>;
  ir_hash: string;
  compiled_n8n_id: string | null;
  created_by: string;
  created_at: Date;
};

export type WorkflowRunRow = {
  id: string;
  workflow_id: string;
  version_id: string | null;
  trigger: 'webhook' | 'schedule' | 'poll' | 'manual';
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'waiting_approval';
  idempotency_key: string | null;
  started_at: Date;
  finished_at: Date | null;
  replay_of: string | null;
  error: Record<string, unknown> | null;
};

export type WorkflowRunNodeRow = {
  run_id: string;
  node_id: string;
  state: string;
  attempt: number;
  duration_ms: number | null;
  error: Record<string, unknown> | null;
  /** Redacted output item of this node, as the downstream node received it (migration 0030). */
  sample_item: unknown | null;
  sample_captured_at: Date | null;
  sample_truncated: boolean;
};

/** Runtime field discovery cache (migration 0029): one row per instance and operation. */
export type FieldSnapshotRow = {
  id: string;
  instance_id: string;
  entry_key: string;
  operation: string;
  status: 'available' | 'unsupported' | 'unavailable';
  fields: unknown;
  detail: string | null;
  fetched_at: Date;
  retry_after: Date | null;
};

export type LicenseRecordRow = {
  instance_id: string;
  license_id: string;
  obligations: unknown;
  resale_restricted: boolean;
  hosted_service_restricted: boolean;
  /** 4F.3: the toggle state; `hosted_service_restricted` supplies the refusal reason. */
  hosted_service_enabled: boolean;
  reviewed_by: string | null;
  reviewed_at: Date | null;
};

export type PatchRecordRow = {
  instance_id: string;
  current_version: string | null;
  latest_version: string | null;
  oldest_unapplied_security_days: number | null;
  checked_at: Date;
};

export type BreakGlassSessionRow = {
  id: string;
  requester: string;
  instance_id: string | null;
  access_mode: 'read_only' | 'read_write';
  state: 'requested' | 'approved' | 'rejected' | 'active' | 'expired' | 'revoked';
  justification: string;
  approver: string | null;
  self_approved: boolean;
  granted_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_accounts: unknown;
  retention_reason: string | null;
  /** 4F.1: single-use reveal; only the hash is stored and it expires in seconds. */
  reveal_token_hash: string | null;
  reveal_expires_at: Date | null;
  revealed_at: Date | null;
  product_account_ref: string | null;
  created_at: Date;
};

export type PolicyExceptionRow = {
  id: string;
  plan_id: string | null;
  rule: string;
  scope: string;
  justification: string;
  approver: string;
  expires_at: Date;
  patch_diff: unknown;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  created_at: Date;
};

export type MaintenanceWindowRow = {
  id: string;
  scope: string;
  instance_id: string | null;
  starts_at: Date;
  ends_at: Date;
  created_by: string;
  cancelled_at: Date | null;
  created_at: Date;
};

export type DsarRequestRow = {
  id: string;
  subject_ref: string | null;
  kind: 'export' | 'delete';
  state: 'open' | 'in_progress' | 'completed' | 'rejected' | 'expired';
  opened_by: string;
  opened_at: Date;
  closed_at: Date | null;
  evidence: Record<string, unknown>;
  due_at: Date;
  scopes: unknown;
  /** 4F.4: machine-readable per-scope progress; `evidence` keeps prose. */
  scope_progress: unknown;
};

export type CapacitySnapshotRow = {
  ts: Date;
  host: Record<string, unknown>;
  per_instance: unknown;
};

export type CapacityReservationRow = {
  id: string;
  instance_id: string | null;
  cpu_milli: number;
  memory_mb: number;
  disk_mb: number;
  reserved_at: Date;
  released_at: Date | null;
};

export type ScaffoldArtefactRow = {
  id: string;
  entry_key: string;
  git_sha: string | null;
  files: unknown;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
};

export type RestoreRunRow = {
  id: string;
  backup_id: string;
  phase: string;
  concurrency: number;
  state: string;
  justification: string | null;
  login_verified_at: Date | null;
  /** 4C.4: per-product progress and the login-verification evidence. */
  detail: Record<string, unknown>;
  started_at: Date;
  finished_at: Date | null;
};

export type RestoreDrillRow = {
  id: string;
  instance_id: string | null;
  performed_at: Date;
  smoke_test: string | null;
  passed: boolean;
  evidence_url: string | null;
};
