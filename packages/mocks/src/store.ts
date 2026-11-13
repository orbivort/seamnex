import type {
  AccessRequest,
  AuditEvent,
  Backup,
  BreakGlassSession,
  CapacitySnapshot,
  CatalogEntry,
  ContainerStatus,
  DriftRecord,
  DsarRequest,
  EntitlementResponse,
  EnvValue,
  IdpGroup,
  IdpUser,
  Instance,
  InstanceDetail,
  InstanceStatus,
  Job,
  JobLogLine,
  LauncherResponse,
  LicenseRecord,
  LogoutResponse,
  MaintenanceWindow,
  Me,
  PatchRecord,
  PlatformRestoreRun,
  PlatformSettings,
  PlatformRole,
  PolicyException,
  PostureSummary,
  PrivacyRequest,
  RecoveryGate,
  RegistryEntry,
  RestoreDrill,
  RestoreRun,
  Scenario,
  StatusBanner,
  SyncRun,
  Workflow,
  WorkflowRun,
} from '@seamnex/domain';
import { clearScheduledTimers } from './timers';
import { AUDIT_EVENTS, AUDIT_ZERO_HASH, auditHashFor, auditProof } from './fixtures/audit';
import { BACKUPS, RESTORE_DRILLS, RESTORE_RUNS } from './fixtures/backups';
import { CATALOG_BY_KEY, CATALOG_ENTRIES, SCAFFOLD_DRAFTS } from './fixtures/catalog';
import { ENV_PROFILES } from './fixtures/env-schema';
import { CAPACITY, buildCapacity } from './fixtures/capacity';
import { at } from './fixtures/context';
import {
  ACCESS_REQUESTS,
  BREAK_GLASS,
  DSAR_REQUESTS,
  LICENSES,
  MAINTENANCE_WINDOWS,
  PATCHES,
  POLICY_EXCEPTIONS,
  POSTURE,
} from './fixtures/governance';
import { ALERT_CHANNELS, GROUPS, PLATFORM_SETTINGS, SYNC_RUNS, USERS } from './fixtures/identity';
import {
  CONTAINERS,
  DRIFT,
  ENV_VALUES,
  INSTANCE_DETAILS,
  INSTANCES,
  INSTANCE_BY_ID,
  INSTANCE_STATUSES,
} from './fixtures/instances';
import { JOBS } from './fixtures/jobs';
import { logsForJob } from './fixtures/job-logs';
import {
  ENTITLEMENTS_BY_ROLE,
  LAUNCHER_BY_ROLE,
  LOGOUT_BY_ROLE,
  ME_BY_ROLE,
  STATUS_BANNERS,
  entitlementsFor,
  launcherFor,
  logoutFor,
} from './fixtures/portal';
import { PRIVACY_REQUESTS } from './fixtures/privacy';
import { PLATFORM_RESTORE_RUNS, RECOVERY_GATE } from './fixtures/recovery';
import { REGISTRY } from './fixtures/registry';
import { WORKFLOWS } from './fixtures/workflows';
import { WORKFLOW_RUNS } from './fixtures/workflow-runs';

export type MockState = {
  scenario: Scenario;
  catalog: CatalogEntry[];
  instances: Instance[];
  instanceDetails: Record<string, InstanceDetail>;
  containers: Record<string, ContainerStatus[]>;
  envValues: Record<string, EnvValue[]>;
  drift: Record<string, DriftRecord[]>;
  statuses: Record<string, InstanceStatus>;
  jobs: Job[];
  jobLogs: Record<string, JobLogLine[]>;
  backups: Backup[];
  restoreRuns: RestoreRun[];
  restoreDrills: RestoreDrill[];
  workflows: Workflow[];
  workflowRuns: WorkflowRun[];
  audit: AuditEvent[];
  licenses: LicenseRecord[];
  patches: PatchRecord[];
  breakGlass: BreakGlassSession[];
  policyExceptions: PolicyException[];
  maintenance: MaintenanceWindow[];
  dsar: DsarRequest[];
  accessRequests: AccessRequest[];
  posture: PostureSummary;
  capacity: CapacitySnapshot;
  users: IdpUser[];
  groups: IdpGroup[];
  syncRuns: SyncRun[];
  alerts: typeof ALERT_CHANNELS;
  settings: PlatformSettings;
  banners: StatusBanner[];
  registry: RegistryEntry[];
  recovery: {
    backups: Backup[];
    runs: PlatformRestoreRun[];
    drills: RestoreDrill[];
    gate: RecoveryGate;
  };
  privacy: PrivacyRequest[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * The scenario a fresh store, the test harness and `openAs` all start from.
 *
 * It is one constant because it used to be three literals — here, in the shared setup and in each
 * app's `openAs` — and a suite that starts under a different scenario than the one its URL asks for
 * is very hard to read from a failing assertion.
 */
export const DEFAULT_SCENARIO: Scenario = 'degraded';

function buildBase(): MockState {
  return {
    scenario: DEFAULT_SCENARIO,
    catalog: clone(CATALOG_ENTRIES),
    instances: clone(INSTANCES),
    instanceDetails: clone(INSTANCE_DETAILS),
    containers: clone(CONTAINERS),
    envValues: clone(ENV_VALUES),
    drift: clone(DRIFT),
    statuses: clone(INSTANCE_STATUSES),
    jobs: clone(JOBS),
    jobLogs: Object.fromEntries(JOBS.map((job) => [job.id, logsForJob(job)])),
    backups: clone(BACKUPS),
    restoreRuns: clone(RESTORE_RUNS),
    restoreDrills: clone(RESTORE_DRILLS),
    workflows: clone(WORKFLOWS),
    workflowRuns: clone(WORKFLOW_RUNS),
    audit: clone(AUDIT_EVENTS),
    licenses: clone(LICENSES),
    patches: clone(PATCHES),
    breakGlass: clone(BREAK_GLASS),
    policyExceptions: clone(POLICY_EXCEPTIONS),
    maintenance: clone(MAINTENANCE_WINDOWS),
    dsar: clone(DSAR_REQUESTS),
    accessRequests: clone(ACCESS_REQUESTS),
    posture: clone(POSTURE),
    capacity: clone(CAPACITY),
    users: clone(USERS),
    groups: clone(GROUPS),
    syncRuns: clone(SYNC_RUNS),
    alerts: clone(ALERT_CHANNELS),
    settings: clone(PLATFORM_SETTINGS),
    banners: clone(STATUS_BANNERS),
    registry: clone(REGISTRY),
    recovery: {
      backups: clone(BACKUPS.filter((backup) => backup.kind === 'platform')),
      runs: clone(PLATFORM_RESTORE_RUNS),
      drills: clone(RESTORE_DRILLS),
      gate: clone(RECOVERY_GATE),
    },
    privacy: clone(PRIVACY_REQUESTS),
  };
}

function setMaintenance(state: MockState, instanceId: string, windowId: string): void {
  const instance = state.instances.find((item) => item.id === instanceId);
  const window = state.maintenance.find((item) => item.id === windowId);
  if (!instance || !window) return;
  instance.maintenance = {
    active: true,
    windowId: window.id,
    title: window.title,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  };
  const status = state.statuses[instanceId];
  if (status) status.plainStatus = 'maintenance';
  const detail = state.instanceDetails[instanceId];
  if (detail) detail.maintenance = instance.maintenance;
}

/** Keeps the admission board in step with the live portfolio. */
export function refreshCapacity(state: MockState): void {
  state.capacity = buildCapacity(state.instances, state.settings.oversubscriptionFactor);
}

export function applyScenario(state: MockState, scenario: Scenario): MockState {
  state.scenario = scenario;

  if (scenario === 'healthy') {
    state.instances.forEach((instance) => {
      if (instance.id === 'inst-people') {
        instance.state = 'ready';
        instance.ready = true;
        instance.stateReason = null;
        instance.updatedAt = at(-30);
      }
    });
    const peopleStatus = state.statuses['inst-people'];
    if (peopleStatus) {
      peopleStatus.state = 'ready';
      peopleStatus.ready = true;
      peopleStatus.plainStatus = 'available';
      peopleStatus.reason = null;
    }
    state.banners = state.banners.map((banner) => ({ ...banner, active: false }));
    state.maintenance = state.maintenance.map((window) =>
      window.id === 'mw-441' ? { ...window, state: 'completed' } : window,
    );
  }

  if (scenario === 'degraded') {
    const documents = state.instances.find((instance) => instance.id === 'inst-documents');
    if (documents) {
      documents.ready = false;
      documents.state = 'degraded';
      documents.stateReason = 'OCR worker readiness failed after the environment change.';
    }
    const documentsStatus = state.statuses['inst-documents'];
    if (documentsStatus) {
      documentsStatus.ready = false;
      documentsStatus.state = 'degraded';
      documentsStatus.plainStatus = 'degraded';
      documentsStatus.reason = 'OCR worker readiness failed after the environment change.';
    }
  }

  if (scenario === 'maintenance') {
    setMaintenance(state, 'inst-collab', 'mw-441');
    state.banners = [
      {
        id: 'banner-maintenance',
        severity: 'info',
        title: 'Nextcloud Hub is in a maintenance window',
        message:
          'Files and Talk are read-only until 09:45 UTC. Alerts are suppressed for this instance.',
        active: true,
        updatedAt: at(-30),
        windowId: 'mw-441',
      },
      ...state.banners.map((banner) => ({ ...banner, active: false })),
    ];
  }

  if (scenario === 'policy-exception') {
    const shop = state.instances.find((instance) => instance.id === 'inst-shop');
    if (shop) {
      shop.state = 'failed';
      shop.stateReason =
        'Policy exception PE-105 is pending second-party approval; the plan is blocked.';
    }
    const shopStatus = state.statuses['inst-shop'];
    if (shopStatus) {
      shopStatus.state = 'failed';
      shopStatus.plainStatus = 'unavailable';
      shopStatus.reason = 'Deployment blocked by a compose policy exception awaiting approval.';
    }
  }

  if (scenario === 'empty') {
    state.instances = [];
    state.instanceDetails = {};
    state.containers = {};
    state.envValues = {};
    state.drift = {};
    state.statuses = {};
    state.jobs = [];
    state.jobLogs = {};
    state.backups = [];
    state.restoreRuns = [];
    state.restoreDrills = [];
    state.workflows = [];
    state.workflowRuns = [];
    state.registry = [];
    state.recovery.runs = [];
    state.recovery.drills = [];
    state.privacy = [];
    state.posture = {
      ...state.posture,
      unverifiedRestores: [],
      staleMetadata: [],
      coveragePercent: 0,
      totalInstances: 0,
      sso: {
        native: 0,
        forwardAuth: 0,
        signInRequired: 0,
        totalEntries: 0,
        platformManagedCredentials: 0,
      },
    };
    state.banners = state.banners.map((banner) => ({ ...banner, active: false }));
  }

  refreshCapacity(state);
  return state;
}

let current: MockState = applyScenario(buildBase(), DEFAULT_SCENARIO);

export function getState(): MockState {
  return current;
}

export function resetState(scenario: Scenario = DEFAULT_SCENARIO): MockState {
  // Any in-flight job or restore belongs to the platform being replaced.
  clearScheduledTimers();
  current = applyScenario(buildBase(), scenario);
  return current;
}

export function meFor(role: PlatformRole): Me {
  return ME_BY_ROLE[role];
}

export function launcher(role: PlatformRole): LauncherResponse {
  return launcherFor(role, current.instances, current.statuses);
}

export function entitlements(role: PlatformRole): EntitlementResponse {
  return entitlementsFor(role, current.instances);
}

export function logout(role: PlatformRole): LogoutResponse {
  return logoutFor(role, current.instances);
}

export function findInstance(idOrSlug: string): Instance | undefined {
  return current.instances.find(
    (instance) => instance.id === idOrSlug || instance.slug === idOrSlug,
  );
}

export function findEntry(key: string): CatalogEntry | undefined {
  return current.catalog.find((entry) => entry.key === key) ?? CATALOG_BY_KEY[key];
}

export function entitlementsForSubject(role: PlatformRole) {
  return entitlements(role);
}

export function defaultLauncher(role: PlatformRole) {
  return LAUNCHER_BY_ROLE[role];
}

export function defaultEntitlements(role: PlatformRole) {
  return ENTITLEMENTS_BY_ROLE[role];
}

export function defaultLogout(role: PlatformRole) {
  return LOGOUT_BY_ROLE[role];
}

export function instanceStatus(instanceId: string): InstanceStatus | undefined {
  return current.statuses[instanceId];
}

export function containersFor(instanceId: string): ContainerStatus[] {
  return current.containers[instanceId] ?? [];
}

export function envFor(instanceId: string): EnvValue[] {
  return current.envValues[instanceId] ?? [];
}

export function driftFor(instanceId: string): DriftRecord[] {
  return current.drift[instanceId] ?? [];
}

export function detailFor(instanceId: string): InstanceDetail | undefined {
  const detail = current.instanceDetails[instanceId];
  if (!detail) return undefined;
  const live = current.instances.find((instance) => instance.id === instanceId);
  return live ? { ...detail, ...live } : detail;
}

export function jobsFor(instanceId?: string): Job[] {
  const jobs = instanceId
    ? current.jobs.filter((job) => job.instanceId === instanceId)
    : current.jobs;
  return [...jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function jobLogs(jobId: string): JobLogLine[] {
  return current.jobLogs[jobId] ?? [];
}

export function auditProofFor(seq: number) {
  return auditProof(seq);
}

/** Pseudonymous subject reference per actor, matching the fixture vocabulary. */
const SUBJECT_REFS: Record<string, string> = {
  'usr-sofia': 'sub_7a1c',
  'usr-ruth-adler': 'sub_a1f0',
  'usr-mara-vogel': 'sub_4d18',
  'usr-tomas-reiter': 'sub_9e42',
  'usr-priya-raman': 'sub_5c02',
  'usr-helena-brandt': 'sub_31ff',
  'usr-anja-keller': 'sub_2b90',
  'usr-diego-salas': 'sub_9120',
  'usr-lena-hoff': 'sub_88a1',
  'usr-jonas-weber': 'sub_6e77',
};

export type AuditActor = { id: string; name: string; type: AuditEvent['actorType'] };

export type AuditInput = {
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  outcome: AuditEvent['outcome'];
  detail: string;
  actor?: AuditActor;
};

const DEFAULT_ACTOR: AuditActor = { id: 'usr-sofia', name: 'Sofia Almeida', type: 'user' };

/**
 * FR-4.3 / AC-15: one choke point for the hash chain. Sequence increases with time, so the
 * newest event is appended and `auditProof()` resolves for it without extra work.
 */
export function appendAudit(input: AuditInput): AuditEvent {
  const state = current;
  const last = state.audit[state.audit.length - 1];
  const seq = (last?.seq ?? 0) + 1;
  const actor = input.actor ?? DEFAULT_ACTOR;
  const event: AuditEvent = {
    seq,
    id: `evt-${String(seq).padStart(5, '0')}`,
    ts: at(0),
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    targetLabel: input.targetLabel,
    outcome: input.outcome,
    detail: input.detail,
    subjectRef: SUBJECT_REFS[actor.id] ?? 'sub_sys',
    prevHash: last?.hash ?? AUDIT_ZERO_HASH,
    hash: auditHashFor(seq),
  };
  state.audit = [...state.audit, event];
  return event;
}

export function scaffoldFor(entryKey: string) {
  return SCAFFOLD_DRAFTS[entryKey];
}

export function envProfiles() {
  return ENV_PROFILES;
}

export function instanceBySlug(slug: string): Instance | undefined {
  return current.instances.find((instance) => instance.slug === slug);
}

export function instanceMap() {
  return INSTANCE_BY_ID;
}
