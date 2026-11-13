import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ArrowRight, CheckCircle2, CircleSlash, Clock } from 'lucide-react';
import { useCapacity, useInstances, useJobs, usePosture } from '@seamnex/api-client';
import type { Instance } from '@seamnex/domain';
import {
  INSTANCE_STATE_LABELS,
  JOB_STATE_LABELS,
  PLAIN_STATUS_LABELS,
  admissionVerdict,
  plainStatusFor,
} from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  CapacityRuler,
  DataTable,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  SplitLayout,
  Stat,
  StatusPill,
  buttonVariants,
  defineColumns,
} from '@seamnex/ui';
import { cn, formatNumber, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { useSession } from '../../session';
import { buildAttention } from './attention';

const TONE_CLASS = {
  danger: 'border-l-danger',
  caution: 'border-l-warning',
  info: 'border-l-info',
};

/**
 * The queue is a triage preview, not the full board: the posture screen lists every item with its
 * own action. Whatever is cut here is disclosed in the panel footer, so the heading's count and
 * the rows on screen can never disagree silently.
 */
const ATTENTION_PREVIEW = 6;

const rowKey = (row: Instance): string => row.id;

/**
 * The matrix compares the container truth of one deployment against what the portal says, so the
 * deployment is the row's destination. Its cell is the anchor — and the only one, because the cell
 * used to carry its own link around the product name, and linking the row as well would nest two
 * anchors and give each row two tab stops for one target (A11Y-04).
 */
function renderInstanceLink(row: Instance, className: string, children: ReactNode): ReactNode {
  return (
    <Link to={`/instances/${row.id}`} className={className}>
      {children}
    </Link>
  );
}

type CapacitySnapshot = NonNullable<ReturnType<typeof useCapacity>['data']>;

/**
 * The budget bars use the same admission function the API judged the deploy with (CL-09), so the
 * rulers and the verdict headline above them cannot disagree. `used` already contains the platform
 * reserve and `limits` the CPU oversubscription factor — dividing allocation by `host − reserve`
 * instead printed "14.5 / 12.0 vCPU" next to "1.5 vCPU headroom".
 *
 * Plain arithmetic on the payload, so it is a function rather than another memo: the panel calls it
 * with the data it is about to render, which is also what keeps the "no data, no bars" guard out of
 * the JSX.
 */
function admissionFor(data: CapacitySnapshot) {
  return admissionVerdict({
    host: { cpu: data.host.cpuCores, memoryMb: data.host.memoryMb, diskMb: data.host.diskMb },
    reserve: {
      cpu: data.platformReserve.cpuCores,
      memoryMb: data.platformReserve.memoryMb,
      diskMb: data.platformReserve.diskMb,
    },
    allocated: {
      cpu: data.allocated.cpuCores,
      memoryMb: data.allocated.memoryMb,
      diskMb: data.allocated.diskMb,
    },
    request: { cpu: 0, memoryMb: 0, diskMb: 0 },
    oversubscriptionFactor: data.oversubscriptionFactor,
  });
}

/**
 * Every cell reads only its row, so the array is a module constant — and because it is, filtering
 * or re-reading the fleet no longer rebuilds ninety cell closures per render (ARCH-04).
 *
 * No column marked `primary` is hidden by `hideBelow`: a row must keep its link on narrow screens.
 */
const columns = defineColumns<Instance>([
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
    // `renderInstanceLink` owns the anchor and its type styles.
    cell: (row) => row.product,
  },
  {
    id: 'state',
    header: 'Container truth',
    cell: (row) => {
      const label = INSTANCE_STATE_LABELS[row.state];
      return <StatusPill tone={label.tone} label={label.label} size="sm" />;
    },
  },
  {
    id: 'plain',
    header: 'Portal view',
    hideBelow: 'md',
    cell: (row) => {
      // The column says it mirrors the portal (FR-3.7), so it prints the portal's label and tone
      // rather than the internal enum: "Available", not "available".
      const status = PLAIN_STATUS_LABELS[plainStatusFor(row.state, row.ready)];
      return (
        <Badge tone={status.tone} size="sm">
          {status.label}
        </Badge>
      );
    },
  },
  {
    id: 'version',
    header: 'Version',
    hideBelow: 'lg',
    mono: true,
    cell: (row) => (
      <span>
        {row.currentVersion}
        {row.availableVersion && row.availableVersion !== row.currentVersion ? (
          <span className="ml-1 text-warning-strong">→ {row.availableVersion}</span>
        ) : null}
      </span>
    ),
  },
  {
    id: 'backup',
    header: 'Restore',
    hideBelow: 'xl',
    cell: (row) =>
      row.backup.verified ? (
        <span className="inline-flex items-center gap-1 text-meta text-success">
          <CheckCircle2 className="size-3.5" aria-hidden />{' '}
          {formatRelative(row.backup.lastVerifiedRestoreAt ?? '')}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-meta text-warning-strong">
          <AlertTriangle className="size-3.5" aria-hidden /> not verified
        </span>
      ),
  },
  {
    id: 'observed',
    header: 'Observed',
    align: 'right',
    hideBelow: 'lg',
    cell: (row) => (
      <span className="font-mono text-micro text-faint">{formatRelative(row.observedAt)}</span>
    ),
  },
]);

export function OverviewPage() {
  const { session } = useSession();
  const instances = useInstances();
  const jobs = useJobs();
  const capacity = useCapacity();
  const posture = usePosture();

  const rows = useMemo(() => instances.data ?? [], [instances.data]);
  const attention = useMemo(() => buildAttention(rows, posture.data), [rows, posture.data]);
  const available = rows.filter((instance) => instance.ready).length;
  const degraded = rows.filter((instance) => instance.state === 'degraded').length;
  const stopped = rows.filter((instance) => instance.state === 'stopped').length;
  // Derived, not asserted: entries can share a deployment, so both counts come from data.
  const entryCount = useMemo(
    () => new Set(rows.flatMap((instance) => instance.entryKeys)).size,
    [rows],
  );
  const attentionComplete = instances.isSuccess && posture.isSuccess;
  // A zero that came from a failed read is a claim, not a measurement: the cards only print
  // numbers the fleet query actually returned.
  const fleetRead = instances.isSuccess;
  const fleetNote = fleetRead ? null : instances.isPending ? 'loading…' : 'not readable';
  const hiddenAttention = Math.max(0, attention.length - ATTENTION_PREVIEW);
  const attentionPending = instances.isPending || posture.isPending;
  /*
   * "Nothing needs attention" is a conclusion, and it needs every input behind it. While the reads
   * are in flight the panel says so, and after a failure it reports the gap instead of the all-clear.
   */
  const attentionTitle = !attentionComplete
    ? attentionPending
      ? 'Checking readiness, restore and metadata'
      : 'Attention status unavailable'
    : attention.length === 0
      ? 'Nothing needs attention'
      : `${attention.length} items need an operator`;

  return (
    <Page>
      <PageHeader
        eyebrow={
          <>
            <span className="font-mono text-faint label-caps">Portfolio · {session.role}</span>
            {fleetRead ? (
              <Badge tone="accent" size="sm">
                {entryCount} entries / {rows.length} deployments
              </Badge>
            ) : (
              <Badge tone="neutral" size="sm">
                {instances.isPending ? 'loading fleet…' : 'fleet unavailable'}
              </Badge>
            )}
          </>
        }
        title="Portfolio overview"
        description="Capacity admission, readiness and the work that needs an operator — one screen, no shell access."
        actions={
          <>
            {/* Fleet-wide re-read. Per-instance on-demand observation lives on the detail page. */}
            <Button
              variant="secondary"
              size="sm"
              disabled={instances.isFetching}
              onClick={() => void instances.refetch()}
            >
              {instances.isFetching ? 'Reloading…' : 'Reload fleet'}
            </Button>
            {/*
              A link styled as a button, not a `<Button>` inside a `<Link>`: the nested form put a
              `<button>` inside an `<a>`, which is invalid HTML and exposes two competing roles to
              assistive technology for one action. `buttonVariants` is the design system's own
              escape hatch for a control that navigates.
            */}
            <Link to="/catalog" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
              Deploy a product
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </>
        }
      />

      {/* Two-up from 320px. One column cost ~470px of a phone screen for four numbers, which
          pushed the attention queue — the reason the screen exists — below the fold. */}
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          {
            label: 'Deployments',
            value: rows.length,
            hint: `${entryCount} domain entries`,
            tone: 'accent' as const,
          },
          {
            label: 'Ready',
            value: available,
            hint: 'running and ready',
            tone: 'positive' as const,
          },
          {
            label: 'Degraded',
            value: degraded,
            hint: 'containers up, app not ready',
            tone: degraded > 0 ? ('caution' as const) : ('neutral' as const),
          },
          {
            label: 'Stopped',
            value: stopped,
            hint: 'intentional, data retained',
            tone: 'neutral' as const,
          },
        ].map((stat) => (
          <Panel key={stat.label} inset>
            <Stat
              label={stat.label}
              value={fleetRead ? formatNumber(stat.value) : '—'}
              hint={fleetNote ?? stat.hint}
              tone={fleetRead ? stat.tone : 'neutral'}
            />
          </Panel>
        ))}
      </div>

      {/*
        The page-level problem panel is reserved for a fleet read that produced nothing. A failed
        *refetch* keeps the numbers on the cards and the rows in the matrix, and the matrix panel
        says the data is stale (ERR-04).
      */}
      {instances.isError && instances.data === undefined ? (
        <QueryError error={instances.error} onRetry={() => void instances.refetch()} />
      ) : null}

      {instances.isSuccess && rows.length === 0 ? (
        <Callout tone="info" title="Nothing is deployed yet" className="mb-3">
          Capacity, readiness and restore evidence are empty because there is no instance. Start
          from the catalog; the platform renders compose, health checks, volumes and the route for
          you.{' '}
          <Link to="/catalog" className="font-semibold text-link hover:underline">
            Browse the catalog
          </Link>
        </Callout>
      ) : null}

      {/*
        `items-start`: a grid row stretches its children to the tallest column, so a three-item
        queue left ~130px of empty panel under the last row while the rail beside it carried two
        panels. The panel ends where its content ends.
      */}
      <SplitLayout ratio="content" className="items-start">
        <Panel>
          <PanelHeader
            eyebrow="Attention queue"
            title={attentionTitle}
            description="Ranked by user impact. Every item links to the evidence and the corrective action."
            actions={
              <Link
                to="/governance/posture"
                className={buttonVariants({ variant: 'quiet', size: 'sm' })}
              >
                Posture board
              </Link>
            }
          />
          {posture.isPending || instances.isPending ? (
            <div className="p-4">
              <SkeletonLines lines={4} />
            </div>
          ) : null}
          {posture.isError ? (
            <div className="p-4">
              <QueryError error={posture.error} onRetry={() => void posture.refetch()} compact />
            </div>
          ) : null}
          {instances.isError ? (
            <div className="p-4">
              <QueryError
                error={instances.error}
                onRetry={() => void instances.refetch()}
                compact
              />
            </div>
          ) : null}
          {/* "Nothing needs attention" is only true when every input behind it loaded. */}
          {attentionComplete && attention.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-6 text-body text-muted">
              <CheckCircle2 className="size-4 text-success" aria-hidden /> All readiness, restore
              and metadata checks pass.
            </div>
          ) : null}
          {attention.length > 0 ? (
            <ul className="divide-y divide-line">
              {attention.slice(0, ATTENTION_PREVIEW).map((item) => (
                <li key={item.id} className={cn('border-l-2 px-4 py-3', TONE_CLASS[item.tone])}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-body font-semibold text-text">{item.title}</p>
                      <p className="mt-0.5 text-meta leading-relaxed text-muted">{item.detail}</p>
                    </div>
                    <Link
                      to={item.href}
                      className="inline-flex shrink-0 items-center gap-1 text-meta font-semibold text-link hover:underline"
                    >
                      {item.cta} <ArrowRight className="size-3" aria-hidden />
                    </Link>
                  </div>
                </li>
              ))}
              {hiddenAttention > 0 ? (
                <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <span className="text-meta text-muted">
                    {hiddenAttention} more item{hiddenAttention === 1 ? '' : 's'} not shown
                  </span>
                  <Link
                    to="/governance/posture"
                    className="inline-flex items-center gap-1 text-meta font-semibold text-link hover:underline"
                  >
                    Open the posture board <ArrowRight className="size-3" aria-hidden />
                  </Link>
                </li>
              ) : null}
            </ul>
          ) : null}
        </Panel>

        <div className="space-y-3">
          <Panel>
            <PanelHeader
              eyebrow="Admission"
              title="Host capacity"
              description={capacity.data?.verdict.headline}
              actions={
                <Link to="/capacity" className={buttonVariants({ variant: 'quiet', size: 'sm' })}>
                  Forecast
                </Link>
              }
            />
            <div className="space-y-3 p-4">
              <AsyncPanel
                query={capacity}
                loading={<SkeletonLines lines={3} />}
                loadingLabel="Loading host capacity"
              >
                {(data) => {
                  const verdict = admissionFor(data);
                  return (
                    <>
                      <CapacityRuler
                        label="CPU"
                        used={verdict.used.cpu}
                        total={verdict.limits.cpu}
                        unit="vCPU"
                      />
                      <CapacityRuler
                        label="Memory"
                        used={verdict.used.memoryMb / 1024}
                        total={verdict.limits.memoryMb / 1024}
                        unit="GB"
                      />
                      <CapacityRuler
                        label="Disk"
                        used={verdict.used.diskMb / 1024}
                        total={verdict.limits.diskMb / 1024}
                        unit="GB"
                      />
                      <p className="flex items-start gap-1.5 border-t border-line pt-2 text-micro leading-relaxed text-faint">
                        <CircleSlash className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span>
                          {data.verdict.reserveNote} The bars count allocation plus that reserve
                          against the admission limit; CPU caps may oversubscribe{' '}
                          {data.oversubscriptionFactor}×.
                        </span>
                      </p>
                    </>
                  );
                }}
              </AsyncPanel>
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              eyebrow="Recent activity"
              title="Jobs"
              actions={
                <Link to="/jobs" className={buttonVariants({ variant: 'quiet', size: 'sm' })}>
                  All jobs
                </Link>
              }
            />
            <div className="divide-y divide-line">
              {/*
                The panel's own empty copy stays a panel branch, not `DataTable`'s `empty` prop:
                there is no table here, and "no jobs yet" is a statement about the platform's
                history, not about a filter.
              */}
              <AsyncPanel
                query={jobs}
                loading={
                  <div className="p-4">
                    <SkeletonLines lines={4} />
                  </div>
                }
                loadingLabel="Loading recent jobs"
                empty={(data) =>
                  data.items.length === 0 && (
                    <p className="px-4 py-4 text-meta text-muted">
                      No jobs yet. Deployments and lifecycle actions appear here.
                    </p>
                  )
                }
              >
                {(data) =>
                  data.items.slice(0, 5).map((job) => (
                    <Link
                      key={job.id}
                      to={`/jobs/${job.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-paper-deep"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-meta font-medium text-text">
                          {job.label}
                        </span>
                        <span className="flex items-center gap-1 font-mono text-micro text-faint">
                          <Clock className="size-2.5" aria-hidden /> {formatRelative(job.createdAt)}
                        </span>
                      </span>
                      {/* Same label map as the jobs screen: the identifier is not a label. */}
                      <Badge tone={JOB_STATE_LABELS[job.state].tone} size="sm">
                        {JOB_STATE_LABELS[job.state].label}
                      </Badge>
                    </Link>
                  ))
                }
              </AsyncPanel>
            </div>
          </Panel>
        </div>
      </SplitLayout>

      <Panel className="mt-3">
        {/* FR-3.7: the description used to read "The portal shows plain language (FR-3.7); the
            console shows the underlying state." */}
        <PanelHeader
          eyebrow="Readiness matrix"
          title="Container truth versus the portal view"
          description="The portal shows plain language; the console shows the underlying state. Both are derived from the same snapshot."
          actions={
            <Link to="/instances" className={buttonVariants({ variant: 'quiet', size: 'sm' })}>
              Manage instances
            </Link>
          }
        />
        {/*
          A fatal read has to say why the matrix is missing rather than render an empty fleet, so it
          keeps its own copy; a failed *refetch* keeps the rows and gets the stale banner instead.
        */}
        <AsyncPanel
          query={instances}
          loading={
            <div className="p-4">
              <SkeletonLines lines={6} />
            </div>
          }
          loadingLabel="Loading the readiness matrix"
          renderError={() => (
            <p className="px-4 py-6 text-meta text-muted">
              The fleet could not be read, so there is no row to compare. Retry above.
            </p>
          )}
        >
          {(data) => (
            <DataTable
              columns={columns}
              rows={data}
              rowKey={rowKey}
              dense
              renderRowLink={renderInstanceLink}
            />
          )}
        </AsyncPanel>
      </Panel>
    </Page>
  );
}
