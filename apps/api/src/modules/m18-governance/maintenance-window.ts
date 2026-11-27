import type { MaintenanceWindow, PolicyException } from '@seamnex/domain';

/**
 * One row, one shape.
 *
 * `maintenance_window` was mapped twice — once by the list and once by the single-record read the
 * write endpoints answer with — and the two disagreed on the same row: the list reported
 * `scopeLabel: 'Platform'` / `title: 'Platform maintenance'` while the POST that created it
 * reported the operator's own scope and `<scope> maintenance`. A screen that renders the response
 * and then refetches showed the row change identity. Both paths now go through this mapper.
 */
export type MaintenanceWindowRow = {
  id: string;
  scope: string;
  instance_id: string | null;
  product: string | null;
  starts_at: Date;
  ends_at: Date;
  created_by: string;
  created_by_label: string | null;
  cancelled_at: Date | null;
};

/**
 * `created_by` holds a subject identifier (`idp_user.idp_id`), exactly like `break_glass_session`.
 * Rendering the column raw put a UUID where the console says "created by", so it is resolved here;
 * the identifier is kept as the fallback for a subject the directory no longer knows.
 */
export const MAINTENANCE_WINDOW_SELECT = `
  SELECT m.id, m.scope, m.instance_id, m.starts_at, m.ends_at, m.cancelled_at,
         coalesce(i.payload->>'product', i.entry_key) AS product,
         coalesce(cu.display_name, cu.username) AS created_by_label
    FROM maintenance_window m
    LEFT JOIN instance i ON i.id = m.instance_id
    LEFT JOIN idp_user cu ON cu.idp_id = m.created_by`;

/**
 * Time, not the stored row, decides a window's state — the same rule the notification suppressor
 * applies. The list used `now > ends_at`, so a window stayed "active" in the exact instant it
 * ended while the single-record read called it "completed".
 */
export function maintenanceWindowStateAt(
  row: Pick<MaintenanceWindowRow, 'starts_at' | 'ends_at' | 'cancelled_at'>,
  now = Date.now(),
): MaintenanceWindow['state'] {
  if (row.cancelled_at !== null) return 'completed';
  if (now < row.starts_at.getTime()) return 'scheduled';
  return now < row.ends_at.getTime() ? 'active' : 'completed';
}

export function toMaintenanceWindow(
  row: MaintenanceWindowRow,
  now = Date.now(),
): MaintenanceWindow {
  const state = maintenanceWindowStateAt(row, now);
  const product = row.product;
  /* A platform-wide window has no product to name it, so the operator's own scope text is the
     label; replacing it with the word "Platform" threw away the only description of the work. */
  const scopeLabel = product ?? (row.scope.trim().length > 0 ? row.scope : 'Platform');
  return {
    id: row.id,
    scope: row.scope,
    scopeLabel,
    instanceId: row.instance_id,
    title: product === null ? row.scope : `${product} maintenance`,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    createdBy: row.created_by_label ?? row.created_by,
    state,
    /* Suppression is a property of a window that can still suppress: a cancelled or finished one
       suppresses nothing, and the console rendered "alerts suppressed" for those rows. */
    suppressAlerts: state !== 'completed',
  };
}

/**
 * NFR-4.15: the decider is never the requester.
 *
 * `policy_exception` has no `requester` column. The deployment flow that files the exception names
 * the requester inside `patch_diff.requestedBy`, and until a decision is taken the `approver`
 * column still holds whoever created the row. The read and the decision must resolve the requester
 * the same way, or the console shows one second party and the API refuses another.
 */
export function policyExceptionRequester(exception: {
  approver: string;
  patch_diff: unknown;
}): string {
  const diff = exception.patch_diff;
  if (diff !== null && typeof diff === 'object') {
    const requestedBy = (diff as { requestedBy?: unknown }).requestedBy;
    if (typeof requestedBy === 'string' && requestedBy.length > 0) return requestedBy;
  }
  return exception.approver;
}

/**
 * The one projection of a `policy_exception` row, shared by the queue and by both write answers.
 *
 * Both name columns hold subject identifiers and the screen shows people, so each side is resolved
 * to the directory name once, here. `requestedBy` lives in `patch_diff` because the table has no
 * requester column (see `policyExceptionRequester`); until a decision overwrites `approver`, that
 * column still holds whoever created the row.
 */
export const POLICY_EXCEPTION_SELECT = `
  SELECT pe.id, pe.rule, pe.scope, pe.justification, pe.approver, pe.state, pe.created_at,
         pe.expires_at, pe.patch_diff,
         coalesce(r.display_name, r.username) AS requester_name,
         coalesce(a.display_name, a.username) AS approver_name
    FROM policy_exception pe
    LEFT JOIN idp_user r ON r.idp_id = coalesce(pe.patch_diff->>'requestedBy', pe.approver)
    LEFT JOIN idp_user a ON a.idp_id = pe.approver`;

export type PolicyExceptionRow = {
  id: string;
  rule: string;
  scope: string;
  justification: string;
  approver: string;
  state: string;
  created_at: Date;
  expires_at: Date;
  patch_diff: unknown;
  requester_name?: string | null;
  approver_name?: string | null;
};

/**
 * One row, one shape — the same lesson `maintenanceWindow` learned: the queue and the write answers
 * were mapped separately and disagreed on the same row.
 *
 * Two read-time corrections live here rather than in each screen:
 *   - `pending` and `requested` both mean "awaiting a second party" (the column predates the wire
 *     vocabulary), and anything unrecognised is not silently "approved";
 *   - an **approved row past its expiry is `expired`, not `approved`.** It waives nothing — the
 *     resolver refuses it — so reporting it as approved told an operator the rule was covered while
 *     the next deployment was already being blocked (AC-33).
 */
export function toPolicyException(row: PolicyExceptionRow, now = Date.now()): PolicyException {
  const lapsed = row.expires_at.getTime() <= now;
  const state: PolicyException['state'] = (() => {
    switch (row.state) {
      case 'approved':
        return lapsed ? 'expired' : 'approved';
      case 'pending':
      case 'requested':
        return 'requested';
      case 'rejected':
        return 'rejected';
      default:
        // `expired`, and anything the column has never defined: terminal, so no button appears.
        return 'expired';
    }
  })();
  return {
    id: row.id,
    rule: row.rule,
    scope: row.scope,
    justification: row.justification,
    // The requester to the row, never the approver: the console decides who may act on it.
    requester: row.requester_name ?? policyExceptionRequester(row),
    // `approver` is NOT NULL and holds the creator until a decision overwrites it, so reading it raw
    // reported an open exception as already approved by its own requester.
    approver: state === 'requested' ? null : (row.approver_name ?? row.approver),
    state,
    requestedAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    patchDiff: policyExceptionDiff(row.patch_diff),
  };
}

/** The written diff an approver decides on, not a JSON envelope around it. */
export function policyExceptionDiff(diff: unknown): string {
  if (typeof diff === 'string' && diff.length > 0) return diff;
  if (diff !== null && typeof diff === 'object') {
    const written = (diff as { diff?: unknown }).diff;
    if (typeof written === 'string' && written.length > 0) return written;
    return JSON.stringify(diff);
  }
  return 'none';
}
