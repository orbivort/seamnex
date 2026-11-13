import { useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useReplayRun, useWorkflowRun, useWorkflowRuns } from '@seamnex/api-client';
import type { Workflow, WorkflowRun } from '@seamnex/domain';
import { RUN_STATE_LABELS, TRIGGER_LABELS } from '@seamnex/domain';
import {
  Badge,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  SkeletonLines,
  StatusPill,
  Tag,
  defineColumns,
  type Column,
} from '@seamnex/ui';
import { formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

/**
 * Module scope: these cells read only their row. The actions column is added per render instead,
 * because it closes over this panel's drawer state and replay mutation.
 *
 * A run has no route of its own — "Inspect" opens a drawer, which is a selection rather than a
 * navigation — so there is no `primary` column and no row link: the row is not a tab stop and the
 * button is the only activation.
 */
const RUN_COLUMNS = defineColumns<WorkflowRun>([
  {
    id: 'id',
    header: 'Run',
    width: '96px',
    mono: true,
    cell: (row) => <span className="text-micro text-faint">{row.id}</span>,
  },
  {
    id: 'state',
    header: 'State',
    cell: (row) => {
      const label = RUN_STATE_LABELS[row.state];
      return (
        <StatusPill
          tone={label.tone}
          label={label.label}
          size="sm"
          pulse={row.state === 'running'}
        />
      );
    },
  },
  {
    id: 'trigger',
    header: 'Trigger',
    hideBelow: 'md',
    cell: (row) => (
      <Badge tone="neutral" size="sm">
        {TRIGGER_LABELS[row.trigger] ?? row.trigger}
      </Badge>
    ),
  },
  {
    id: 'started',
    header: 'Started',
    hideBelow: 'sm',
    cell: (row) => <span className="text-micro text-muted">{formatRelative(row.startedAt)}</span>,
  },
  {
    id: 'duration',
    header: 'Duration',
    hideBelow: 'lg',
    mono: true,
    cell: (row) => (
      <span className="text-micro text-muted">{(row.durationMs / 1000).toFixed(1)} s</span>
    ),
  },
  {
    id: 'records',
    header: 'Records',
    align: 'right',
    hideBelow: 'lg',
    mono: true,
    cell: (row) => <span className="text-micro text-muted">{row.recordsProcessed}</span>,
  },
  {
    id: 'nodes',
    header: 'Nodes',
    hideBelow: 'xl',
    cell: (row) => (
      <span className="font-mono text-micro text-faint">
        {row.nodes.filter((node) => node.state === 'succeeded').length}/{row.nodes.length} ok
      </span>
    ),
  },
]);

const runRowKey = (row: WorkflowRun) => row.id;

/**
 * How often an unsettled run is re-read. The API settles a run on its own poll against n8n
 * (`SEAMNEX_N8N_EXECUTION_POLL_MS`, 10 s by default), so this only has to be quicker than an
 * operator's patience, not than the executor.
 */
export const RUN_POLL_INTERVAL_MS = 4_000;

/** A run that has an outcome still to come. Read-only runs never enter `waiting_approval`. */
const isInFlight = (run: WorkflowRun): boolean =>
  run.state === 'running' || run.state === 'queued' || run.state === 'waiting_approval';

export function WorkflowRunsPanel({ workflow }: { workflow: Workflow }) {
  // Polling is a property of the data, not of the screen: it starts when a run is in flight and
  // stops by itself once every row is terminal.
  const runs = useWorkflowRuns(workflow.id, (rows) =>
    (rows ?? []).some(isInFlight) ? RUN_POLL_INTERVAL_MS : false,
  );
  const replay = useReplayRun(workflow.id);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const detail = useWorkflowRun(openRun ?? '');

  // The mutation result is a fresh object per render; these two are the stable parts of it, so they
  // are what the memo depends on.
  const { mutate: replayRun, isPending: replaying } = replay;

  // R2: the actions column drives the drawer and the replay mutation, so it stays memoised with the
  // fields it reads rather than being hoisted with a stale copy of them.
  const columns = useMemo<Column<WorkflowRun>[]>(
    () => [
      ...RUN_COLUMNS,
      {
        id: 'actions',
        header: '',
        align: 'right',
        cell: (row) => (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="quiet" onClick={() => setOpenRun(row.id)}>
              Inspect
            </Button>
            {row.state === 'failed' ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<RotateCcw />}
                disabled={replaying}
                onClick={() => replayRun(row.id)}
              >
                Replay
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [replayRun, replaying],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-muted">
          Idempotency keys are preserved on replay. Failed runs stay inspectable for 30 days. A run
          still in flight refreshes itself; the button covers the rest.
        </p>
        <Button size="sm" variant="quiet" onClick={() => void runs.refetch()}>
          Refresh runs
        </Button>
      </div>

      {replay.isError ? <QueryError error={replay.error} compact /> : null}
      <AsyncPanel
        query={runs}
        loading={<SkeletonLines lines={5} />}
        loadingLabel="Loading the run history"
        renderError={(error, retry) => <QueryError error={error} onRetry={retry} />}
        // No table header to preserve here: the empty copy is the region's own branch.
        empty={(rows) =>
          rows.length === 0 && (
            <EmptyState
              compact
              title="No runs recorded"
              description="Activate the workflow and trigger it, or run it manually to see per-node history."
            />
          )
        }
      >
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={runRowKey} dense />}
      </AsyncPanel>

      <Drawer
        open={openRun !== null}
        onOpenChange={(open) => (open ? undefined : setOpenRun(null))}
        title={detail.data ? `Run ${detail.data.id}` : 'Run detail'}
        description={
          detail.data ? `${detail.data.workflowName} · version ${detail.data.version}` : undefined
        }
        width="lg"
      >
        {/* The drawer only mounts while it is open, which is also the only time `useWorkflowRun`
            is enabled — so this panel never sits on a disabled query. */}
        <AsyncPanel
          query={detail}
          loading={<SkeletonLines lines={6} />}
          loadingLabel="Loading the run detail"
          renderError={(error, retry) => <QueryError error={error} onRetry={retry} />}
        >
          {(run) => (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill
                  tone={RUN_STATE_LABELS[run.state].tone}
                  label={RUN_STATE_LABELS[run.state].label}
                />
                <Tag mono>{TRIGGER_LABELS[run.trigger] ?? run.trigger}</Tag>
                <Tag mono>{run.idempotencyKey}</Tag>
                {run.replayOf ? <Tag mono>replay of {run.replayOf}</Tag> : null}
              </div>

              <dl className="grid grid-cols-2 gap-3 text-meta">
                <div>
                  <dt className="text-faint label-caps-sans">Started</dt>
                  <dd className="text-text">{formatDateTime(run.startedAt)}</dd>
                </div>
                <div>
                  <dt className="text-faint label-caps-sans">Duration</dt>
                  <dd className="text-text">{(run.durationMs / 1000).toFixed(1)} s</dd>
                </div>
                <div>
                  <dt className="text-faint label-caps-sans">Records</dt>
                  <dd className="text-text">{run.recordsProcessed}</dd>
                </div>
                <div>
                  <dt className="text-faint label-caps-sans">Finished</dt>
                  <dd className="text-text">
                    {run.finishedAt ? formatDateTime(run.finishedAt) : '—'}
                  </dd>
                </div>
              </dl>

              <div>
                <p className="mb-1 font-mono text-faint label-caps">Per-node outcome</p>
                <ol className="divide-y divide-line rounded-sm border border-line">
                  {run.nodes.map((node) => (
                    <li key={node.nodeId} className="px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-meta font-medium text-text">{node.label}</span>
                        <span className="flex items-center gap-2">
                          <Badge
                            tone={
                              node.state === 'succeeded'
                                ? 'positive'
                                : node.state === 'failed'
                                  ? 'danger'
                                  : 'neutral'
                            }
                            size="sm"
                          >
                            {node.state}
                          </Badge>
                          <span className="font-mono text-micro text-faint">
                            attempt {node.attempt} · {(node.durationMs / 1000).toFixed(1)} s ·{' '}
                            {node.records} rec
                          </span>
                        </span>
                      </div>
                      {node.error ? (
                        <p className="mt-1 rounded-xs bg-danger-soft px-2 py-1 font-mono text-micro text-danger-strong">
                          {node.error}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>

              {run.error ? (
                <p className="rounded-sm border border-danger-border bg-danger-wash px-3 py-2 text-meta text-danger-strong">
                  {run.error}
                </p>
              ) : null}
            </div>
          )}
        </AsyncPanel>
      </Drawer>
    </div>
  );
}
