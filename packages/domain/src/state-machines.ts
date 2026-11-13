import type {
  BreakGlassState,
  InstanceState,
  LifecycleAction,
  RestorePhase,
  WorkflowState,
} from './enums';

/** Design §7.4 instance state machine. */
export const INSTANCE_TRANSITIONS: Record<InstanceState, InstanceState[]> = {
  requested: ['validating', 'failed'],
  validating: ['resolving', 'failed'],
  resolving: ['building', 'rendering', 'failed'],
  building: ['rendering', 'failed'],
  rendering: ['planned', 'failed'],
  planned: ['deploying', 'failed'],
  deploying: ['integrating', 'failed'],
  integrating: ['verifying', 'failed'],
  verifying: ['ready', 'failed'],
  ready: ['upgrading', 'degraded', 'stopping', 'restarting', 'deleting'],
  degraded: ['ready', 'failed', 'stopping', 'upgrading', 'restarting', 'deleting'],
  failed: ['rolling_back', 'deleting'],
  rolling_back: ['ready', 'failed'],
  upgrading: ['ready', 'degraded', 'rolling_back'],
  stopping: ['stopped', 'failed'],
  stopped: ['starting', 'deleting'],
  starting: ['ready', 'failed'],
  restarting: ['ready', 'failed'],
  deleting: ['deleted', 'failed'],
  deleted: [],
};

export function canTransitionInstance(from: InstanceState, to: InstanceState): boolean {
  return INSTANCE_TRANSITIONS[from].includes(to);
}

const BUSY_STATES: ReadonlySet<InstanceState> = new Set([
  'requested',
  'validating',
  'resolving',
  'building',
  'rendering',
  'planned',
  'deploying',
  'integrating',
  'verifying',
  'rolling_back',
  'upgrading',
  'stopping',
  'starting',
  'restarting',
  'deleting',
]);

/** A lifecycle action is only offered when the instance is not mid-transition. */
export function lifecycleAvailability(state: InstanceState): Record<LifecycleAction, boolean> {
  const busy = BUSY_STATES.has(state);
  const running = state === 'ready' || state === 'degraded';
  return {
    start: state === 'stopped' && !busy,
    stop: running,
    restart: running,
    // Re-render and re-apply: meaningful whenever the containers exist, including a stopped or
    // failed instance whose definition (or environment) needs to be applied again.
    reconfigure: !busy && state !== 'requested',
    upgrade: running,
    rollback: state === 'failed' || running,
    delete: !busy,
    export: !busy,
  };
}

export function isTransitional(state: InstanceState): boolean {
  return BUSY_STATES.has(state);
}

/**
 * FR-4.11 break-glass state machine.
 *
 * `requested → active` is listed because approval is a single write that both decides the request
 * and starts the clock; the table previously required an `approved` hop that no writer performs, so
 * the documented machine and the code disagreed. `approved` stays reachable for an implementation
 * that separates the decision from the credential being established, and nothing returns from a
 * terminal state: a closed elevation is closed.
 */
export const BREAK_GLASS_TRANSITIONS: Record<BreakGlassState, BreakGlassState[]> = {
  requested: ['approved', 'active', 'rejected'],
  approved: ['active', 'rejected'],
  rejected: [],
  active: ['expired', 'revoked'],
  expired: [],
  revoked: [],
};

export function canTransitionBreakGlass(from: BreakGlassState, to: BreakGlassState): boolean {
  return BREAK_GLASS_TRANSITIONS[from].includes(to);
}

/**
 * The state an elevation is *actually* in at a moment in time.
 *
 * The stored row only changes when something writes it. A grant whose `expires_at` has passed is
 * over whether or not a sweep has run, so every reader derives the state instead of trusting the
 * column: an "active" session past its deadline would otherwise be rendered as live access, and the
 * console would advertise an elevation the platform has already promised to end.
 *
 * `approved` is a stored state in the machine (`requested → approved → active`) that the writers
 * collapse into `active`; it is preserved here so the derivation never invents a transition.
 */
export function breakGlassStateAt(
  state: BreakGlassState,
  expiresAt: string | number | Date | null,
  now: number = Date.now(),
): BreakGlassState {
  if (state !== 'active' || expiresAt === null) return state;
  const deadline = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  if (Number.isNaN(deadline)) return state;
  return deadline <= now ? 'expired' : state;
}

/** FR-1.36 fixed restore order. */
export const RESTORE_ORDER: RestorePhase[] = [
  'preparing',
  'idp',
  'control_plane',
  'login_verified',
  'products',
  'verify',
  'complete',
];

export function restoreProgress(phase: RestorePhase): number {
  if (phase === 'failed') return 100;
  const index = RESTORE_ORDER.indexOf(phase);
  return index < 0 ? 0 : Math.round(((index + 1) / RESTORE_ORDER.length) * 100);
}

export const WORKFLOW_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  draft: ['validated', 'disabled'],
  validated: ['active', 'draft', 'disabled'],
  active: ['disabled', 'failed'],
  disabled: ['active', 'draft'],
  failed: ['draft', 'validated', 'disabled'],
};

export function canTransitionWorkflow(from: WorkflowState, to: WorkflowState): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}
