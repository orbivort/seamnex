import type {
  PlatformRestoreRun,
  RecoveryContent,
  RecoveryGate,
  RestorePhaseStatus,
} from '@seamnex/domain';
import { at, daysAgo, hoursAgo } from './context';

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

/**
 * FR-1.35 — what each platform set actually holds, keyed by backup id.
 *
 * The mock mirrors the API's manifest model: an artefact is `included` only when the set stored an
 * object for it, and material the operator owns is a reference with a location instead of a claim.
 * Keeping this per backup is what lets the screen derive its contents instead of rendering a shared
 * constant that no capture ever produced.
 */
export type MockPlatformArtefact = {
  readonly kind: string;
  readonly label: string;
  readonly detail: string;
  readonly included: boolean;
  readonly bytes: number | null;
  readonly location: string | null;
  readonly capturedAt: string;
  /** The non-secret id of the escrowed root key, so the mock matches the API's wording. */
  readonly keyId?: string;
};

const MB = 1024 ** 2;
const GB = 1024 ** 3;

function platformArtefacts(capturedAt: string, scale = 1): MockPlatformArtefact[] {
  return [
    {
      kind: 'platform_database',
      label: 'Platform database',
      detail: 'Entitlements, audit log, job history, workflow definitions and keys.',
      included: true,
      bytes: Math.round(412 * MB * scale),
      location: null,
      capturedAt,
    },
    {
      kind: 'idp_database',
      label: 'Identity-provider database',
      detail: "The identity provider's own database: users, credentials and realm data.",
      included: true,
      bytes: Math.round(96 * MB * scale),
      location: null,
      capturedAt,
    },
    {
      kind: 'idp_realm',
      label: 'Identity-provider realm export',
      detail: 'Realm configuration, clients and scopes, as the admin export returns them.',
      included: true,
      bytes: Math.round(1.4 * MB * scale),
      location: null,
      capturedAt,
    },
    {
      kind: 'edge_routes',
      label: 'Edge route configuration',
      detail: 'The dynamic routers and middlewares the platform generates.',
      included: true,
      bytes: Math.round(0.2 * MB * scale),
      location: null,
      capturedAt,
    },
    {
      kind: 'audit_anchor',
      label: 'Audit anchor',
      detail: 'Daily anchors plus the chain head, so restored audit records stay verifiable.',
      included: true,
      bytes: Math.round(0.05 * MB * scale),
      location: null,
      capturedAt,
    },
    {
      kind: 'catalog_repo',
      label: 'Catalogue repository (fallback copy)',
      detail: 'A copy of the working tree; the repository stays authoritative (DD-14).',
      included: true,
      bytes: Math.round(24 * MB * scale),
      location: null,
      capturedAt,
    },
    {
      kind: 'edge_static_and_tls',
      label: 'Edge static configuration and TLS material',
      detail: 'Owned by the operator: an external ingress, an ACME store or an internal CA.',
      included: false,
      bytes: null,
      location: 'operator://edge/ingress-tls (ops vault, item "edge-acme")',
      capturedAt,
    },
    {
      kind: 'secret_root_key',
      label: 'Secret-store root key',
      detail: 'Escrowed by the operator. Never inside the set, so a leaked archive opens nothing.',
      included: false,
      bytes: null,
      location: 'operator://secrets/root-key (sealed envelope, ops vault)',
      capturedAt,
      keyId: '9f2c41d7a0b3e568',
    },
  ];
}

export const PLATFORM_ARTEFACTS_BY_BACKUP: Record<string, MockPlatformArtefact[]> = {
  'bkp-platform-1022': platformArtefacts(hoursAgo(6)),
  'bkp-platform-1021': platformArtefacts(at(-29 * 60), 0.94),
};

/** The labels a set advertises in the register: only the artefacts it stored an object for. */
export function includedLabels(backupId: string): string[] {
  return (PLATFORM_ARTEFACTS_BY_BACKUP[backupId] ?? [])
    .filter((artefact) => artefact.included)
    .map((artefact) => artefact.label);
}

/** The contents panel of one set, described exactly as the API describes a manifest. */
export function contentsFor(backupId: string): RecoveryContent[] | null {
  const artefacts = PLATFORM_ARTEFACTS_BY_BACKUP[backupId];
  if (artefacts === undefined) return null;
  return artefacts.map((artefact) => ({
    label: artefact.label,
    detail: describe(artefact),
    included: artefact.included,
  }));
}

/** Registers a freshly captured set so the screen derives its contents from it. */
export function registerCapturedSet(backupId: string, capturedAt: string): void {
  PLATFORM_ARTEFACTS_BY_BACKUP[backupId] = platformArtefacts(capturedAt);
}

function describe(artefact: MockPlatformArtefact): string {
  if (artefact.included) {
    const size = artefact.bytes === null ? '' : ` · ${formatBytes(artefact.bytes)}`;
    const when =
      artefact.capturedAt.length === 0 ? '' : ` · captured ${formatStamp(artefact.capturedAt)}`;
    return `${artefact.detail}${size}${when}`;
  }
  const keyId =
    artefact.kind === 'secret_root_key' && artefact.keyId ? `, key id ${artefact.keyId}` : '';
  return artefact.location === null
    ? `${artefact.detail} Not captured${keyId === '' ? '.' : ` (location not recorded${keyId}).`}`
    : `${artefact.detail} Recorded location: ${artefact.location}${keyId}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

function formatStamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

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
