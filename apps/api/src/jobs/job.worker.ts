import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Worker, type Job as BullJob } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { JOB_QUEUE_NAME } from './job-lane';
import { JobService } from './job.service';
import { canTransitionJob } from './job-state';
import { PipelineRegistry, type PipelineContext, type PipelineStage } from './pipeline-registry';
import { AppError } from '../common/problem/app-error';

type Payload = { jobId: string; lane: string; kind: string; manual?: boolean };

/**
 * The deploy-worker role (4A.5).
 *
 * The worker owns the lifecycle of a job — dequeue, queued → running, per-step progress, failure and
 * cancellation — and nothing else. *What* a job does is a stage list from `PipelineRegistry`,
 * registered by the module that owns the kind. An unregistered kind fails the job with an explicit
 * code instead of reporting success having done nothing.
 *
 * Concurrency 4 is the design's global deploy/build limit (§6.3). Per-instance serialisation is
 * already guaranteed by the database's one-active-job index, so a lane cannot be run twice.
 */
@Injectable()
export class JobWorker implements OnApplicationShutdown {
  private readonly logger = new Logger('job-worker');
  private worker: Worker<Payload> | undefined;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(PipelineRegistry) private readonly pipelines: PipelineRegistry,
  ) {}

  start(): void {
    if (this.worker !== undefined) return;
    this.worker = new Worker<Payload>(JOB_QUEUE_NAME, async (job) => this.process(job), {
      connection: this.redis,
      concurrency: 4,
    });
    this.worker.on('failed', (job, error) => {
      this.logger.error({ jobId: job?.id, err: error.message }, 'worker job failed');
    });
    /*
     * Practice 2.13: `Worker` is an EventEmitter and BullMQ emits `error` for a lost Redis
     * connection or a processor-level fault. Without a listener Node turns that event into an
     * uncaught exception, and the role lifecycle answers it with `exit(1)` — killing a worker in
     * the middle of a stage. Subscribing keeps a recoverable transport blip a log line instead of
     * a half-applied deployment.
     */
    this.worker.on('error', (error: Error) => {
      this.logger.error({ err: error.message }, 'job worker error');
    });
    this.logger.log('job worker started (concurrency 4)');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: BullJob<Payload>): Promise<void> {
    const { jobId } = job.data;
    if (job.data.manual === true) {
      this.logger.debug({ jobId }, 'manual job left for its creator');
      return;
    }

    const current = await this.jobs.get(jobId);
    if (current.state !== 'queued') {
      // A cancelled job must not start because a stale Redis entry survived.
      this.logger.warn({ jobId, state: current.state }, 'skipping job that is no longer queued');
      return;
    }

    await this.jobs.transition(jobId, 'running', { actorId: 'deploy-worker' });
    await this.jobs.appendLog(jobId, 'system', `job ${current.kind} started`);

    const context = this.contextFor(
      jobId,
      current.kind,
      current.instance_id,
      current.requested_by,
      current.payload,
    );

    try {
      await this.execute(context, current.kind);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobs.appendLog(jobId, 'stderr', message).catch(() => undefined);

      await this.settleFailure(current.kind, context, error);

      // A cancelled job cannot become failed (`cancelled` is terminal). Transitioning anyway threw
      // a second error that replaced the real one, so the guard is the transition table itself.
      const latest = await this.jobs.get(jobId).catch(() => undefined);
      if (latest !== undefined && canTransitionJob(latest.state, 'failed')) {
        await this.jobs
          .transition(jobId, 'failed', {
            errorCode: error instanceof AppError ? error.code : 'JOB_FAILED',
            errorDetail: message,
            actorId: 'deploy-worker',
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * The owning module settles its own resource after a failed job. Best effort: a handler failure
   * must never replace the job's real error, and a failed job must still be recorded as failed.
   */
  private async settleFailure(
    kind: string,
    context: PipelineContext,
    cause?: unknown,
  ): Promise<void> {
    const handler = this.pipelines.failureHandler(kind);
    if (handler === undefined) return;
    try {
      await handler(context, cause);
    } catch (error) {
      this.logger.error(
        { jobId: context.jobId, kind, err: error instanceof Error ? error.message : String(error) },
        'failure handler failed; the job is still marked failed',
      );
    }
  }

  /**
   * Cancellation settles the instance the same way a failure does.
   *
   * A cancelled deploy used to leave its instance in whichever transitional state the stopped stage
   * had set — `verifying`, `applying` — while no job was running. Every lifecycle action in the
   * console is gated on "not busy", so the deployment became a dead end that only a delete could
   * clear, and the fleet showed "Verifying" for a job that no longer existed. The registered handler
   * replaces a transitional state only, so cancelling a job that never touched the instance (still
   * queued, or refused before its first stage) stays a no-op.
   */
  private async settleCancellation(kind: string, context: PipelineContext): Promise<void> {
    await this.jobs
      .appendLog(
        context.jobId,
        'system',
        'job cancelled; the instance state is settled so it can be redeployed',
      )
      .catch(() => undefined);
    await this.settleFailure(kind, context);
  }

  private contextFor(
    jobId: string,
    kind: string,
    instanceId: string | null,
    requestedBy: string | null | undefined,
    payload: Record<string, unknown>,
  ): PipelineContext {
    return {
      jobId,
      instanceId: instanceId ?? '',
      actorId: requestedBy ?? 'deploy-worker',
      action: typeof payload.action === 'string' ? payload.action : kind,
      payload,
      log: (stream, line) => this.jobs.appendLog(jobId, stream, line).then(() => undefined),
      cancelled: async () => (await this.jobs.get(jobId)).state === 'cancelled',
    };
  }

  private async execute(context: PipelineContext, kind: string): Promise<void> {
    const { jobId } = context;
    const stages = this.pipelines.stages(kind);
    if (stages === undefined) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail: `No pipeline is registered for job kind "${kind}".`,
        remediation:
          'This is a defect: the module that owns the kind must register its stages at boot. Nothing was applied.',
      });
    }

    for (const [index, stage] of stages.entries()) {
      const state = await this.jobs.get(jobId);
      if (state.state === 'cancelled') {
        await this.skipRemaining(jobId, stages.slice(index), 'job cancelled');
        await this.settleCancellation(kind, context);
        return;
      }

      await this.jobs.setStep(jobId, index + 1, 'running');
      await this.jobs.appendLog(
        jobId,
        'stdout',
        `step ${index + 1}/${stages.length}: ${stage.step}`,
      );

      try {
        await stage.run(context);
      } catch (error) {
        await this.jobs.setStep(
          jobId,
          index + 1,
          'failed',
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }

      const after = await this.jobs.get(jobId);
      if (after.state === 'cancelled') {
        await this.jobs.setStep(jobId, index + 1, 'skipped', 'job cancelled');
        await this.jobs.appendLog(jobId, 'system', 'job cancelled by request');
        await this.settleCancellation(kind, context);
        return;
      }
      await this.jobs.setStep(jobId, index + 1, 'succeeded');
    }

    const final = await this.jobs.get(jobId);
    if (final.state === 'cancelled') return;

    await this.jobs.appendLog(jobId, 'system', 'job finished successfully');
    await this.jobs.transition(jobId, 'succeeded', { actorId: 'deploy-worker' });
  }

  private async skipRemaining(
    jobId: string,
    stages: readonly PipelineStage[],
    message: string,
  ): Promise<void> {
    const all = await this.jobs.steps(jobId);
    for (const step of all) {
      if (step.state === 'pending') await this.jobs.setStep(jobId, step.seq, 'skipped', message);
    }
    this.logger.debug({ jobId, remaining: stages.length }, 'job cancelled before its next stage');
  }
}
