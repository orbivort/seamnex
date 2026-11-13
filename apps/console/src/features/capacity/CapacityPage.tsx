import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Gauge } from 'lucide-react';
import { useCapacity, useCapacityForecast } from '@seamnex/api-client';
import type { InstanceCapacity } from '@seamnex/domain';
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
} from '@seamnex/ui';
import { formatDateTime } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

/**
 * Module scope: the ledger cells read only their row, and the identity cell is the one that carries
 * the row link (see `capacityRowLink`), which is why it has no `hideBelow`.
 */
const CAPACITY_COLUMNS = defineColumns<InstanceCapacity>([
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
  {
    id: 'cpu',
    header: 'CPU',
    align: 'right',
    mono: true,
    cell: (row) => <span className="text-meta text-text">{row.cpuCores} vCPU</span>,
  },
  {
    id: 'memory',
    header: 'Memory',
    align: 'right',
    hideBelow: 'sm',
    mono: true,
    cell: (row) => (
      <span className="text-meta text-text">{(row.memoryMb / 1024).toFixed(1)} GB</span>
    ),
  },
  {
    id: 'disk',
    header: 'Disk',
    align: 'right',
    hideBelow: 'lg',
    mono: true,
    cell: (row) => <span className="text-meta text-text">{(row.diskMb / 1024).toFixed(0)} GB</span>,
  },
]);

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
                  description={`Thresholds at 75% and 90%. Allocation plus the platform reserve, against the admission limit; CPU caps may oversubscribe ${data.oversubscriptionFactor}×.`}
                />
                <div className="space-y-4 p-4">
                  {admission ? (
                    <>
                      <CapacityRuler
                        label="CPU"
                        used={admission.used.cpu}
                        total={admission.limits.cpu}
                        unit="vCPU"
                      />
                      <CapacityRuler
                        label="Memory"
                        used={admission.used.memoryMb / 1024}
                        total={admission.limits.memoryMb / 1024}
                        unit="GB"
                      />
                      <CapacityRuler
                        label="Disk"
                        used={admission.used.diskMb / 1024}
                        total={admission.limits.diskMb / 1024}
                        unit="GB"
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
                title="Allocation ledger"
                description="Reserved resources per deployment; stopped instances keep their reservation until deleted."
              />
              <DataTable
                columns={CAPACITY_COLUMNS}
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
