import { useMemo, useState } from 'react';
import { Terminal } from 'lucide-react';
import { useContainers, useContainerLogs } from '@seamnex/api-client';
import type { ContainerStatus, InstanceDetail } from '@seamnex/domain';
import { CONTAINER_STATE_LABELS } from '@seamnex/domain';
import {
  Badge,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Panel,
  PanelHeader,
  SkeletonLines,
  StatusPill,
  defineColumns,
  type Column,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

const containerRowKey = (row: ContainerStatus) => row.containerId;

/**
 * Every cell here reads only its row, so the array can live at module scope and `DataTable` sees the
 * same identity on every render — which is what stops a keystroke in a filter above from rebuilding
 * every cell of every row.
 */
const containerColumns = defineColumns<ContainerStatus>([
  {
    id: 'service',
    header: 'Service',
    cell: (row) => (
      <div>
        <span className="font-mono text-meta font-medium text-text">{row.service}</span>
        <span className="mt-0.5 block text-micro text-faint">{row.role}</span>
      </div>
    ),
  },
  {
    id: 'state',
    header: 'State',
    cell: (row) => {
      const label = CONTAINER_STATE_LABELS[row.state];
      return <StatusPill tone={label.tone} label={label.label} size="sm" />;
    },
  },
  {
    id: 'health',
    header: 'Health',
    cell: (row) => (
      <Badge
        tone={
          row.health === 'healthy' ? 'positive' : row.health === 'unhealthy' ? 'danger' : 'neutral'
        }
        size="sm"
      >
        {row.health}
      </Badge>
    ),
  },
  {
    id: 'restarts',
    header: 'Restarts',
    align: 'right',
    hideBelow: 'md',
    mono: true,
    cell: (row) => (
      <span className={row.restartCount > 0 ? 'text-warning-strong' : 'text-muted'}>
        {row.restartCount}
      </span>
    ),
  },
  {
    id: 'uptime',
    header: 'Started',
    hideBelow: 'md',
    cell: (row) => (
      <span className="text-micro text-muted">
        {row.startedAt ? formatRelative(row.startedAt) : '—'}
      </span>
    ),
  },
  {
    id: 'exit',
    header: 'Last exit',
    hideBelow: 'xl',
    cell: (row) =>
      row.exitCode === null ? (
        <span className="text-micro text-faint">—</span>
      ) : (
        <span className="text-micro text-danger">
          {row.exitCode} · {row.exitReason}
        </span>
      ),
  },
  {
    id: 'digest',
    header: 'Image digest',
    hideBelow: 'lg',
    mono: true,
    cell: (row) => <span className="text-micro text-faint">{row.imageDigest.slice(0, 18)}…</span>,
  },
]);

export function ContainersTab({ instance }: { instance: InstanceDetail }) {
  const containers = useContainers(instance.id);
  const [logContainer, setLogContainer] = useState<string | null>(null);
  const logs = useContainerLogs(instance.id, logContainer);

  /**
   * Deliberately **not** hoisted: the "Logs" cell closes over this panel's drawer setter. A stale
   * closure here is worse than an unstable identity, so the array stays memoised in the component
   * with the handler it closes over.
   */
  const columns = useMemo<Column<ContainerStatus>[]>(
    () => [
      ...containerColumns,
      {
        id: 'logs',
        header: '',
        align: 'right',
        cell: (row) => (
          <Button
            size="sm"
            variant="quiet"
            icon={<Terminal />}
            onClick={() => setLogContainer(row.containerId)}
          >
            Logs
          </Button>
        ),
      },
    ],
    [setLogContainer],
  );

  return (
    <Panel>
      {/* FR-1.31 · FR-1.34 — requirement ids, developer-only; they used to be the panel eyebrow. */}
      <PanelHeader
        title="Container truth"
        description="State, health, restarts, uptime, exit reason and the running digest — all without host shell access."
        actions={
          <Button size="sm" variant="quiet" onClick={() => void containers.refetch()}>
            Refresh
          </Button>
        }
      />
      <AsyncPanel
        query={containers}
        loading={
          <div className="p-4">
            <SkeletonLines lines={6} />
          </div>
        }
        loadingLabel="Loading the container list"
        renderError={(error, retry) => (
          <div className="p-4">
            <QueryError error={error} onRetry={retry} />
          </div>
        )}
        // No table here: the panel has no header row to preserve, so the empty copy belongs to the
        // async region rather than to `DataTable`.
        empty={(rows) =>
          rows.length === 0 && (
            <div className="p-4">
              <EmptyState
                title="No containers reported"
                description="The stack has not been created yet. Start the instance to provision its containers."
              />
            </div>
          )
        }
      >
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={containerRowKey} dense />}
      </AsyncPanel>

      <Drawer
        open={logContainer !== null}
        onOpenChange={(open) => (open ? undefined : setLogContainer(null))}
        title="Recent container logs"
        description="Secrets are masked. Retention is 30 days; the last 500 lines are shown."
        width="lg"
      >
        {/* The drawer's content only mounts while it is open, which is also when
            `useContainerLogs` is enabled — so this panel is never mounted against a disabled query. */}
        <AsyncPanel
          query={logs}
          loading={<SkeletonLines lines={8} />}
          loadingLabel="Loading the container logs"
          renderError={(error, retry) => <QueryError error={error} onRetry={retry} />}
        >
          {(lines) => (
            <div className="log-surface scroll-slim max-h-[65vh] overflow-auto overscroll-contain rounded-sm border border-line-ink p-3">
              {lines.map((line) => (
                <p key={line.seq} className="whitespace-pre-wrap">
                  <span className="mr-2 text-ink-text-faint">{line.ts.slice(11, 19)}</span>
                  {line.line}
                </p>
              ))}
            </div>
          )}
        </AsyncPanel>
      </Drawer>
    </Panel>
  );
}
