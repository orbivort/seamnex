import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  withTransaction,
  type DeploymentJobRow,
  type JobLogRow,
  type JobState,
  type JobStepRow,
  type LogStream,
} from '@seamnex/db';
import type { Pool, PoolClient } from 'pg';
import type { Redis } from 'ioredis';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';
import { METRICS } from '../common/metrics/metrics';
import type { Metrics } from '../common/metrics/metrics';
import { AppError } from '../common/problem/app-error';
import { maskDeep } from '../common/logging/masking';
import { AUDIT_SERVICE, type AuditService } from '../modules/m17-audit/audit.contract';
import { JOB_QUEUE_NAME, laneForInstance, queueJobId } from './job-lane';
import { canTransitionJob, cancellableAt, isTerminalJobState } from './job-state';

export type CreateJobInput = {
  readonly kind: string;
  readonly instanceId?: string | null;
  readonly idempotencyKey?: string | null;
  readonly requestedBy?: string;
  readonly payload?: Record<string, unknown>;
  /** Ordered step names. A synthetic job uses four; a deploy uses the design's twelve. */
  readonly steps: readonly string[];
};

export type CreateJobResult = {
  readonly job: DeploymentJobRow;
  /** False when an idempotency key replayed an existing job (no second job was created). */
  readonly created: boolean;
};

export const JOB_LOG_CHANNEL_PREFIX = 'seamnex:job:';

/**
 * Job model (design §6.3, deliverable 1.4).
 *
 * Creation, steps, logs, cancellation and idempotency are all transactional: the audit row and the
 * job row commit together, and a constraint violation is translated into a problem document instead
 * of a 500. Redis is only the execution engine — losing Redis loses progress delivery, not history.
 */
@Injectable()
export class JobService implements OnApplicationShutdown {
  private readonly logger = new Logger('jobs');
  private readonly queue: Queue;
  private queueClosed = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.queue = new Queue(JOB_QUEUE_NAME, { connection: this.redis });
  }

  async create(input: CreateJobInput): Promise<CreateJobResult> {
    const lane = laneForInstance(input.instanceId);
    const requestedBy = input.requestedBy ?? 'system';

    try {
      const job = await withTransaction(this.pool, async (tx) => {
        // Uniform lock order for every audited transaction: the audit chain first, business rows
        // second. Two orders is how a 40P01 deadlock arrives months later, in production only.
        await this.audit.lockChain(tx);

        const inserted = await tx.query<DeploymentJobRow>(
          `INSERT INTO deployment_job (instance_id, lane, kind, state, idempotency_key, requested_by, payload)
           VALUES ($1, $2, $3, 'queued', $4, $5, $6::jsonb)
           RETURNING id, instance_id, lane, kind, state, idempotency_key, requested_by, error_code, error_detail,
                     payload, created_at, started_at, finished_at`,
          [
            input.instanceId ?? null,
            lane,
            input.kind,
            input.idempotencyKey ?? null,
            requestedBy,
            JSON.stringify(input.payload ?? {}),
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('job insert returned no row');

        for (const [index, name] of input.steps.entries()) {
          await tx.query(
            'INSERT INTO job_step (job_id, seq, name, state) VALUES ($1, $2, $3, $4)',
            [row.id, index + 1, name, 'pending'],
          );
        }

        await this.audit.append(
          {
            action: 'job.created',
            actorType: 'service',
            actorId: requestedBy,
            targetType: 'job',
            targetId: row.id,
            outcome: 'success',
            detail: { kind: input.kind, lane, instanceId: input.instanceId ?? null },
          },
          tx,
        );

        return row;
      });

      this.metrics.jobsCreated.labels(job.kind, job.lane).inc();
      await this.enqueue(job);
      return { job, created: true };
    } catch (error) {
      // Only a uniqueness violation on the idempotency index means "this is a replay". Replaying
      // on *any* error hid connection failures behind a second, unrelated query.
      if (isConstraint(error, 'deployment_job_idempotency_unique')) {
        return this.replayIdempotent(input);
      }

      if (
        isConstraint(error, 'deployment_job_one_active_per_instance') ||
        isConstraint(error, 'deployment_job_one_active_platform')
      ) {
        const blocking = await this.blockingJob(input.instanceId ?? null, lane);
        throw new AppError({
          code: 'INSTANCE_BUSY',
          status: 409,
          detail:
            blocking === undefined
              ? `Another job is already active on lane ${lane}.`
              : `Another job is already active on lane ${lane} (blocking job ${blocking}).`,
        });
      }

      throw error;
    }
  }

  async transition(
    jobId: string,
    to: JobState,
    options: { errorCode?: string; errorDetail?: string; actorId?: string } = {},
  ): Promise<DeploymentJobRow> {
    return withTransaction(this.pool, (tx) => this.transitionIn(tx, jobId, to, options));
  }

  private async transitionIn(
    tx: PoolClient,
    jobId: string,
    to: JobState,
    options: { errorCode?: string; errorDetail?: string; actorId?: string },
  ): Promise<DeploymentJobRow> {
    await this.audit.lockChain(tx);
    const job = await this.lockJob(tx, jobId);

    if (job.state === to) return job;
    if (!canTransitionJob(job.state, to)) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        status: 409,
        detail: `A job in state ${job.state} cannot become ${to}.`,
      });
    }

    const updated = await tx.query<DeploymentJobRow>(
      `UPDATE deployment_job
          SET state = $2,
              started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
              finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE finished_at END,
              error_code = COALESCE($3, error_code),
              error_detail = COALESCE($4, error_detail)
        WHERE id = $1
        RETURNING *`,
      [jobId, to, options.errorCode ?? null, options.errorDetail ?? null],
    );

    await this.audit.append(
      {
        action: `job.${to}`,
        actorType: 'service',
        actorId: options.actorId ?? 'system',
        targetType: 'job',
        targetId: jobId,
        outcome: to === 'failed' ? 'failure' : 'success',
        detail: { from: job.state, to, errorCode: options.errorCode ?? null },
      },
      tx,
    );

    this.metrics.jobTransitions.labels(job.state, to).inc();
    return updated.rows[0] ?? job;
  }

  private async lockJob(tx: PoolClient, jobId: string): Promise<DeploymentJobRow> {
    const current = await tx.query<DeploymentJobRow>(
      'SELECT * FROM deployment_job WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    const job = current.rows[0];
    if (job === undefined)
      throw new AppError({ code: 'NOT_FOUND', status: 404, detail: 'No such job.' });
    return job;
  }

  /**
   * Step transitions and cancellation serialise on the job row. Without this, `cancel` could read
   * "apply has not started" and then lose the race to the worker's own `apply` update — the exact
   * ordering the design forbids.
   */
  async setStep(
    jobId: string,
    seq: number,
    state: JobStepRow['state'],
    message?: string,
  ): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      const job = await this.lockJob(tx, jobId);
      // Marking a step `skipped` is what a cancelled job does; every other move stops.
      if (job.state === 'cancelled' && state !== 'skipped') return;

      await tx.query(
        `UPDATE job_step
            SET state = $3,
                started_at = CASE WHEN $3 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
                finished_at = CASE WHEN $3 IN ('succeeded', 'failed', 'skipped') THEN now() ELSE finished_at END,
                message = COALESCE($4, message)
          WHERE job_id = $1 AND seq = $2`,
        [jobId, seq, state, message ?? null],
      );
    });
  }

  /**
   * Appends one line and publishes it. Persist first, publish second: a missed publish costs
   * latency, a published line that was never stored costs a lie.
   */
  async appendLog(jobId: string, stream: LogStream, line: string): Promise<JobLogRow> {
    const masked = maskDeep(line);
    const row = await withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [jobId]);
      const inserted = await tx.query<JobLogRow>(
        `INSERT INTO job_log (job_id, seq, stream, line)
         SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3 FROM job_log WHERE job_id = $1
         RETURNING id, job_id, seq, ts, stream, line`,
        [jobId, stream, masked],
      );
      const created = inserted.rows[0];
      if (created === undefined) throw new Error('job_log insert returned no row');
      return created;
    });

    await this.redis
      .publish(
        `${JOB_LOG_CHANNEL_PREFIX}${jobId}`,
        JSON.stringify({
          id: String(row.id),
          seq: row.seq,
          stream: row.stream,
          line: row.line,
          ts: row.ts.toISOString(),
        }),
      )
      .catch(() => undefined);

    return row;
  }

  /**
   * Cancellation is decided and applied in one transaction that holds the job row. A step cannot
   * move to `apply` between the check and the transition, so "cancellation before apply" is a
   * property of the commit rather than a race the caller usually wins.
   */
  async cancel(jobId: string, actorId: string): Promise<DeploymentJobRow> {
    return withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const job = await this.lockJob(tx, jobId);

      if (job.state === 'cancelled') return job;
      if (!canTransitionJob(job.state, 'cancelled')) {
        throw new AppError({
          code: 'STATE_CONFLICT',
          status: 409,
          detail: `A job in state ${job.state} cannot be cancelled.`,
        });
      }

      const steps = await tx.query<JobStepRow>(
        'SELECT * FROM job_step WHERE job_id = $1 ORDER BY seq',
        [jobId],
      );
      if (!cancellableAt(steps.rows)) {
        throw new AppError({
          code: 'STATE_CONFLICT',
          status: 409,
          detail:
            'This job has already applied its change; cancellation would need a compensating rollback.',
        });
      }

      return this.transitionIn(tx, jobId, 'cancelled', { actorId });
    });
  }

  async retry(jobId: string, actorId: string): Promise<CreateJobResult> {
    const job = await this.get(jobId);
    if (!isTerminalJobState(job.state) || job.state === 'succeeded') {
      throw new AppError({
        code: 'STATE_CONFLICT',
        status: 409,
        detail: 'Only a failed or cancelled job can be retried.',
      });
    }
    const steps = (await this.steps(jobId)).map((step) => step.name);
    return this.create({
      kind: job.kind,
      instanceId: job.instance_id,
      requestedBy: actorId,
      payload: { ...job.payload, retryOf: job.id },
      steps,
    });
  }

  async get(jobId: string): Promise<DeploymentJobRow> {
    const result = await this.pool.query<DeploymentJobRow>(
      'SELECT * FROM deployment_job WHERE id = $1',
      [jobId],
    );
    const job = result.rows[0];
    if (job === undefined)
      throw new AppError({ code: 'NOT_FOUND', status: 404, detail: 'No such job.' });
    return job;
  }

  async steps(jobId: string): Promise<JobStepRow[]> {
    const result = await this.pool.query<JobStepRow>(
      'SELECT * FROM job_step WHERE job_id = $1 ORDER BY seq',
      [jobId],
    );
    return result.rows;
  }

  async logs(jobId: string, afterId = '0', limit = 200): Promise<JobLogRow[]> {
    // `Last-Event-ID` is a client-supplied header. A non-numeric value must not become a cast
    // error thrown after the SSE response has already been committed.
    const cursor = /^\d+$/.test(afterId) ? afterId : '0';
    const result = await this.pool.query<JobLogRow>(
      `SELECT id, job_id, seq, ts, stream, line
         FROM job_log
        WHERE job_id = $1 AND id > $2::bigint
        ORDER BY id
        LIMIT $3`,
      [jobId, cursor, limit],
    );
    return result.rows;
  }

  /**
   * Re-enqueues jobs that are queued in the database but not in Redis — a job created while Redis
   * was down, or a worker that died before picking it up. Runs from the scheduler role.
   */
  async redispatchQueued(limit = 25): Promise<number> {
    const result = await this.pool.query<DeploymentJobRow>(
      `SELECT * FROM deployment_job
        WHERE state = 'queued' AND created_at < now() - interval '10 seconds'
        ORDER BY created_at
        LIMIT $1`,
      [limit],
    );
    for (const job of result.rows) await this.enqueue(job);
    return result.rowCount ?? 0;
  }

  /** Idempotency keys live for 24 hours (design §6.3): nulling the key ends the window. */
  async reapIdempotencyKeys(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE deployment_job
          SET idempotency_key = NULL
        WHERE idempotency_key IS NOT NULL
          AND created_at < now() - interval '24 hours'`,
    );
    return result.rowCount ?? 0;
  }

  /** Idempotent: the scheduler and the Nest lifecycle hook both stop the queue. */
  async close(): Promise<void> {
    if (this.queueClosed) return;
    this.queueClosed = true;
    await this.queue.close();
  }

  /**
   * The API role builds the queue (it creates jobs) and used to leave it open, which is a process
   * that never exits after a drain. Every role now closes it through the lifecycle hook.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  private async enqueue(job: DeploymentJobRow): Promise<void> {
    try {
      await this.queue.add(
        'run',
        {
          jobId: job.id,
          lane: job.lane,
          kind: job.kind,
          // A `manual` job is created for observation (tests, operator drills): the worker must not
          // consume it, otherwise two writers own the same state machine.
          manual: job.payload.manual === true,
        },
        {
          jobId: queueJobId(job.lane, job.id),
          attempts: 1,
          removeOnComplete: 500,
          removeOnFail: 1_000,
        },
      );
    } catch (error) {
      // The database remains the queue of record: `redispatchQueued` retries this job.
      this.logger.warn(
        { jobId: job.id, err: error instanceof Error ? error.message : String(error) },
        'could not enqueue job; the scheduler will redispatch it',
      );
    }
  }

  /**
   * Replays the job a key already created — but only for the same request. A key reused with a
   * different payload is a client bug that must be reported, not silently answered with the old
   * job (design §6.3: `409 idempotency_conflict`).
   */
  private async replayIdempotent(input: CreateJobInput): Promise<CreateJobResult> {
    const key = input.idempotencyKey;
    if (key === null || key === undefined) throw new Error('idempotency replay without a key');

    const existing = await this.pool.query<DeploymentJobRow>(
      'SELECT * FROM deployment_job WHERE idempotency_key = $1',
      [key],
    );
    const job = existing.rows[0];
    if (job === undefined) {
      // The conflicting insert has not committed yet. The caller retries; the next attempt finds it.
      throw new AppError({
        code: 'INSTANCE_BUSY',
        status: 409,
        detail: 'A job with this idempotency key is being created; retry once it is visible.',
      });
    }

    const matches = await this.pool.query(
      `SELECT 1 FROM deployment_job WHERE idempotency_key = $1 AND payload = $2::jsonb`,
      [key, JSON.stringify(input.payload ?? {})],
    );
    if (matches.rowCount === 0) {
      throw new AppError({
        code: 'IDEMPOTENCY_CONFLICT',
        status: 409,
        detail: 'The idempotency key was reused with a different request body.',
      });
    }

    return { job, created: false };
  }

  private async blockingJob(instanceId: string | null, lane: string): Promise<string | undefined> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM deployment_job
        WHERE state IN ('queued', 'running')
          AND (($1::uuid IS NOT NULL AND instance_id = $1::uuid) OR ($2::text IS NOT NULL AND instance_id IS NULL AND lane = $2))
        LIMIT 1`,
      [instanceId, lane],
    );
    return result.rows[0]?.id;
  }
}

function isConstraint(error: unknown, constraint: string): boolean {
  const candidate = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  return (
    (candidate.code === '23505' && candidate.constraint === constraint) ||
    (candidate.cause?.code === '23505' && candidate.cause.constraint === constraint)
  );
}
