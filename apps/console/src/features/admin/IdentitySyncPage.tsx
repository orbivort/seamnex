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
 * AC-48's target, judged only against a measured propagation.
 *
 * `p95LatencyMs` is the mirror write — how long the directory upserts took — and it was doing duty
 * as the five-minute figure. Those are different intervals: a cycle can mirror in 84 s and still
 * leave every product entitlement pending. The pass/fail verdict now needs a sample count, and a run
 * that measured nothing cannot pass a target it never observed.
 */
function propagationTone(run: SyncRun | undefined): 'positive' | 'caution' | 'danger' {
  if (run === undefined) return 'caution';
  if (run.state === 'failed') return 'danger';
  if (run.p95PropagationMs === null || run.propagationSamples === 0) return 'caution';
  return run.p95PropagationMs <= LATENCY_TARGET_MS ? 'positive' : 'caution';
}

/** "not measured" is a distinct statement from "0 ms", and the screen says which one applies. */
function propagationLabel(run: SyncRun | undefined): string {
  if (run === undefined) return 'not measured';
  if (run.p95PropagationMs === null || run.propagationSamples === 0) {
    return 'no membership change measured';
  }
  return `${formatLatency(run.p95PropagationMs)} over ${run.propagationSamples} change(s)`;
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
            <Badge tone={propagationTone(latest)} size="sm">
              propagation {propagationLabel(latest)}
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
            {start.data.propagationSamples === 0
              ? `No membership change was measured, so this cycle does not evidence the five-minute target. Mirror write p95 ${formatLatency(start.data.p95LatencyMs)}.`
              : `${start.data.changes} change(s); propagation p95 ${formatLatency(
                  start.data.p95PropagationMs ?? 0,
                )} over ${start.data.propagationSamples} sample(s); mirror write p95 ${formatLatency(start.data.p95LatencyMs)}.`}
            {start.data.errors.length > 0 ? ` ${start.data.errors.join(' · ')}` : ''}
          </Callout>
        </div>
      ) : null}

      <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Panel inset>
          <Stat label="Changes (last)" value={latest?.changes ?? '—'} hint="membership deltas" />
        </Panel>
        <Panel inset>
          <Stat
            label="Propagation p95"
            value={
              latest === undefined || latest.p95PropagationMs === null
                ? 'Not measured'
                : formatLatency(latest.p95PropagationMs)
            }
            tone={propagationTone(latest)}
            hint={
              latest === undefined || latest.propagationSamples === 0
                ? 'no change to measure · target ≤ 5 min'
                : `${latest.propagationSamples} change(s) · target ≤ 5 min`
            }
          />
        </Panel>
        <Panel inset>
          <Stat
            label="Mirror write p95"
            value={latest ? formatLatency(latest.p95LatencyMs) : '—'}
            hint="directory upserts · not the AC-48 figure"
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
        <PanelHeader
          eyebrow="Evidence"
          title="Recent sync runs"
          description={`${runs.data?.length ?? 0} retained cycle(s). Propagation is measured from the membership change to the applied entitlement.`}
        />
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
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={propagationTone(run)} size="sm">
                      propagation{' '}
                      {run.p95PropagationMs === null
                        ? 'not measured'
                        : formatLatency(run.p95PropagationMs)}
                    </Badge>
                    <Tag mono>mirror {formatLatency(run.p95LatencyMs)}</Tag>
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
