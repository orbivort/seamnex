import { Play } from 'lucide-react';
import { useRunSync, useSyncRuns } from '@seamnex/api-client';
import type { SyncRun } from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  Stat,
  StatusPill,
  Tag,
} from '@seamnex/ui';
import { formatDateTime, formatLatency } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

/** AC-48: a membership change has to reach the products within five minutes, p95. */
const LATENCY_TARGET_MS = 300_000;

/**
 * `failed` is not `partial`. A cycle that never read the directory mirrored nobody, and reporting it
 * in the same caution tone as a cycle that reconciled everyone but one route is how an outage hides
 * behind a word.
 */
const RUN_TONE: Record<SyncRun['state'], 'positive' | 'caution' | 'danger'> = {
  succeeded: 'positive',
  partial: 'caution',
  failed: 'danger',
};

/**
 * The target verdict, not just the number.
 *
 * An aborted cycle has no samples, so its p95 is a literal 0 — a green `0 ms / 300 s` on a run that
 * mirrored nobody is the opposite of evidence, so a failed run cannot pass the target it never
 * measured.
 */
function latencyTone(run: SyncRun | undefined): 'positive' | 'caution' | 'danger' {
  if (run === undefined) return 'caution';
  if (run.state === 'failed') return 'danger';
  return run.p95LatencyMs <= LATENCY_TARGET_MS ? 'positive' : 'caution';
}

export function IdentitySyncPage() {
  const runs = useSyncRuns();
  const start = useRunSync();
  const latest = runs.data?.[0];

  return (
    <Page>
      {/* FR-2.4 · AC-48 — requirement ids, developer-only; they used to be the page eyebrow and
          are not part of the rendered interface. */}
      <PageHeader
        title="Identity sync"
        description="Evidence that group membership changes reach the platform and the products within one sync cycle."
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Play />}
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending ? 'Running…' : 'Run sync now'}
          </Button>
        }
        meta={
          <>
            <Badge tone={latencyTone(latest)} size="sm">
              p95 {latest ? formatLatency(latest.p95LatencyMs) : '—'} / 300 s
            </Badge>
            <Tag mono>
              {latest?.users ?? 0} users · {latest?.groups ?? 0} groups
            </Tag>
          </>
        }
      />

      {start.isError ? <QueryError error={start.error} compact /> : null}
      {start.data ? (
        <div className="mb-3">
          <Callout
            tone={RUN_TONE[start.data.state]}
            title={`Sync ${start.data.id} ${start.data.state}`}
          >
            {start.data.changes} change(s) propagated in {formatLatency(start.data.p95LatencyMs)}{' '}
            p95.
            {start.data.errors.length > 0 ? ` ${start.data.errors.join(' · ')}` : ''}
          </Callout>
        </div>
      ) : null}

      <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Panel inset>
          <Stat label="Sync cycles" value={runs.data?.length ?? '—'} hint="retained evidence" />
        </Panel>
        <Panel inset>
          <Stat label="Changes (last)" value={latest?.changes ?? '—'} hint="membership deltas" />
        </Panel>
        <Panel inset>
          <Stat
            label="p95 latency"
            value={latest ? formatLatency(latest.p95LatencyMs) : '—'}
            tone={latencyTone(latest)}
            hint="target ≤ 5 minutes"
          />
        </Panel>
        <Panel inset>
          <Stat
            label="Errors (last)"
            value={latest?.errors.length ?? '—'}
            tone={
              latest === undefined
                ? 'caution'
                : latest.state === 'failed'
                  ? 'danger'
                  : latest.errors.length > 0
                    ? 'caution'
                    : 'positive'
            }
            hint="listed under the run"
          />
        </Panel>
      </div>

      <Panel>
        <PanelHeader eyebrow="Evidence" title="Recent sync runs" />
        <AsyncPanel
          query={runs}
          loading={
            <div className="p-4">
              <SkeletonLines lines={5} />
            </div>
          }
          loadingLabel="Loading sync runs"
          empty={(data) =>
            data.length === 0 && (
              <div className="p-4">
                <EmptyState
                  title="No sync runs recorded"
                  description="The first cycle runs on bootstrap. Run one now to mirror the directory and prove the 5-minute p95 target."
                  action={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => start.mutate()}
                      disabled={start.isPending}
                    >
                      Run sync now
                    </Button>
                  }
                />
              </div>
            )
          }
        >
          {(data) => (
            <ul className="divide-y divide-line">
              {data.map((run) => (
                <li
                  key={run.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                >
                  <div>
                    <p className="font-mono text-meta text-text">{run.id}</p>
                    <p className="mt-0.5 text-micro text-muted">
                      {formatDateTime(run.startedAt)} · {run.users} users · {run.groups} groups ·{' '}
                      {run.changes} changes
                    </p>
                    {run.errors.length > 0 ? (
                      <p className="mt-1 text-micro text-warning-strong">
                        {run.errors.join(' · ')}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Tag mono>p95 {formatLatency(run.p95LatencyMs)}</Tag>
                    <StatusPill tone={RUN_TONE[run.state]} label={run.state} size="sm" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </AsyncPanel>
      </Panel>
    </Page>
  );
}
