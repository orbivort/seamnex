import type {
  PlatformRestoreRun,
  RecoveryContent,
  RecoveryGate,
  RestorePhaseStatus,
} from '@seamnex/domain';
import { at, daysAgo } from './context';

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

function phases(
  done: RestorePhaseStatus['phase'],
  startedAt: string,
  minutes = 1,
): RestorePhaseStatus[] {
  const order: RestorePhaseStatus['phase'][] = [
    'preparing',
    'idp',
    'control_plane',
    'login_verified',
    'products',
    'verify',
    'complete',
  ];
  const doneIndex = order.indexOf(done);
  return order.map((phase, index) => {
    const state: RestorePhaseStatus['state'] =
      doneIndex < 0
        ? 'failed'
        : index < doneIndex
          ? 'succeeded'
          : index === doneIndex
            ? 'succeeded'
            : 'pending';
    const start = new Date(Date.parse(startedAt) + index * minutes * 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    return {
      phase,
      label: PHASE_LABELS[phase],
      state,
      startedAt: state === 'pending' ? null : start,
      finishedAt: state === 'succeeded' ? start : null,
      detail:
        phase === 'idp'
          ? 'Realm, database and configuration restored first; no product route is reachable yet.'
          : phase === 'control_plane'
            ? 'Entitlements, audit, job history, workflow definitions and keys restored.'
            : phase === 'login_verified'
              ? 'An administrative login succeeded; only now may product routes be republished.'
              : phase === 'products'
                ? 'Product instances restored in parallel at the configured concurrency.'
                : phase === 'verify'
                  ? 'Smoke tests per deployment: admin login and record count within tolerance.'
                  : phase === 'complete'
                    ? 'Gate released; routes republished with the previous publication state.'
                    : 'Scratch stack prepared on the clean host.',
    };
  });
}

export const RECOVERY_CONTENTS: RecoveryContent[] = [
  {
    label: 'Entitlements and group mappings',
    detail: 'Runtime grants; never re-derived from declarations.',
    included: true,
  },
  {
    label: 'Audit log and anchors',
    detail: 'Append-only chain plus the daily external anchor.',
    included: true,
  },
  {
    label: 'Job history',
    detail: 'Deployment and lifecycle jobs with 30-day logs.',
    included: true,
  },
  {
    label: 'Workflow definitions',
    detail: 'Platform-owned IR versions and credential scopes.',
    included: true,
  },
  {
    label: 'Secret-store root keys',
    detail: 'Escrowed separately from the data set.',
    included: true,
  },
  { label: 'TLS material', detail: 'Wildcard and evidence certificates.', included: true },
  {
    label: 'Identity provider realm',
    detail: 'Realm, database and configuration — the reason a restore without it fails.',
    included: true,
  },
  {
    label: 'Catalog and instance definitions',
    detail: 'Fallback copy only; the repository stays authoritative and is reconciled toward.',
    included: false,
  },
];

export const PLATFORM_RESTORE_RUNS: PlatformRestoreRun[] = [
  {
    id: 'rst-118',
    backupId: 'bkp-platform-1022',
    kind: 'platform',
    phase: 'complete',
    state: 'succeeded',
    startedAt: daysAgo(9),
    finishedAt: at(-9 * 24 * 60 + 44),
    loginVerifiedAt: at(-9 * 24 * 60 + 26),
    concurrency: 4,
    failedReason: null,
    justification: 'Quarterly platform-state drill on a clean host, witnessed by the auditor.',
    requestedBy: 'Sofia Almeida',
    routesUnpublishedUntilLogin: true,
    phases: phases('complete', daysAgo(9), 4),
  },
  {
    id: 'rst-117',
    backupId: 'bkp-platform-1020',
    kind: 'platform',
    phase: 'products',
    state: 'failed',
    startedAt: daysAgo(34),
    finishedAt: at(-34 * 24 * 60 + 38),
    loginVerifiedAt: at(-34 * 24 * 60 + 18),
    concurrency: 4,
    failedReason:
      'Smoke test failed: D07-01 OrangeHRM returned 0 employees after restore; the volume capture was incomplete.',
    justification: 'Post-upgrade platform restore rehearsal.',
    requestedBy: 'Sofia Almeida',
    routesUnpublishedUntilLogin: true,
    phases: phases('products', daysAgo(34), 4).map((phase) =>
      phase.phase === 'products'
        ? {
            ...phase,
            state: 'failed',
            detail:
              'OrangeHRM smoke test returned 0 employees; the run is reported as failed, not complete.',
          }
        : phase,
    ),
  },
];

export const RECOVERY_GATE: RecoveryGate = {
  routesPublished: true,
  loginVerifiedAt: at(-9 * 24 * 60 + 26),
  detail:
    'All product routes are published; the last restore verified an administrative login before republishing.',
};
