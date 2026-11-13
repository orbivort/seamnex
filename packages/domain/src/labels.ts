import type {
  AccessMode,
  AccessRequestKind,
  AccessRequestState,
  AuthMode,
  BreakGlassState,
  ContainerState,
  CredentialGranularity,
  EntitlementSyncState,
  EnvSource,
  GuaranteeClass,
  InstanceState,
  JobKind,
  JobState,
  OperationMode,
  OverrideCeiling,
  PackagingKind,
  PlainStatus,
  PlatformRole,
  RestorePhase,
  RunState,
  Scenario,
  Severity,
  SsoState,
  WorkflowState,
} from './enums';

export type Tone = 'positive' | 'caution' | 'danger' | 'neutral' | 'info';

export type LabelSpec = { label: string; tone: Tone; description: string };

export const ROLE_LABELS: Record<
  PlatformRole,
  { name: string; short: string; description: string }
> = {
  R1: {
    name: 'Platform Administrator',
    short: 'Platform admin',
    description:
      'Owns the platform: catalog, deployments, capacity, security configuration. Business-product authority is break-glass only.',
  },
  R2: {
    name: 'Platform Auditor',
    short: 'Auditor',
    description:
      'Read-only access to audit, configuration, patch register, posture and deployment history. Cannot change state.',
  },
  R3: {
    name: 'Domain Owner',
    short: 'Domain owner',
    description:
      'Accountable for one or more business domains: product choice, access, configuration and workflows touching the domain.',
  },
  R4: {
    name: 'Product Administrator',
    short: 'Product admin',
    description:
      'Administers assigned product instances: users, roles, settings and non-infrastructure environment values.',
  },
  R5: {
    name: 'End User',
    short: 'End user',
    description: 'Uses the portal and entitled products. No administrative rights.',
  },
  R6: {
    name: 'External / Guest User',
    short: 'Guest',
    description:
      'Time-limited access to one product surface. No portal administration and no catalog browsing.',
  },
};

export const GUARANTEE_CLASS_LABELS: Record<GuaranteeClass, LabelSpec> = {
  native: {
    label: 'Single sign-on — native',
    tone: 'positive',
    description:
      'The product authenticates directly against the platform identity provider via OIDC or SAML.',
  },
  fa_header: {
    label: 'Single sign-on — header injection',
    tone: 'positive',
    description:
      'The product consumes an authenticated identity header, so the user arrives already signed in.',
  },
  fa_delegated: {
    label: 'Single sign-on — delegated sign-in',
    tone: 'positive',
    description:
      'The route is gated and the product authenticates against the directory. No platform-issued password exists.',
  },
  fa_gate: {
    label: 'Sign-in required — proxy gate only',
    tone: 'caution',
    // Never "single sign-on", and no claim about who holds the credential: ADR-BE-22 lets the
    // platform manage a per-user account for some gates, and the per-entry sentence in
    // `sign-in-copy.ts` is the only place that knows which. The sentence this replaced ("the
    // platform never creates, stores or resets it") was printed for OpenProject and was false.
    description:
      'The route is protected and the product keeps its own credential. The platform may sign you in with an account it manages for you, or the product may ask for one issued outside the platform. Neither is single sign-on.',
  },
};

export function isSingleSignOn(guaranteeClass: GuaranteeClass): boolean {
  return guaranteeClass !== 'fa_gate';
}

export function guaranteeShort(guaranteeClass: GuaranteeClass): string {
  switch (guaranteeClass) {
    case 'native':
      return 'Native SSO';
    case 'fa_header':
      return 'Header SSO';
    case 'fa_delegated':
      return 'Delegated SSO';
    case 'fa_gate':
      return 'Sign-in required';
  }
}

/**
 * The credential label a card may print. The guarantee class says what the product *can* do; the
 * sso state says what this deployment *does*. A native product with no identity client registered
 * still shows a product login at launch, so it is labelled as a sign-in, not as SSO — a label that
 * contradicts the launch dialog is worse than a vaguer one.
 *
 * A registered-but-unproven shape gets its own label instead of either extreme: "Native SSO" would
 * promise a redirect that may fail, and "Sign-in required" would describe a product that has no
 * local credential to offer.
 */
export function authLabelFor(guaranteeClass: GuaranteeClass, ssoState: SsoState | null): string {
  if (ssoState === 'sso_unverified') return 'SSO unverified';
  const sso = ssoState === null ? isSingleSignOn(guaranteeClass) : ssoState === 'sso';
  return sso && guaranteeClass !== 'fa_gate'
    ? guaranteeShort(guaranteeClass)
    : guaranteeShort('fa_gate');
}

/** Whether the label describes a working single sign-on, as opposed to a promise or a local login. */
export function ssoIsProven(ssoState: SsoState | null, guaranteeClass: GuaranteeClass): boolean {
  return ssoState === null ? isSingleSignOn(guaranteeClass) : ssoState === 'sso';
}

/**
 * Whether the edge supplies the identity per request. `fa_gate` deliberately does not: it guards
 * the route and leaves the product its own login, so treating it as forwarding is how a gate came
 * to be presented as single sign-on.
 */
export function forwardsIdentity(authMode: AuthMode | null): boolean {
  return authMode === 'fa_header' || authMode === 'fa_delegated';
}

/**
 * Whether the edge puts forward-auth in front of the route at all. Every `fa_*` class does, the
 * proxy gate included — so this, not {@link forwardsIdentity}, is what decides whether a browser
 * needs a launch ticket to obtain a session on the product's host.
 */
export function requiresEdgeSession(authMode: AuthMode | null): boolean {
  return authMode !== null && authMode !== 'native';
}

export const INSTANCE_STATE_LABELS: Record<InstanceState, LabelSpec> = {
  requested: { label: 'Requested', tone: 'info', description: 'Deployment accepted and queued.' },
  validating: { label: 'Validating', tone: 'info', description: 'Pre-flight checks are running.' },
  resolving: {
    label: 'Resolving source',
    tone: 'info',
    description: 'Compose, Dockerfile or scaffold path is being resolved.',
  },
  building: {
    label: 'Building image',
    tone: 'info',
    description: 'Image layers are being built from the Dockerfile path.',
  },
  rendering: {
    label: 'Rendering',
    tone: 'info',
    description: 'Deployment artefacts are being rendered.',
  },
  planned: { label: 'Planned', tone: 'info', description: 'A plan exists and awaits apply.' },
  deploying: {
    label: 'Deploying',
    tone: 'info',
    description: 'Containers are being created and started.',
  },
  integrating: {
    label: 'Integrating',
    tone: 'info',
    description: 'Identity, route, backup and logging are being wired.',
  },
  verifying: {
    label: 'Verifying',
    tone: 'info',
    description: 'Post-deployment integration checks are running.',
  },
  ready: {
    label: 'Ready',
    tone: 'positive',
    description: 'All required services run and the application responds.',
  },
  degraded: {
    label: 'Degraded',
    tone: 'caution',
    description: 'Containers run but the application is not ready.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    description: 'The last operation failed; see the job log.',
  },
  rolling_back: {
    label: 'Rolling back',
    tone: 'caution',
    description: 'Reverting to the previously running version.',
  },
  upgrading: {
    label: 'Upgrading',
    tone: 'info',
    description: 'A pre-upgrade backup was taken and the new version is starting.',
  },
  stopping: { label: 'Stopping', tone: 'caution', description: 'Services are shutting down.' },
  stopped: {
    label: 'Stopped',
    tone: 'neutral',
    description: 'The instance is intentionally not running.',
  },
  starting: { label: 'Starting', tone: 'info', description: 'Services are starting.' },
  restarting: {
    label: 'Restarting',
    tone: 'caution',
    description: 'A rolling restart is in progress; readiness is re-checked afterwards.',
  },
  deleting: {
    label: 'Deleting',
    tone: 'danger',
    description: 'Data retention choice is being applied and resources removed.',
  },
  deleted: {
    label: 'Deleted',
    tone: 'neutral',
    description: 'The instance no longer exists. The slug stays reserved for 30 days.',
  },
};

export const PLAIN_STATUS_LABELS: Record<PlainStatus, LabelSpec> = {
  available: { label: 'Available', tone: 'positive', description: 'Running and ready to use.' },
  degraded: {
    label: 'Degraded',
    tone: 'caution',
    description: 'Reachable, but the application is not fully ready.',
  },
  unavailable: { label: 'Unavailable', tone: 'danger', description: 'Not reachable right now.' },
  maintenance: {
    label: 'Maintenance',
    tone: 'info',
    description: 'A planned maintenance window is active.',
  },
};

/**
 * FR-3.7 / FR-1.31-1.32 mapping. Container truth is reduced to plain language for end
 * users; infrastructure detail stays in the operator console.
 */
export function plainStatusFor(state: InstanceState, ready: boolean): PlainStatus {
  if (state === 'ready' && ready) return 'available';
  if (state === 'degraded' || (state === 'ready' && !ready)) return 'degraded';
  return 'unavailable';
}

export const CONTAINER_STATE_LABELS: Record<ContainerState, LabelSpec> = {
  created: {
    label: 'Created',
    tone: 'neutral',
    description: 'Container created but never started.',
  },
  running: { label: 'Running', tone: 'positive', description: 'Container process is up.' },
  paused: { label: 'Paused', tone: 'caution', description: 'Container process is paused.' },
  restarting: { label: 'Restarting', tone: 'caution', description: 'Restart loop detected.' },
  exited: { label: 'Exited', tone: 'danger', description: 'Process terminated.' },
  dead: { label: 'Dead', tone: 'danger', description: 'Container cannot be restarted.' },
};

export const JOB_STATE_LABELS: Record<JobState, LabelSpec> = {
  queued: { label: 'Queued', tone: 'neutral', description: 'Waiting for a worker lane.' },
  running: { label: 'Running', tone: 'info', description: 'Steps are executing.' },
  succeeded: { label: 'Succeeded', tone: 'positive', description: 'All steps completed.' },
  failed: {
    label: 'Failed',
    tone: 'danger',
    description: 'A step failed; the log holds the reason.',
  },
  cancelled: { label: 'Cancelled', tone: 'neutral', description: 'Cancelled by an operator.' },
};

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  deploy: 'Deploy',
  reconfigure: 'Reconfigure',
  build: 'Build image',
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  upgrade: 'Upgrade',
  rollback: 'Roll back',
  delete: 'Delete',
  backup: 'Backup',
  restore: 'Restore',
  export: 'Export',
  prepull: 'Pre-pull images',
  scaffold: 'Scaffold source',
  verify: 'Verify backup',
  dsar: 'Privacy request',
  'platform-backup': 'Platform backup',
  'platform-restore': 'Platform restore',
  synthetic: 'Synthetic check',
};

export const PACKAGING_LABELS: Record<PackagingKind, string> = {
  compose: 'Upstream Compose file',
  dockerfile: 'Repository Dockerfile',
  none: 'Platform scaffold',
};

export const SYNC_STATE_LABELS: Record<EntitlementSyncState, LabelSpec> = {
  applied: {
    label: 'Applied',
    tone: 'positive',
    description: 'Entitlement is enforced in the product.',
  },
  pending: {
    label: 'Pending',
    tone: 'caution',
    description: 'Awaiting the next sync cycle (≤ 5 min p95).',
  },
  edge_only: {
    label: 'Edge only',
    tone: 'caution',
    description: 'Route gated, product role not propagated.',
  },
  unsupported: {
    label: 'Unsupported',
    tone: 'info',
    description: 'Proxy-gate class: the product keeps its own credential.',
  },
};

export const CREDENTIAL_GRANULARITY_LABELS: Record<CredentialGranularity, LabelSpec> = {
  scoped: {
    label: 'Operation-scoped',
    tone: 'positive',
    description:
      'The product can issue narrow, per-operation credentials; write workflows are allowed.',
  },
  account: {
    label: 'Account-level',
    tone: 'caution',
    description:
      'Credentials are account-wide, so they cannot be bounded to an operation: read-only workflows.',
  },
  none: {
    label: 'None',
    tone: 'danger',
    description: 'No API credential: no workflow may target the product (C-11).',
  },
};

/**
 * The select's options, in the order the screen shows them (most capable first).
 *
 * Kept beside the labels so the console, the docs and the simulator cannot drift: the old screen
 * hardcoded "Account-level — read-only workflows" next to a rule that treated `account` as
 * write-eligible.
 */
export const CREDENTIAL_GRANULARITY_OPTIONS: readonly {
  value: CredentialGranularity;
  label: string;
}[] = [
  { value: 'scoped', label: 'Operation-scoped — write workflows allowed' },
  { value: 'account', label: 'Account-level — read-only workflows' },
  { value: 'none', label: 'No API credential — no workflows' },
];

export const WORKFLOW_STATE_LABELS: Record<WorkflowState, LabelSpec> = {
  draft: { label: 'Draft', tone: 'neutral', description: 'Not validated; activation is blocked.' },
  validated: {
    label: 'Validated',
    tone: 'info',
    description: 'Validation passed; ready to activate.',
  },
  active: {
    label: 'Active',
    tone: 'positive',
    description: 'Triggers are live and runs are recorded.',
  },
  disabled: {
    label: 'Disabled',
    tone: 'neutral',
    description: 'Triggers paused; history retained.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    description: 'Repeated failure; the failed-run queue needs attention.',
  },
};

export const RUN_STATE_LABELS: Record<RunState, LabelSpec> = {
  queued: { label: 'Queued', tone: 'neutral', description: 'Waiting for an execution slot.' },
  running: { label: 'Running', tone: 'info', description: 'Executing nodes.' },
  succeeded: { label: 'Succeeded', tone: 'positive', description: 'All nodes completed.' },
  failed: { label: 'Failed', tone: 'danger', description: 'A node failed; inspect and replay.' },
  waiting_approval: {
    label: 'Waiting approval',
    tone: 'caution',
    description: 'A human-in-the-loop step is pending.',
  },
};

export const TRIGGER_LABELS: Record<string, string> = {
  webhook: 'Webhook',
  schedule: 'Schedule',
  poll: 'Polling',
  manual: 'Manual',
};

export const ENV_SOURCE_LABELS: Record<EnvSource, string> = {
  default: 'Catalog default',
  profile: 'Environment profile',
  instance: 'Instance override',
  secret: 'Secret store',
};

export const OVERRIDE_CEILING_LABELS: Record<OverrideCeiling, string> = {
  none: 'Locked',
  profile_only: 'Profile only',
  profile_and_instance: 'Profile + instance',
};

export const OPERATION_MODE_LABELS: Record<OperationMode, string> = {
  read: 'Read',
  write: 'Write',
};

export const SEVERITY_LABELS: Record<Severity, LabelSpec> = {
  info: { label: 'Info', tone: 'info', description: 'Informational.' },
  warning: {
    label: 'Warning',
    tone: 'caution',
    description: 'Needs attention but service continues.',
  },
  critical: { label: 'Critical', tone: 'danger', description: 'Service or control is affected.' },
};

export const ACCESS_MODE_LABELS: Record<AccessMode, LabelSpec> = {
  read_only: {
    label: 'Read-only',
    tone: 'info',
    description: 'Inspect only. Cannot be escalated after approval.',
  },
  read_write: {
    label: 'Read-write',
    tone: 'caution',
    description: 'May change data. Requires domain-owner approval.',
  },
};

export const ACCESS_REQUEST_KIND_LABELS: Record<AccessRequestKind, LabelSpec> = {
  entitlement: {
    label: 'Entitlement',
    tone: 'info',
    description: 'A product role on one instance, granted to the requester on approval.',
  },
  membership: {
    label: 'Membership',
    tone: 'neutral',
    description: 'A directory group the requester wants to join.',
  },
  instance_param: {
    label: 'Instance parameter',
    tone: 'neutral',
    description: 'A configuration change on a running instance.',
  },
};

export const ACCESS_REQUEST_STATE_LABELS: Record<AccessRequestState, LabelSpec> = {
  open: {
    label: 'Open',
    tone: 'caution',
    description: 'Waiting for a second party to decide.',
  },
  approved: {
    label: 'Approved',
    tone: 'positive',
    description: 'Decided in favour; the grant was applied.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'danger',
    description: 'Decided against; nothing was granted.',
  },
  expired: {
    label: 'Expired',
    tone: 'neutral',
    description: 'Lapsed without a decision.',
  },
};

export const BREAK_GLASS_STATE_LABELS: Record<BreakGlassState, LabelSpec> = {
  requested: {
    label: 'Requested',
    tone: 'caution',
    description: 'Awaiting second-party approval.',
  },
  approved: {
    label: 'Approved',
    tone: 'info',
    description: 'Approved; the session is being established.',
  },
  rejected: { label: 'Rejected', tone: 'neutral', description: 'The request was declined.' },
  active: { label: 'Active', tone: 'caution', description: 'Elevated access is live and audited.' },
  expired: {
    label: 'Expired',
    tone: 'neutral',
    description: 'The time box elapsed; access was revoked automatically.',
  },
  revoked: { label: 'Revoked', tone: 'danger', description: 'Access ended before expiry.' },
};

export const RESTORE_PHASE_LABELS: Record<RestorePhase, string> = {
  preparing: 'Preparing',
  idp: 'Identity provider',
  control_plane: 'Control plane',
  login_verified: 'Administrative login verified',
  products: 'Product instances',
  verify: 'Verification',
  complete: 'Complete',
  failed: 'Failed',
};

export const SCENARIO_LABELS: Record<Scenario, { label: string; description: string }> = {
  healthy: {
    label: 'Healthy',
    description: 'All entries available; one instance stopped for show.',
  },
  degraded: {
    label: 'Degraded',
    description: 'Readiness failures and an attention queue to work through.',
  },
  maintenance: {
    label: 'Maintenance',
    description: 'An active maintenance window suppresses alerts.',
  },
  'policy-exception': {
    label: 'Policy exception',
    description: 'A compose policy violation is pending second-party approval.',
  },
  empty: {
    label: 'Empty',
    description: 'No deployments yet: first-run, empty and zero-state screens.',
  },
  offline: {
    label: 'Offline',
    description: 'API unreachable: error, retry and cached-status behaviour.',
  },
};
