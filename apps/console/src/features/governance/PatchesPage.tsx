import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { usePatchRegister } from '@seamnex/api-client';
import { SEVERITIES, type PatchRecord, type Severity, type Tone } from '@seamnex/domain';
import {
  Badge,
  DataTable,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  StatusPill,
  defineColumns,
} from '@seamnex/ui';
import { formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel } from '@seamnex/shell';

/**
 * NFR-4.7 is the clock this register exists to track: a critical vulnerability is remediated within
 * 7 days of a fixed upstream release, a high one within 30. `severity` is what the platform
 * assigned to the drift; the window is what the operator is measured against, so the register
 * states both instead of leaving the operator to remember the numbers.
 */
const SLA_DAYS: Record<Severity, number | null> = { critical: 7, warning: 30, info: null };

/** A version check older than this is not a current statement about the fleet. */
const STALE_CHECK_HOURS = 24;

type VersionPosture = 'current' | 'behind' | 'unknown';

/**
 * `unknown` is the value the API substitutes when neither the patch record nor the catalog knows a
 * version for an instance. That is missing evidence, not a clean bill of health, so it never
 * renders as "current" and is never counted as current.
 */
function postureOf(row: PatchRecord): VersionPosture {
  if (row.currentVersion === 'unknown' || row.latestVersion === 'unknown') return 'unknown';
  return row.latestVersion === row.currentVersion ? 'current' : 'behind';
}

function slaWindowDays(severity: Severity): number | null {
  return SLA_DAYS[severity];
}

function pastSla(row: PatchRecord): boolean {
  const window = slaWindowDays(row.severity);
  if (window === null || row.oldestUnappliedSecurityDays === null) return false;
  return postureOf(row) === 'behind' && row.oldestUnappliedSecurityDays > window;
}

/** Severity is an enum; what the operator reads is the posture it describes. */
function severityView(row: PatchRecord): { tone: Tone; label: string } {
  if (postureOf(row) === 'unknown') return { tone: 'neutral', label: 'not checked' };
  if (row.severity === 'critical') return { tone: 'danger', label: 'critical' };
  if (row.severity === 'warning') return { tone: 'caution', label: 'behind' };
  return { tone: 'positive', label: 'current' };
}

const rowKey = (row: PatchRecord): string => row.instanceId;

/**
 * The row's destination is the deployment the versions describe. It used to be a trailing "Inspect"
 * link in its own column, which made every row two tab stops for one target; the identity cell now
 * owns the anchor and that column is gone (A11Y-04).
 */
function renderPatchLink(row: PatchRecord, className: string, children: ReactNode): ReactNode {
  return (
    <Link to={`/instances/${row.instanceId}`} className={className}>
      {children}
    </Link>
  );
}

/**
 * Every cell reads only its row, so the array is a module constant — and because it is, the
 * `postureOf`/`pastSla` calls inside the cells are not re-created per render either.
 */
const columns = defineColumns<PatchRecord>([
  {
    id: 'key',
    header: 'Key',
    nowrap: true,
    cell: (row) => (
      <span className="font-mono text-micro font-semibold text-muted">{row.entryKey}</span>
    ),
  },
  {
    id: 'product',
    header: 'Product',
    primary: true,
    // `renderPatchLink` supplies the link's type styles; the cell contributes the text only.
    cell: (row) => row.product,
  },
  {
    id: 'current',
    header: 'Current',
    mono: true,
    cell: (row) => (
      <span
        className={
          row.currentVersion === 'unknown' ? 'text-micro text-faint' : 'text-micro text-text'
        }
      >
        {row.currentVersion}
      </span>
    ),
  },
  {
    id: 'latest',
    header: 'Available',
    mono: true,
    hideBelow: 'md',
    cell: (row) => {
      if (postureOf(row) === 'unknown')
        return <span className="text-micro text-faint">unknown</span>;
      return (
        <span
          className={
            postureOf(row) === 'current'
              ? 'text-micro text-faint'
              : 'text-micro text-warning-strong'
          }
        >
          {row.latestVersion}
        </span>
      );
    },
  },
  {
    // The age of the oldest unapplied security update is the number the patch clock is measured
    // from, so it stays visible on narrow screens while the version pair collapses.
    id: 'security',
    header: 'Oldest security update',
    cell: (row) => {
      if (postureOf(row) === 'unknown')
        return <span className="text-meta text-faint">not checked</span>;
      const days = row.oldestUnappliedSecurityDays;
      // `null` is absence of a check, not a zero: an instance nobody scanned has no age to state.
      if (days === null) {
        return (
          <span
            className="text-meta text-faint"
            title="No version check has recorded security updates for this instance."
          >
            not measured
          </span>
        );
      }
      if (days === 0) {
        return (
          <span
            className="text-meta text-faint"
            title="No security update is waiting to be applied."
          >
            none pending
          </span>
        );
      }
      const window = slaWindowDays(row.severity);
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span
            className={
              pastSla(row) ? 'text-meta font-semibold text-danger' : 'text-meta text-warning-strong'
            }
            title={`Oldest unapplied security update is ${days} days old${
              window === null ? '.' : `; the ${window}-day window applies at this severity.`
            }`}
          >
            {days} days
          </span>
          {pastSla(row) && window !== null ? (
            <Badge tone="danger" size="sm">
              past {window}-day window
            </Badge>
          ) : null}
        </span>
      );
    },
  },
  {
    id: 'severity',
    header: 'Severity',
    hideBelow: 'xl',
    cell: (row) => {
      const view = severityView(row);
      return <StatusPill tone={view.tone} label={view.label} size="sm" />;
    },
  },
  {
    id: 'last',
    header: 'Last upgrade',
    hideBelow: 'lg',
    cell: (row) => (
      <span className="text-micro text-muted" title={formatDateTime(row.lastUpgradeAt)}>
        {formatRelative(row.lastUpgradeAt)}
      </span>
    ),
  },
]);

export function PatchesPage() {
  const patches = usePatchRegister();

  const rows = useMemo(() => {
    // Worst first: the register is read to decide what to patch now, so a critical record must not
    // sit below a dozen current ones because the API sorts by product name.
    return [...(patches.data ?? [])].sort(
      (a, b) =>
        SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) ||
        (b.oldestUnappliedSecurityDays ?? -1) - (a.oldestUnappliedSecurityDays ?? -1) ||
        a.product.localeCompare(b.product),
    );
  }, [patches.data]);

  const counts = useMemo(() => {
    const total = { critical: 0, behind: 0, current: 0, unchecked: 0, breach: 0 };
    for (const row of rows) {
      const posture = postureOf(row);
      // A partition, not overlapping buckets: critical is the most severe form of "behind", so it
      // must not also be counted there — three badges that add up to the register's row count are
      // the only ones an operator can reconcile at a glance.
      if (posture === 'unknown') total.unchecked += 1;
      else if (posture === 'current') total.current += 1;
      else if (row.severity === 'critical') total.critical += 1;
      else total.behind += 1;
      if (pastSla(row)) total.breach += 1;
    }
    return total;
  }, [rows]);

  /** The oldest check in the register is the honest age of everything on the screen. */
  const oldestCheck = useMemo(() => {
    const times = rows.map((row) => Date.parse(row.checkedAt)).filter(Number.isFinite);
    return times.length === 0 ? null : new Date(Math.min(...times));
  }, [rows]);

  const checkAgeHours =
    // eslint-disable-next-line react-hooks/purity -- how stale the register is can only be measured against the wall clock; there is no render-pure source for "now"
    oldestCheck === null ? null : (Date.now() - oldestCheck.getTime()) / 3_600_000;
  const stale = checkAgeHours !== null && checkAgeHours > STALE_CHECK_HOURS;

  return (
    <Page>
      {/* FR-4.7 — requirement id, developer-only; it used to be the page eyebrow and is not part
          of the rendered interface. */}
      <PageHeader
        title="Patch register"
        description="Current version, available upstream version, last upgrade and the age of the oldest unapplied security update, per instance."
        meta={
          <>
            {patches.isSuccess ? (
              <>
                <Badge tone={counts.critical > 0 ? 'danger' : 'neutral'} size="sm">
                  {counts.critical} critical
                </Badge>
                <Badge tone={counts.behind > 0 ? 'caution' : 'positive'} size="sm">
                  {counts.behind} behind
                </Badge>
                <Badge tone="positive" size="sm">
                  {counts.current} current
                </Badge>
                {counts.unchecked > 0 ? (
                  <Badge tone="neutral" size="sm">
                    {counts.unchecked} not checked
                  </Badge>
                ) : null}
                {counts.breach > 0 ? (
                  <Badge tone="danger" size="sm">
                    {counts.breach} past SLA
                  </Badge>
                ) : null}
              </>
            ) : (
              // Zeroed counts render only once there is a register to count. "0 critical" while the
              // read is still in flight — or after it failed — is the one lie this page cannot tell.
              <Badge tone="neutral" size="sm">
                {patches.isError ? 'posture unavailable' : 'checking versions'}
              </Badge>
            )}
          </>
        }
      />

      <Panel>
        <PanelHeader
          eyebrow="Register"
          title="Version posture"
          description="Upgrades always take a verified pre-upgrade backup and offer a one-step rollback."
          actions={
            oldestCheck === null ? null : (
              <span
                className={
                  stale ? 'text-micro font-semibold text-warning-strong' : 'text-micro text-faint'
                }
                title={
                  stale
                    ? `The oldest version check in this register is ${formatDateTime(oldestCheck)}, so the ages below are stale.`
                    : `Oldest version check: ${formatDateTime(oldestCheck)}.`
                }
              >
                Checked {formatRelative(oldestCheck)}
                {stale ? '· stale' : ''}
              </span>
            )
          }
        />
        {/*
          `AsyncPanel` keeps the register readable through a failed refetch: the patch posture on
          screen is the last thing the API measured, and deleting it would turn "not checked" into
          a blank panel (ERR-04). A first failure still replaces the panel, because there is no
          posture to stand behind.
        */}
        <AsyncPanel
          query={patches}
          loading={
            <div className="p-4">
              <SkeletonLines lines={7} />
            </div>
          }
          loadingLabel="Loading the patch register"
        >
          {() => (
            <DataTable
              columns={columns}
              // The register is worst-first (`rows`), not the API's product order: passing the raw
              // `data` here buried the record that needs patching today under a dozen current ones.
              rows={rows}
              rowKey={rowKey}
              dense
              renderRowLink={renderPatchLink}
              rowTone={(row) => {
                if (postureOf(row) === 'unknown') return 'default';
                return row.severity === 'critical'
                  ? 'danger'
                  : row.severity === 'warning'
                    ? 'caution'
                    : 'default';
              }}
              // NFR-4.7: the caption used to read "… NFR-4.7 windows: critical 7 days, high
              // 30 days."
              caption="Per instance: running version, available upstream version and the age of the oldest unapplied security update. Windows: critical 7 days, high 30 days."
              empty={
                <EmptyState
                  title="No patch records"
                  description="The register lists every deployed instance. Deploy a catalog entry and its version, last upgrade and pending security updates appear here."
                />
              }
            />
          )}
        </AsyncPanel>
      </Panel>
    </Page>
  );
}
