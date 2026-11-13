import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  CheckCircle2,
  Circle,
  CircleDashed,
  Loader2,
  RotateCcw,
  Square,
  XCircle,
} from 'lucide-react';
import { useCancelJob, useJob, useJobLogs, useJobStream, useRetryJob } from '@seamnex/api-client';
import { canMutate, JOB_KIND_LABELS, JOB_STATE_LABELS } from '@seamnex/domain';
import {
  Badge,
  Button,
  Panel,
  PanelHeader,
  ProgressBar,
  Skeleton,
  StatusPill,
  buttonVariants,
} from '@seamnex/ui';
import { cn, formatRelative } from '@seamnex/utils';
import { QueryError } from '@seamnex/shell';
import { useSession } from '../../session';

function StepIcon({
  state,
}: {
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
}) {
  if (state === 'succeeded') return <CheckCircle2 className="size-3.5 text-success" aria-hidden />;
  if (state === 'failed') return <XCircle className="size-3.5 text-danger" aria-hidden />;
  if (state === 'running')
    return <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />;
  if (state === 'skipped') return <CircleDashed className="size-3.5 text-faint" aria-hidden />;
  return <Circle className="size-3.5 text-line-strong" aria-hidden />;
}

export function JobProgressPanel({
  jobId,
  onFinished,
  onRetried,
}: {
  jobId: string;
  onFinished?: () => void;
  /**
   * A retry does not restart this job: the API accepts a *new* one and returns its id. The panel
   * swallowed that id, so the operator stayed on the failed job — same progress bar, same log, no
   * acknowledgement — while a second job ran somewhere else.
   */
  onRetried?: (newJobId: string) => void;
}) {
  const { session } = useSession();
  // Cancel and retry mutate instance lifecycle state, so they follow the same matrix as
  // the instance buttons (R1 only); a read-only role sees the status, not the controls.
  const canControl = canMutate(session.role, 'instance.lifecycle');
  const job = useJob(jobId);
  // Live only while the job can still produce output; SSE drives updates and the polling
  // query remains the fallback, so the header copy never overstates what is happening.
  const live = job.data ? job.data.state === 'queued' || job.data.state === 'running' : true;
  const logs = useJobLogs(jobId, live);
  useJobStream(jobId, live);
  const cancel = useCancelJob();
  const retry = useRetryJob();
  /**
   * A refused cancel or retry used to render nothing, so the button looked dead: the mutation
   * state was never read. Both are part of the status the panel is reporting, so they share one
   * slot next to it.
   */
  const actionError = cancel.error ?? retry.error;
  const logRef = useRef<HTMLDivElement | null>(null);

  const logLines = logs.data ?? [];
  // Keyed on the sequence number, not the array length: the log is capped, so its length stops
  // changing once the retention window is full while new lines keep arriving.
  const firstSeq = logLines[0]?.seq ?? 0;
  const lastSeq = logLines[logLines.length - 1]?.seq ?? 0;
  // The stream keeps a bounded buffer, so an early seq means the beginning was dropped.
  const truncated = logLines.length > 0 && firstSeq > 1;

  /**
   * One announcement per state transition. The whole log used to be a polite live region, which
   * asked a screen reader to read out every appended line; what an operator actually needs to
   * hear is that the job started, failed or finished.
   */
  const [announcement, setAnnouncement] = useState('');
  const announcedState = useRef<string | null>(null);
  const jobState = job.data?.state ?? null;

  useEffect(() => {
    if (jobState === null || jobState === announcedState.current) return;
    announcedState.current = jobState;
    setAnnouncement(`${JOB_STATE_LABELS[jobState].label}.`);
  }, [jobState]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lastSeq]);

  useEffect(() => {
    if (job.data && (job.data.state === 'succeeded' || job.data.state === 'failed')) {
      onFinished?.();
    }
  }, [job.data, onFinished]);

  if (job.isPending) {
    return (
      <Panel inset>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-2 w-full" />
        <Skeleton className="mt-4 h-40 w-full" />
      </Panel>
    );
  }

  if (job.isError) return <QueryError error={job.error} onRetry={() => void job.refetch()} />;
  if (!job.data) return null;

  const data = job.data;
  const state = JOB_STATE_LABELS[data.state];
  const terminal =
    data.state === 'succeeded' || data.state === 'failed' || data.state === 'cancelled';

  return (
    <Panel>
      <PanelHeader
        eyebrow={`${JOB_KIND_LABELS[data.kind]} · ${data.id}`}
        title={data.label}
        description={data.summary}
        actions={
          <>
            <StatusPill tone={state.tone} label={state.label} pulse={data.state === 'running'} />
            {!terminal && canControl ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Square />}
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(data.id)}
              >
                Cancel
              </Button>
            ) : null}
            {data.state === 'failed' && canControl ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<RotateCcw />}
                disabled={retry.isPending}
                onClick={() =>
                  retry.mutate(data.id, { onSuccess: (accepted) => onRetried?.(accepted.jobId) })
                }
              >
                Retry
              </Button>
            ) : null}
            {!canControl && (!terminal || data.state === 'failed') ? (
              <span className="text-micro text-faint">lifecycle: platform administrator</span>
            ) : null}
          </>
        }
      />
      <div className="p-4">
        {/* State changes are announced here; the log below stays silent on purpose. */}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        {actionError ? (
          <div className="mb-3">
            <QueryError error={actionError} compact />
          </div>
        ) : null}
        <ProgressBar
          value={data.progress}
          label={data.state === 'running' ? 'Applying plan' : state.label}
          showValue
          tone={
            data.state === 'failed' ? 'danger' : data.state === 'succeeded' ? 'positive' : 'accent'
          }
        />

        <div className="mt-4 grid gap-4 lg:grid-cols-[240px_1fr]">
          <ol className="space-y-2" aria-label="Job steps">
            {data.steps.map((step) => (
              <li key={step.seq} className="flex items-start gap-2">
                <StepIcon state={step.state} />
                <div className="min-w-0">
                  <p
                    className={cn(
                      'text-meta font-medium',
                      step.state === 'pending' ? 'text-faint' : 'text-text',
                    )}
                  >
                    {step.name}
                  </p>
                  {step.message ? (
                    <p className="mt-0.5 text-micro leading-snug text-muted">{step.message}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>

          <div className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-mono text-faint label-caps">Job log</span>
              <span className="font-mono text-micro text-faint">
                {logLines.length} lines · {live ? 'streaming, polling fallback' : 'final'} · 30-day
                retention
              </span>
            </div>
            {/*
              `role="log"` without `aria-live`: the region is readable and navigable, but it no
              longer dictates that every appended line be announced. State transitions are
              announced by the status line above.
            */}
            <div
              ref={logRef}
              className="scroll-slim log-surface max-h-64 overflow-auto overscroll-contain rounded-sm border border-line-ink p-3"
              role="log"
              aria-label="Job log output"
            >
              {truncated ? (
                <p className="mb-1 font-mono text-micro text-ink-text-faint">
                  Earlier output is not shown · {logLines.length} lines retained
                </p>
              ) : null}
              {logLines.length === 0 ? (
                <p className="text-ink-text-faint">Waiting for the first log line…</p>
              ) : null}
              {logLines.map((line) => (
                <p
                  key={line.seq}
                  // The buffer is capped but still deep; letting the browser skip layout for the
                  // lines outside the viewport keeps scrolling smooth while output streams.
                  className={cn(
                    'whitespace-pre-wrap [contain-intrinsic-size:auto_1.15rem] [content-visibility:auto]',
                    line.stream === 'stderr'
                      ? 'text-log-stderr'
                      : line.stream === 'system'
                        ? 'text-log-system'
                        : 'text-log-text',
                  )}
                >
                  <span className="mr-2 text-ink-text-faint">{line.ts.slice(11, 19)}</span>
                  {line.line}
                </p>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="flex items-center gap-2 text-meta text-faint">
            {data.errorCode ? (
              <Badge tone="danger" size="sm">
                {data.errorCode}
              </Badge>
            ) : null}
            {data.errorMessage ??
              `Requested by ${data.requestedBy} · ${formatRelative(data.createdAt)}`}
          </p>
          {data.instanceId ? (
            <Link
              to={`/instances/${data.instanceId}`}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              Open instance
            </Link>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
