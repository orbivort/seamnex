import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { useObservePatchRegister, usePatchRegister } from '@seamnex/api-client';
import {
  compareVersions,
  updateAvailable,
  type PatchRecord,
  type Severity,
  type Tone,
} from '@seamnex/domain';
import {
  Badge,
  Button,
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
import { useCapabilities } from '../../use-capabilities';

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
 *
 * A `catalog` row is the same kind of missing evidence for a different reason: the observation pass
 * has never written it, so the two numbers are the entry document's projection and nothing has
 * compared them with upstream. Counting such a row as "current" is what the provenance line exists
 * to prevent.
 *
 * Otherwise the question is version *precedence*, not text equality. Upstream's newest release can
 * be older than what the instance runs — a maintenance release published on the previous branch
 * after the current one shipped — and `17.8.3` is not "behind" `17.9.6`. `updateAvailable` is the
 * one comparator the platform uses for this (prefixes, build metadata and pre-releases included).
 */
function postureOf(row: PatchRecord): VersionPosture {
  if (row.source === 'catalog') return 'unknown';
  if (row.currentVersion === 'unknown' || row.latestVersion === 'unknown') return 'unknown';
  return updateAvailable(row.currentVersion, row.latestVersion) ? 'behind' : 'current';
}

/**
 * Worst first, and it must agree with the pill the row renders. The API's `severity` is derived
 * before provenance is considered, so sorting on it alone floated a "not checked" row into the
 * section an operator reads as "patch now".
 */
function rankOf(row: PatchRecord): number {
  const posture = postureOf(row);
  if (posture === 'unknown') return 3;
  if (posture === 'current') return 2;
  return row.severity === 'critical' ? 0 : 1;
}

function slaWindowDays(severity: Severity): number | null {
  return SLA_DAYS[severity];
}

function pastSla(row: PatchRecord): boolean {
  const window = slaWindowDays(row.severity);
  if (window === null || row.oldestUnappliedSecurityDays === null) return false;
  return postureOf(row) === 'behind' && row.oldestUnappliedSecurityDays > window;
}

/**
 * Severity is an enum; what the operator reads is the posture it describes.
 *
 * The posture leads, not `row.severity`: the API derives a warning for any drift it can see, so a
 * row whose upstream release is older than the running version came back `warning` while the
 * version pair on the same row said "current" — and the pill told the operator to patch a
 * deployment that had nothing to patch. Only a row that is actually behind may read "behind".
 */
function severityView(row: PatchRecord): { tone: Tone; label: string } {
  const posture = postureOf(row);
  if (posture === 'unknown') return { tone: 'neutral', label: 'not checked' };
  if (posture === 'current') return { tone: 'positive', label: 'current' };
  return row.severity === 'critical'
    ? { tone: 'danger', label: 'critical' }
    : { tone: 'caution', label: 'behind' };
}

/**
 * FR-2.12 — where the two version numbers came from.
 *
 * Before the observation pass the register printed `catalog_entry.payload.upstream` as if it had been
 * measured. `catalog` is exactly that fallback, so the row says "never observed" instead of letting
 * an unread document pass for a check.
 */
function provenance(row: PatchRecord): { text: string; observed: boolean } {
  if (
    row.source !== 'observed' ||
    row.lastObservedAt === null ||
    row.lastObservedAt === undefined
  ) {
    return { text: 'never observed upstream', observed: false };
  }
  return { text: `observed ${formatRelative(row.lastObservedAt)}`, observed: true };
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
    cell: (row) => {
      const source = provenance(row);
      return (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate">{row.product}</span>
          <span
            className={
              source.observed
                ? 'text-micro text-faint'
                : 'text-micro font-medium text-warning-strong'
            }
            title={
              source.observed
                ? 'The platform read this from the upstream release feed.'
                : 'These versions come from the catalogue document, which nothing has verified against upstream.'
            }
          >
            {source.text}
          </span>
        </span>
      );
    },
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
      const posture = postureOf(row);
      if (posture === 'unknown')
        return <span className="text-micro text-faint">unknown</span>;
      const tone = posture === 'current' ? 'text-micro text-faint' : 'text-micro text-warning-strong';
      /*
       * The arrow is the "move up to this" affordance, so it belongs only to a row that is actually
       * behind. Upstream's newest tag can be older than the running version (a maintenance release
       * published on the previous branch); arrowing that number told the operator to downgrade.
       */
      const superseded =
        posture === 'current' && compareVersions(row.latestVersion, row.currentVersion) === -1
          ? "Upstream's newest release is older than the version this instance runs."
          : undefined;
      // FR-2.12 "release notes links": the version an operator is told to move to is one click from
      // the change it contains, and the link is the observed release rather than a constructed URL.
      if (row.releaseUrl === null || row.releaseUrl === undefined) {
        return (
          <span className={tone} title={superseded}>
            {row.latestVersion}
          </span>
        );
      }
      return (
        <a
          href={row.releaseUrl}
          target="_blank"
          rel="noreferrer noopener"
          className={`${tone} inline-flex items-center gap-1 hover:underline`}
          title={superseded}
        >
          {row.latestVersion}
          {posture === 'behind' ? <ArrowUpRight className="size-3 shrink-0" aria-hidden /> : null}
        </a>
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
    /*
     * FR-2.12 — the advisory the last observation found. "none open" is only printed for a row that
     * was observed: an unobserved row has no advisory answer at all, and a dash says that without
     * claiming there is nothing open.
     */
    id: 'advisory',
    header: 'Advisory',
    hideBelow: 'xl',
    cell: (row) => {
      if (row.advisory === null || row.advisory === undefined) {
        return (
          <span className="text-micro text-faint">
            {provenance(row).observed ? 'none open' : '—'}
          </span>
        );
      }
      return (
        <Badge tone={row.severity === 'critical' ? 'danger' : 'caution'} size="sm">
          {row.advisory}
        </Badge>
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
  const observe = useObservePatchRegister();
  const { mutable } = useCapabilities();
  // FR-2.12: running the pass writes the register and prompts outbound calls, which is R1's
  // `settings.manage` — the same capability the route checks, so the button is never a tease.
  const canObserve = mutable.has('settings.manage');

  const rows = useMemo(() => {
    // Worst first: the register is read to decide what to patch now, so a critical record must not
    // sit below a dozen current ones because the API sorts by product name.
    return [...(patches.data ?? [])].sort(
      (a, b) =>
        rankOf(a) - rankOf(b) ||
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

  /**
   * The oldest check in the register is the honest age of everything on the screen.
   *
   * A `catalog` row has not been checked: its `checkedAt` is the entry document's edit time (or the
   * instance's), and reading it as "Checked 9 h ago" claimed a measurement nobody made — the same
   * substitution the provenance line exists to prevent. A row with no `source` is a record written
   * before the field existed and is left in, rather than silently dropped from the age.
   */
  const oldestCheck = useMemo(() => {
    const times = rows
      .filter((row) => row.source !== 'catalog')
      .map((row) => Date.parse(row.checkedAt))
      .filter(Number.isFinite);
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
            <div className="flex items-center gap-3">
              {oldestCheck === null ? null : (
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
              )}
              {canObserve ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => observe.mutate()}
                  disabled={observe.isPending}
                  icon={
                    <RefreshCw
                      className={observe.isPending ? 'animate-spin' : undefined}
                      aria-hidden
                    />
                  }
                >
                  {observe.isPending ? 'Observing…' : 'Observe now'}
                </Button>
              ) : null}
            </div>
          }
        />
        {/*
          `AsyncPanel` keeps the register readable through a failed refetch: the patch posture on
          screen is the last thing the API measured, and deleting it would turn "not checked" into
          a blank panel (ERR-04). A first failure still replaces the panel, because there is no
          posture to stand behind.
        */}
        {/*
          FR-2.12: the pass reports what it reached, not a bare success. "0 releases, 6 skipped" is a
          different answer from "6 entries observed", and an operator who pressed the button needs to
          tell them apart without reading the scheduler log.
        */}
        {observe.data ? (
          <p className="border-b border-line px-4 py-2 text-meta text-muted">
            Observed {observe.data.entries} entries: {observe.data.releases} with a newer release,{' '}
            {observe.data.advisories} with an open advisory, {observe.data.skipped} with no feed
            {observe.data.failed > 0 ? `, ${observe.data.failed} unreachable` : ''}.
          </p>
        ) : null}
        {observe.error ? (
          <p role="alert" className="border-b border-line px-4 py-2 text-meta text-danger">
            The observation could not run; the register keeps its previous values.
          </p>
        ) : null}
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
              // The wash is a "look here" signal, so it follows the same posture as the pill: a row
              // whose upstream release is older than what runs is not behind and must not be washed
              // in the warning colour.
              rowTone={(row) => {
                const posture = postureOf(row);
                if (posture !== 'behind') return 'default';
                return row.severity === 'critical' ? 'danger' : 'caution';
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
