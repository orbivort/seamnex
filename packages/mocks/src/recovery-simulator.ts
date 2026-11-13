import type { PlatformRestoreRun, RestorePhaseStatus } from '@seamnex/domain';
import { at } from './fixtures/context';
import { appendAudit, getState } from './store';
import { schedule } from './timers';

const PHASE_MS = 650;

const PHASE_LABELS: Record<RestorePhaseStatus['phase'], string> = {
  preparing: 'Preparing the clean host',
  idp: 'Identity provider',
  control_plane: 'Control plane',
  login_verified: 'Administrative login verified',
  products: 'Product instances (parallel)',
  verify: 'Verification',
  complete: 'Complete',
  failed: 'Failed',
};

const PHASE_DETAIL: Record<RestorePhaseStatus['phase'], string> = {
  preparing: 'Scratch stack prepared on the clean host; nothing is published yet.',
  idp: 'Realm, database and configuration restored first; no product route is reachable.',
  control_plane: 'Entitlements, audit, job history, workflow definitions and keys restored.',
  login_verified: 'An administrative login succeeded; only now may product routes be republished.',
  products: 'Product instances restored in parallel at the configured concurrency.',
  verify: 'Smoke tests per deployment: admin login and record count within tolerance.',
  complete: 'Gate released; routes republished with their previous publication state.',
  failed: 'The run is reported as failed, never completed.',
};

export const RESTORE_PHASE_ORDER: RestorePhaseStatus['phase'][] = [
  'preparing',
  'idp',
  'control_plane',
  'login_verified',
  'products',
  'verify',
  'complete',
];

export function buildRestorePhases(): RestorePhaseStatus[] {
  return RESTORE_PHASE_ORDER.map((phase) => ({
    phase,
    label: PHASE_LABELS[phase],
    state: 'pending',
    startedAt: null,
    finishedAt: null,
    detail: PHASE_DETAIL[phase],
  }));
}

/**
 * FR-1.36 as behaviour, not copy: product routes are unpublished for the whole run and are only
 * republished once the administrative login has succeeded.
 */
export function startPlatformRestore(runId: string): void {
  const state = getState();
  const run = state.recovery.runs.find((item) => item.id === runId);
  if (!run) return;

  const published = new Map(
    state.instances.map((instance) => [instance.id, instance.route.published] as const),
  );
  state.instances.forEach((instance) => {
    instance.route.published = false;
  });
  state.recovery.gate = {
    routesPublished: false,
    loginVerifiedAt: null,
    detail: 'Product routes are unpublished until an administrative login succeeds.',
  };

  let cursor = 0;
  const step = () => {
    const phase = run.phases[cursor];
    if (!phase) {
      finish(run, published);
      return;
    }
    phase.state = 'running';
    phase.startedAt = at(0);
    run.phase = phase.phase;
    schedule(() => {
      phase.state = 'succeeded';
      phase.finishedAt = at(0);
      if (phase.phase === 'login_verified') run.loginVerifiedAt = at(0);
      cursor += 1;
      step();
    }, PHASE_MS);
  };
  step();
}

function finish(run: PlatformRestoreRun, published: Map<string, boolean>): void {
  const state = getState();
  run.state = 'succeeded';
  run.phase = 'complete';
  run.finishedAt = at(0);
  state.instances.forEach((instance) => {
    instance.route.published = published.get(instance.id) ?? true;
  });
  state.recovery.gate = {
    routesPublished: true,
    loginVerifiedAt: run.loginVerifiedAt,
    detail: 'Routes republished after the administrative login was verified.',
  };
  appendAudit({
    action: 'platform.restore.completed',
    targetType: 'platform',
    targetId: run.id,
    targetLabel: 'Platform-state restore',
    outcome: 'success',
    detail: `Identity provider restored first, control plane second, then ${state.instances.length} product instances in parallel; the administrative login was verified before routes were republished.`,
    actor: { id: 'scheduler', name: 'Scheduler', type: 'system' },
  });
}
