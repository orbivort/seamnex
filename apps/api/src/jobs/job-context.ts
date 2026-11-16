import { Logger } from '@nestjs/common';
import type { LogStream } from '@seamnex/db';
import type { PipelineContext, PipelineRegistry } from './pipeline-registry';

/**
 * The job surface a context needs. Declared structurally, and `import type`-only, so this file can
 * be used by the worker and by the scheduler's recovery pass without either importing the other.
 */
type JobAccess = {
  appendLog(jobId: string, stream: LogStream, line: string): Promise<unknown>;
  get(jobId: string): Promise<{ state: string }>;
};

export type JobContextInput = {
  readonly jobId: string;
  readonly kind: string;
  readonly instanceId: string | null;
  readonly requestedBy: string | null | undefined;
  readonly payload: Record<string, unknown>;
};

const logger = new Logger('job-pipeline');

/**
 * The context every stage receives.
 *
 * One builder for the worker and the recovery pass: a reclaimed job has to settle its module's
 * resource exactly as a live failure does, and two copies of this mapping would drift on the one
 * field that matters (`action`, which a generic lifecycle job carries in its payload).
 */
export function jobContext(jobs: JobAccess, input: JobContextInput): PipelineContext {
  return {
    jobId: input.jobId,
    instanceId: input.instanceId ?? '',
    actorId: input.requestedBy ?? 'deploy-worker',
    action: typeof input.payload.action === 'string' ? input.payload.action : input.kind,
    payload: input.payload,
    log: (stream, line) => jobs.appendLog(input.jobId, stream, line).then(() => undefined),
    cancelled: async () => (await jobs.get(input.jobId)).state === 'cancelled',
  };
}

/**
 * The owning module settles its own resource after a failed job. Best effort: a handler failure
 * must never replace the job's real error, and a failed job must still be recorded as failed.
 *
 * Shared with the abandonment pass, because a job whose worker disappeared has failed just as
 * surely as one that threw — and without this a restore that lost its worker would leave
 * `restore_run.state = 'running'` for ever, which is the dead end FR-1.36 forbids.
 */
export async function settlePipelineFailure(
  pipelines: PipelineRegistry,
  kind: string,
  context: PipelineContext,
  cause?: unknown,
): Promise<void> {
  const handler = pipelines.failureHandler(kind);
  if (handler === undefined) return;
  try {
    await handler(context, cause);
  } catch (error) {
    logger.error(
      {
        jobId: context.jobId,
        err: error instanceof Error ? error.message : String(error),
      },
      'failure handler failed; the job is still marked failed',
    );
  }
}
