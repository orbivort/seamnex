import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Gauge } from 'lucide-react';
import { useCapacity, useCapacityForecast } from '@seamnex/api-client';
import type { CapacityThresholds, InstanceCapacity } from '@seamnex/domain';
import { admissionVerdict } from '@seamnex/domain';
import {
  Badge,
  Callout,
  CapacityRuler,
  DataTable,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  Sparkline,
  SplitLayout,
  Stat,
  defineColumns,
  rulerBands,
} from '@seamnex/ui';
import { cn, formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

/** Fallback bands when a snapshot predates the configurable thresholds. */
const DEFAULT_THRESHOLDS: CapacityThresholds = {
  cpuPercent: 75,
  memoryPercent: 90,
  diskPercent: 85,
};

/**
 * The colour a measured figure earns, against the threshold the platform alerts at (FR-4.5).
 *
 * Ten points past the threshold is the same step the alert pass escalates at, so a red cell on this
 * board and a critical notification describe the same condition.
 */
function consumptionTone(percent: number | undefined, threshold: number): string {
  if (percent === undefined) return 'text-faint';
  if (percent >= threshold + 10) return 'text-danger';
  if (percent >= threshold) return 'text-warning-strong';
  return 'text-muted';
}

/**
 * Allocated versus consumed (FR-4.5).
 *
 * The pair lives in one cell with the measured figure on the second line: two numeric columns per
 * axis would be six numbers across a table that already carries a name, so the reader loses the one
 * comparison the table exists for. `not measured` is a word, not a dash-and-zero — an absent sample
 * and an idle product are different facts.
 */
function capacityColumns(thresholds: CapacityThresholds) {
  const axis = (
    id: string,
    header: string,
    allocated: (row: InstanceCapacity) => string,
    consumed: (row: InstanceCapacity) => string | undefined,
    percentOf: (row: InstanceCapacity) => number | undefined,
    threshold: number,
    hideBelow?: 'sm' | 'md' | 'lg',
  ) => ({
    id,
    header,
    align: 'right' as const,
    mono: true,
    ...(hideBelow === undefined ? {} : { hideBelow }),
    cell: (row: InstanceCapacity) => {
      const percent = percentOf(row);
      return (
        <span className="block">
          <span className="block text-meta text-text">{allocated(row)}</span>
          <span className={cn('block text-micro', consumptionTone(percent, threshold))}>
            {percent === undefined
              ? 'not measured'
              : `${consumed(row) ?? '—'} used · ${Math.round(percent)} %`}
          </span>
        </span>
      );
    },
  });

  return defineColumns<InstanceCapacity>([
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
      header: 'Instance',
      primary: true,
      cell: (row) => (
        <>
          {row.product}
          <span className="ml-1.5 font-mono text-micro text-faint">{row.slug}</span>
        </>
      ),
    },
    {
      id: 'state',
      header: 'State',
      hideBelow: 'md',
      cell: (row) => <span className="text-meta text-muted">{row.state}</span>,
    },
    axis(
      'cpu',
      'CPU',
      (row) => `${row.cpuCores} vCPU`,
      (row) =>
        row.cpuConsumedMilli === undefined
          ? undefined
          : `${(row.cpuConsumedMilli / 1000).toFixed(2)} vCPU`,
      (row) =>
        row.cpuConsumedMilli === undefined || row.cpuCores <= 0
          ? undefined
          : (row.cpuConsumedMilli / (row.cpuCores * 1000)) * 100,
      thresholds.cpuPercent,
    ),
    axis(
      'memory',
      'Memory',
      (row) => `${(row.memoryMb / 1024).toFixed(1)} GB`,
      (row) =>
        row.memoryConsumedMb === undefined
          ? undefined
          : `${(row.memoryConsumedMb / 1024).toFixed(1)} GB`,
      (row) =>
        row.memoryConsumedMb === undefined || row.memoryMb <= 0
          ? undefined
          : (row.memoryConsumedMb / row.memoryMb) * 100,
      thresholds.memoryPercent,
      'sm',
    ),
    axis(
      'disk',
      'Disk',
      (row) => `${(row.diskMb / 1024).toFixed(0)} GB`,
      (row) =>
        row.diskConsumedMb === undefined
          ? undefined
          : `${(row.diskConsumedMb / 1024).toFixed(1)} GB`,
      (row) =>
        row.diskConsumedMb === undefined || row.diskQuotaMb <= 0
          ? undefined
          : (row.diskConsumedMb / row.diskQuotaMb) * 100,
      thresholds.diskPercent,
      'lg',
    ),
    {
      id: 'measured',
      header: 'Measured',
      align: 'right',
      hideBelow: 'xl',
      cell: (row) => (
        <span className="text-micro text-faint">
          {row.measuredAt ? formatRelative(row.measuredAt) : 'no sample'}
        </span>
      ),
    },
  ]);
}

const capacityRowKey = (row: InstanceCapacity) => row.instanceId;

/**
 * The anchor now belongs to `DataTable`, not to the cell: an inner `<Link>` inside the primary cell
 * would nest two anchors once `renderRowLink` wraps it.
 */
const capacityRowLink = (row: InstanceCapacity, className: string, children: ReactNode) => (
  <Link to={`/instances/${row.instanceId}`} className={className}>
    {children}
  </Link>
);

export function CapacityPage() {
  const capacity = useCapacity();
  const forecast = useCapacityForecast();
  const snapshot = capacity.data;

  /**
   * The bands the board draws and the thresholds the alert pass reads are the same three numbers,
   * carried in the snapshot (FR-4.5). Keyed on primitives so a new snapshot object does not rebuild
   * every cell while the figures it describes are unchanged.
   */
  const cpuThreshold = snapshot?.thresholds?.cpuPercent ?? DEFAULT_THRESHOLDS.cpuPercent;
  const memoryThreshold = snapshot?.thresholds?.memoryPercent ?? DEFAULT_THRESHOLDS.memoryPercent;
  const diskThreshold = snapshot?.thresholds?.diskPercent ?? DEFAULT_THRESHOLDS.diskPercent;
  const columns = useMemo(
    () =>
      capacityColumns({
        cpuPercent: cpuThreshold,
        memoryPercent: memoryThreshold,
        diskPercent: diskThreshold,
      }),
    [cpuThreshold, memoryThreshold, diskThreshold],
  );

  /*
   * The rulers must read on the scale the verdict was computed with (CL-09), exactly as the
   * overview does: allocation **plus** the platform reserve, measured against the admission limit
   * (CPU × oversubscription, memory 95 %, disk 90 %). Dividing allocation alone by
   * `host − reserve` printed "10.0 / 11.0 vCPU" next to a "4.0 vCPU headroom" headline on the same
   * screen, and on a fuller host it printed more used than allocatable.
   */
  const admission = useMemo(() => {
    if (!snapshot) return null;
    return admissionVerdict({
      host: {
        cpu: snapshot.host.cpuCores,
        memoryMb: snapshot.host.memoryMb,
        diskMb: snapshot.host.diskMb,
      },
      reserve: {
        cpu: snapshot.platformReserve.cpuCores,
        memoryMb: snapshot.platformReserve.memoryMb,
        diskMb: snapshot.platformReserve.diskMb,
      },
      allocated: {
        cpu: snapshot.allocated.cpuCores,
        memoryMb: snapshot.allocated.memoryMb,
        diskMb: snapshot.allocated.diskMb,
      },
      request: { cpu: 0, memoryMb: 0, diskMb: 0 },
      oversubscriptionFactor: snapshot.oversubscriptionFactor,
    });
  }, [snapshot]);

  return (
    <Page>
      {/* FR-1.9 · FR-4.5 — requirement ids, developer-only; they used to be the page eyebrow and
          are not part of the rendered interface. */}
      <PageHeader
        title="Capacity"
        description="Host totals, per-instance accounting and the admission verdict used before any deployment starts. Memory and disk are never oversubscribed."
        actions={
          /*
           * No snapshot is not a shortfall: an unreadable read must not render as a capacity
           * verdict, the same rule the overview applies to a failed fleet read.
           */
          snapshot ? (
            <Badge tone={snapshot.verdict.admissible ? 'positive' : 'danger'} size="md">
              {snapshot.verdict.admissible ? 'admissible' : 'shortfall'}
            </Badge>
          ) : capacity.isError ? (
            <Badge tone="neutral" size="md">
              capacity unavailable
            </Badge>
          ) : null
        }
        meta={
          snapshot ? (
            <>
              <span className="text-meta text-muted">{snapshot.verdict.headline}</span>
              <span className="font-mono text-micro text-faint">
                snapshot {formatDateTime(snapshot.ts)}
              </span>
            </>
          ) : null
        }
      />

      <AsyncPanel
        query={capacity}
        loading={
          <Panel inset>
            <SkeletonLines lines={8} />
          </Panel>
        }
        loadingLabel="Loading the capacity snapshot"
        renderError={(error, retry) => <QueryError error={error} onRetry={retry} />}
      >
        {(data) => (
          <>
            <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Panel inset>
                <Stat
                  label="Host CPU"
                  value={`${data.host.cpuCores} vCPU`}
                  hint={`${data.platformReserve.cpuCores} vCPU reserved`}
                />
              </Panel>
              <Panel inset>
                <Stat
                  label="Host memory"
                  value={`${(data.host.memoryMb / 1024).toFixed(1)} GB`}
                  hint={[
                    `${(data.platformReserve.memoryMb / 1024).toFixed(1)} GB reserved`,
                    data.memoryAvailableMb === undefined
                      ? null
                      : `${(data.memoryAvailableMb / 1024).toFixed(1)} GB free`,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
                />
              </Panel>
              <Panel inset>
                <Stat
                  label="Host disk"
                  value={`${(data.host.diskMb / 1024).toFixed(1)} GB`}
                  hint={[
                    `${(data.platformReserve.diskMb / 1024).toFixed(1)} GB reserved`,
                    data.diskAvailableMb === undefined
                      ? null
                      : `${(data.diskAvailableMb / 1024).toFixed(1)} GB free`,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
                />
              </Panel>
              <Panel inset>
                <Stat
                  label="Allocated"
                  value={`${data.allocated.cpuCores.toFixed(1)} vCPU`}
                  tone="accent"
                  hint={`${(data.allocated.memoryMb / 1024).toFixed(1)} GB memory`}
                />
              </Panel>
            </div>

            <SplitLayout ratio="content" className="mb-3">
              <Panel>
                <PanelHeader
                  eyebrow="Admission"
                  title="Rulers"
                  description={`Allocation plus the platform reserve against the admission limit; CPU caps may oversubscribe ${data.oversubscriptionFactor}×. Per-instance alerts fire at CPU ${data.thresholds?.cpuPercent ?? DEFAULT_THRESHOLDS.cpuPercent} %, memory ${data.thresholds?.memoryPercent ?? DEFAULT_THRESHOLDS.memoryPercent} % and disk ${data.thresholds?.diskPercent ?? DEFAULT_THRESHOLDS.diskPercent} % of the declared shape.`}
                />
                <div className="space-y-4 p-4">
                  {admission ? (
                    <>
                      <CapacityRuler
                        label="CPU"
                        used={admission.used.cpu}
                        total={admission.limits.cpu}
                        unit="vCPU"
                        thresholds={rulerBands(cpuThreshold)}
                      />
                      <CapacityRuler
                        label="Memory"
                        used={admission.used.memoryMb / 1024}
                        total={admission.limits.memoryMb / 1024}
                        unit="GB"
                        thresholds={rulerBands(memoryThreshold)}
                      />
                      <CapacityRuler
                        label="Disk"
                        used={admission.used.diskMb / 1024}
                        total={admission.limits.diskMb / 1024}
                        unit="GB"
                        thresholds={rulerBands(diskThreshold)}
                      />
                    </>
                  ) : null}
                  <Callout tone="info" title="Admission rule">
                    {data.verdict.detail}
                    {data.diskPath ? (
                      <p className="mt-1.5 font-mono text-micro leading-relaxed text-faint">
                        Disk measured on {data.diskPath}
                        {data.diskAvailableMb === undefined
                          ? ''
                          : ` — ${(data.diskAvailableMb / 1024).toFixed(1)} GB free of ${(data.host.diskMb / 1024).toFixed(1)} GB`}
                      </p>
                    ) : null}
                  </Callout>
                </div>
              </Panel>

              <Panel>
                <PanelHeader
                  eyebrow="14-day outlook"
                  title="Committed growth"
                  description="Projection from the current admission utilisation and known upcoming deployments."
                />
                <div className="space-y-3 p-4">
                  {/* The outlook is its own async region: a failed forecast must not replace the
                      snapshot it is drawn beside, and a slow one must not blank it. */}
                  <AsyncPanel
                    query={forecast}
                    loading={<SkeletonLines lines={4} />}
                    loadingLabel="Loading the capacity forecast"
                    renderError={(error, retry) => <QueryError error={error} onRetry={retry} />}
                  >
                    {(points) => (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-meta text-muted">CPU</span>
                          <Sparkline
                            values={points.map((point) => point.cpuPercent)}
                            label="CPU forecast"
                            tone="accent"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-meta text-muted">Memory</span>
                          <Sparkline
                            values={points.map((point) => point.memoryPercent)}
                            label="Memory forecast"
                            tone="positive"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-meta text-muted">Disk</span>
                          <Sparkline
                            values={points.map((point) => point.diskPercent)}
                            label="Disk forecast"
                            tone="caution"
                          />
                        </div>
                        <p className="flex items-start gap-1.5 border-t border-line pt-2 text-micro leading-relaxed text-faint">
                          <Gauge className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                          Forecast is a planning aid, not a reservation. The planner re-checks
                          admission at deploy time.
                        </p>
                      </>
                    )}
                  </AsyncPanel>
                </div>
              </Panel>
            </SplitLayout>

            <Panel>
              <PanelHeader
                eyebrow="Per instance"
                title="Allocation and consumption"
                description="Top line: the resources reserved per deployment; stopped instances keep their reservation until deleted. Second line: what the running containers actually use, measured by the status sampler."
              />
              <p className="border-b border-line px-4 py-2 text-micro leading-relaxed text-faint">
                Alert bands: CPU {cpuThreshold} %, memory {memoryThreshold} %, disk {diskThreshold}{' '}
                % of the declared shape. A figure past the band is amber, ten points past it is red
                — the same step the platform escalates at. “not measured” means no fresh sample, not
                idle.
              </p>
              <DataTable
                columns={columns}
                rows={data.instanceUsage}
                rowKey={capacityRowKey}
                renderRowLink={capacityRowLink}
                dense
                empty={
                  <EmptyState
                    title="Nothing is allocated yet"
                    description="The ledger fills as instances are deployed. The host still reports its totals and the platform reserve."
                  />
                }
              />
              <div className="flex items-center justify-end border-t border-line px-3 py-2">
                <Link
                  to="/instances"
                  className="inline-flex items-center gap-1 text-meta font-semibold text-link hover:underline"
                >
                  Manage instances <ArrowUpRight className="size-3" aria-hidden />
                </Link>
              </div>
            </Panel>
          </>
        )}
      </AsyncPanel>
    </Page>
  );
}
