import type { PrivacyRequest, PrivacyScope } from '@seamnex/domain';

/** NFR-4.13: a request is due within 30 days of opening; the deadline is stored, not guessed. */
export const DSAR_DAYS_TO_DUE = 30;

/** A scope and its identity: `scopeId` is the join key with the `scope_progress` column. */
export type DsarScope = PrivacyScope & { scopeId: string };

/** One row of `personal_data_map`, the contract with each product about *where* data lives. */
export type PersonalDataMapRow = {
  scope_type: string;
  scope_id: string;
  export_procedure: string;
  delete_procedure: string;
};

/** One entry of `dsar_request.scope_progress`: machine-readable, because the queue renders it. */
export type ScopeProgressEntry = {
  scopeId: string;
  state: PrivacyScope['state'];
  detail?: string;
};

/** The `dsar_request` row as both writers and the queue read it. */
export type DsarRow = {
  id: string;
  subject_ref: string | null;
  kind: 'export' | 'delete';
  state: string;
  opened_by: string;
  opened_at: Date;
  closed_at: Date | null;
  due_at: Date | null;
  scopes: unknown;
  scope_progress: unknown;
  evidence: { steps?: string[] } | null;
};

/**
 * 4F.4 names the platform-tier scopes explicitly: a subject's data is not only inside products,
 * so entitlements, the identity record, audit events, job logs and the notification/backup trail
 * are always in a request. The map refines the *procedure* for these scopes; it can never remove
 * one, because an unmapped platform tier would otherwise mean "nothing to export", which is a lie.
 */
const PLATFORM_TIER: readonly {
  scopeId: string;
  label: string;
  exportDetail: string;
  deleteDetail: string;
}[] = [
  {
    scopeId: 'idp_user',
    label: 'Identity-provider record',
    exportDetail: 'Profile, groups and MFA enrolment.',
    deleteDetail: 'Account closure with the identity provider; sessions are revoked first.',
  },
  {
    scopeId: 'entitlements',
    label: 'Entitlements and role bindings',
    exportDetail: 'Effective grants with their scope labels.',
    deleteDetail: 'Grants are withdrawn before the record that justifies them is removed.',
  },
  {
    scopeId: 'audit_event',
    label: 'Audit events',
    exportDetail: 'Matched by the pseudonymous reference; the chain is never rewritten.',
    deleteDetail: 'The chain keeps the opaque reference: an audit trail is not erasable.',
  },
  {
    scopeId: 'job_log',
    label: 'Job logs',
    exportDetail: 'Lines attributed to the subject, secrets masked.',
    deleteDetail: 'Attributed lines are redacted; the job record itself is retained.',
  },
  {
    scopeId: 'notification',
    label: 'Notifications and backup sets',
    exportDetail: 'Delivery records plus the backup catalogue entries that contain them.',
    deleteDetail: 'Delivery records are removed; backups expire on their own schedule.',
  },
];

const DOCUMENTED_PLATFORM_IDS = new Set(PLATFORM_TIER.map((scope) => scope.scopeId));

/**
 * The scope list a request walks: the platform tier first, then whatever the personal-data map
 * declares for products. A map row for a documented platform scope replaces its default
 * procedure, so the map still decides *how* an export or an erasure is performed.
 */
export function dsarCatalogue(
  map: readonly PersonalDataMapRow[],
  kind: 'export' | 'delete',
): DsarScope[] {
  const documented = new Map(map.map((row) => [row.scope_id, row]));

  const platform: DsarScope[] = PLATFORM_TIER.map((scope) => ({
    scopeType: 'platform',
    scopeId: scope.scopeId,
    label: scope.label,
    state: 'pending',
    detail:
      procedure(documented.get(scope.scopeId), kind) ??
      (kind === 'delete' ? scope.deleteDetail : scope.exportDetail),
  }));

  const extraPlatform: DsarScope[] = map
    .filter((row) => row.scope_type === 'platform' && !DOCUMENTED_PLATFORM_IDS.has(row.scope_id))
    .map((row) => ({
      scopeType: 'platform',
      scopeId: row.scope_id,
      label: row.scope_id,
      state: 'pending',
      detail: procedure(row, kind) ?? row.export_procedure,
    }));

  const product: DsarScope[] = map
    .filter((row) => row.scope_type !== 'platform')
    .map((row) => ({
      scopeType: 'product',
      scopeId: row.scope_id,
      label: row.scope_id,
      state: 'pending',
      detail: procedure(row, kind) ?? row.export_procedure,
    }));

  return [...platform, ...extraPlatform, ...product];
}

/**
 * The response shape of `POST /privacy/requests` and `.../advance`.
 *
 * A request carries the scope list it snapshotted when it was opened, so a later change to the
 * personal-data map cannot retroactively rewrite what an operator has been working through.
 * Rows opened before the snapshot existed fall back to the current map, which is the best
 * evidence available for them.
 */
export function toPrivacyRequest(row: DsarRow, map: readonly PersonalDataMapRow[]): PrivacyRequest {
  const snapshot = scopeSnapshot(row.scopes);
  const base = snapshot.length > 0 ? snapshot : dsarCatalogue(map, row.kind);
  const progress = progressByScope(row.scope_progress);

  return {
    id: row.id,
    subjectRef: row.subject_ref ?? 'erased',
    kind: row.kind,
    state: dsarState(row.state),
    openedBy: row.opened_by,
    openedAt: row.opened_at.toISOString(),
    dueAt: (
      row.due_at ?? new Date(row.opened_at.getTime() + DSAR_DAYS_TO_DUE * 86_400_000)
    ).toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
    scopes: base.map((scope) => {
      const entry = progress.get(scope.scopeId);
      return {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        label: scope.label,
        state: entry?.state ?? scope.state,
        detail: entry?.detail ?? scope.detail,
      };
    }),
    evidence: row.evidence?.steps ?? [],
  };
}

/** `rejected` and `expired` are failures of the request, not of the subject. */
export function dsarState(state: string): PrivacyRequest['state'] {
  switch (state) {
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'complete';
    case 'rejected':
    case 'expired':
      return 'failed';
    default:
      return 'open';
  }
}

const SCOPE_STATES: readonly PrivacyScope['state'][] = ['pending', 'running', 'complete', 'failed'];

function isScopeState(value: unknown): value is PrivacyScope['state'] {
  return typeof value === 'string' && (SCOPE_STATES as readonly string[]).includes(value);
}

function procedure(
  row: PersonalDataMapRow | undefined,
  kind: 'export' | 'delete',
): string | undefined {
  if (row === undefined) return undefined;
  const text = kind === 'delete' ? row.delete_procedure : row.export_procedure;
  return typeof text === 'string' && text.trim().length > 0 ? text : undefined;
}

/** A malformed snapshot must not blank the queue; only entries that can be rendered survive. */
function scopeSnapshot(value: unknown): DsarScope[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const scope = entry as Partial<DsarScope>;
    if (typeof scope.scopeId !== 'string' || typeof scope.label !== 'string') return [];
    return [
      {
        scopeType: scope.scopeType === 'product' ? 'product' : 'platform',
        scopeId: scope.scopeId,
        label: scope.label,
        state: isScopeState(scope.state) ? scope.state : 'pending',
        detail:
          typeof scope.detail === 'string' && scope.detail.length > 0 ? scope.detail : scope.label,
      },
    ];
  });
}

function progressByScope(
  value: unknown,
): Map<string, { state: PrivacyScope['state']; detail?: string }> {
  const entries = new Map<string, { state: PrivacyScope['state']; detail?: string }>();
  if (!Array.isArray(value)) return entries;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Partial<ScopeProgressEntry>;
    if (typeof entry.scopeId !== 'string') continue;
    entries.set(entry.scopeId, {
      state: isScopeState(entry.state) ? entry.state : 'pending',
      ...(typeof entry.detail === 'string' && entry.detail.length > 0
        ? { detail: entry.detail }
        : {}),
    });
  }
  return entries;
}
