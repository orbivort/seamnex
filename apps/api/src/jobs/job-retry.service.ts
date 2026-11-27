import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { METRICS } from '../common/metrics/metrics';
import type { Metrics } from '../common/metrics/metrics';
import { AppError } from '../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../modules/m17-audit/audit.contract';
import { JobService } from './job.service';
import { jobContext, settlePipelineFailure } from './job-context';
import {
  ABANDONED_FAILURE_CODE,
  isTransientJobError,
  TRANSIENT_JOB_ERROR_CODES,
} from './job-failure';
import { PipelineRegistry } from './pipeline-registry';

/**
 * NFR-6.5 — a transient failure must not need a person.
 *
 * Retry is a platform object, not a queue option: a successor `deployment_job` references the failed
 * one, so the history stays append-only and every attempt is auditable (ADR-BE-34). Two rules make
 * that safe:
 *
 *   - **Only classified-transient failures** are retried (`job-failure.ts`). A blocked policy, a
 *     missing secret or a state conflict repeats identically and is left to the operator.
 *   - **Only before the point of no return.** A deploy, reconfigure, upgrade or rollback that had
 *     started its `apply` stage may already have changed the host; re-running it from stage one is
 *     not a retry, it is a second deployment. Those are left for a human — the console already
 *     offers "Retry" on a failed job.
 *
 * The stage that marks that boundary is read from `PipelineRegistry` rather than from
 * `job_step.name`, because a step row holds the display label (`Apply`) and only the registry holds
 * the machine name (`apply`).
 */

/** Kinds whose retry from stage 1 is only safe before `apply`. */
const APPLY_GATED_KINDS: ReadonlySet<string> = new Set([
  'deploy',
  'reconfigure',
  'upgrade',
  'rollback',
]);

/**
 * Kinds a human decides about.
 *
 * A restore deletes and rewrites data on the way in, and `dsar` executes an erasure: repeating
 * either automatically turns one bad artefact into two. The platform restore kinds are excluded for
 * a second reason — they hold the route gate and move a `restore_run` state machine that has its own
 * failure settlement, so a second automatic attempt would fight the run it was meant to rescue.
 */
const NEVER_AUTOMATIC_KINDS: ReadonlySet<string> = new Set([
  'restore',
  'platform-restore',
  'platform-restore-products',
  'dsar',
]);

type FailedJob = {
  id: string;
  kind: string;
  instance_id: string | null;
  requested_by: string | null;
  error_code: string | null;
  payload: Record<string, unknown>;
  finished_at: Date;
};

type RunningJob = {
  id: string;
  kind: string;
  instance_id: string | null;
  requested_by: string | null;
  payload: Record<string, unknown>;
};

type StepStateRow = { job_id: string; name: string; state: string };

export type RetryPassResult = {
  /** Successor jobs created this pass. */
  readonly scheduled: number;
  /** Failures examined and deliberately left alone. */
  readonly skipped: number;
  /** Jobs whose worker disappeared and which were settled as failed this pass. */
  readonly abandoned: number;
};

@Injectable()
export class JobRetryService {
  private readonly logger = new Logger('job-retry');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JobService) private readonly jobs: JobService,
    // Explicit token: the runtime has no `emitDecoratorMetadata`, so a bare class parameter would
    // resolve to `undefined` (the same reason `SyntheticPipeline` names it).
    @Inject(PipelineRegistry) private readonly pipelines: PipelineRegistry,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  /** One scheduler pass. Each half is independently guarded so neither can stop the other. */
  async tick(now: Date = new Date()): Promise<RetryPassResult> {
    const abandoned = await this.abandonStaleRunning().catch((error: unknown) => {
      this.logger.error(
        { err: errorMessage(error) },
        'abandoned-job pass failed; stale running jobs keep their lanes',
      );
      return 0;
    });
    const { scheduled, skipped } = await this.retryTransient(now).catch((error: unknown) => {
      this.logger.error({ err: errorMessage(error) }, 'retry pass failed; failed jobs stay failed');
      return { scheduled: 0, skipped: 0 };
    });
    return { scheduled, skipped, abandoned };
  }

  /**
   * A worker that dies mid-stage leaves its row `running` for ever: the lane index keeps every later
   * action on that instance at 409, and no retry policy can see the job because it never reached
   * `failed`. Liveness is derived from the last evidence the job wrote — a log line, a step that
   * started, or the transition into `running` — so a stage that is genuinely working (the readiness
   * probe logs at least once a minute) is never touched.
   */
  async abandonStaleRunning(): Promise<number> {
    const staleAfterSeconds = Math.round(this.config.SEAMNEX_JOB_STALE_AFTER_MS / 1_000);
    const result = await this.pool.query<RunningJob>(
      `SELECT j.id, j.kind, j.instance_id, j.requested_by, j.payload
         FROM deployment_job j
        WHERE j.state = 'running'
          AND COALESCE(
                (SELECT max(l.ts) FROM job_log l WHERE l.job_id = j.id),
                (SELECT max(s.started_at) FROM job_step s WHERE s.job_id = j.id AND s.state = 'running'),
                j.started_at,
                j.created_at
              ) < now() - make_interval(secs => $1)
        ORDER BY j.started_at
        LIMIT $2`,
      [staleAfterSeconds, this.config.SEAMNEX_JOB_RETRY_BATCH],
    );

    let abandoned = 0;
    for (const row of result.rows) {
      const detail =
        'No progress was recorded before the stale deadline, so the worker that held this job is gone. ' +
        'The stage it was running may have been interrupted; inspect the log before retrying.';
      try {
        // The owning module settles its resource first (a `restore_run` is failed, an instance is
        // moved out of its transient state), but a handler that throws must not leave the row
        // `running`: that is the stuck lane this pass exists to clear, and the transition below is
        // the part an operator can act on. The worker orders its own failure path the same way.
        try {
          await settlePipelineFailure(
            this.pipelines,
            row.kind,
            jobContext(this.jobs, {
              jobId: row.id,
              kind: row.kind,
              instanceId: row.instance_id,
              requestedBy: row.requested_by,
              payload: row.payload,
            }),
            new Error(detail),
          );
        } catch (error) {
          this.logger.error(
            { jobId: row.id, kind: row.kind, err: errorMessage(error) },
            'abandoned job: the failure handler threw; the job is still marked failed',
          );
        }
        await this.jobs.appendLog(row.id, 'system', detail).catch(() => undefined);
        await this.jobs.transition(row.id, 'failed', {
          errorCode: ABANDONED_FAILURE_CODE,
          errorDetail: detail,
          actorId: 'scheduler',
        });
        abandoned += 1;
        this.metrics.jobRetries.labels('abandoned').inc();
        this.logger.warn(
          { jobId: row.id, kind: row.kind },
          'settled a job abandoned by its worker',
        );
      } catch (error) {
        // A job that moved on between the read and the update is not abandoned; STATE_CONFLICT is
        // the expected answer and must not abort the pass.
        this.logger.debug(
          { jobId: row.id, err: errorMessage(error) },
          'could not settle an apparently abandoned job',
        );
      }
    }
    return abandoned;
  }

  /** Classify, bound, back off, then queue a successor. Idempotent: a chained successor stops it. */
  async retryTransient(now: Date = new Date()): Promise<{ scheduled: number; skipped: number }> {
    const candidates = await this.pool.query<FailedJob>(
      `SELECT j.id, j.kind, j.instance_id, j.requested_by, j.error_code, j.payload, j.finished_at
         FROM deployment_job j
        WHERE j.state = 'failed'
          AND j.finished_at IS NOT NULL
          AND j.error_code = ANY($1::text[])
          AND NOT EXISTS (
                SELECT 1 FROM deployment_job s WHERE s.payload->>'retryOf' = j.id::text
              )
          AND COALESCE(
                CASE WHEN j.payload->>'attempt' ~ '^[0-9]+$' THEN (j.payload->>'attempt')::int END,
                1
              ) < $3
        ORDER BY j.finished_at
        LIMIT $2`,
      [
        [...TRANSIENT_JOB_ERROR_CODES],
        this.config.SEAMNEX_JOB_RETRY_BATCH,
        this.config.SEAMNEX_JOB_RETRY_MAX_ATTEMPTS,
      ],
    );
    if (candidates.rows.length === 0) return { scheduled: 0, skipped: 0 };

    const steps = await this.stepsFor(candidates.rows.map((row) => row.id));
    let scheduled = 0;
    let skipped = 0;

    for (const row of candidates.rows) {
      const reason = this.refusal(row, steps, now);
      if (reason !== null) {
        skipped += 1;
        // `not_due` is a wait, not a decision: counting it would add one increment per tick for a job
        // that is simply inside its backoff window. The other reasons are decisions and are worth a
        // counter — they are the failures that still cost a person.
        if (reason !== 'not_due') this.metrics.jobRetries.labels(`skipped_${reason}`).inc();
        continue;
      }

      const attempt = attemptOf(row.payload);
      const stepsForKind = this.pipelines.stepsFor(row.kind);
      try {
        const created = await this.jobs.create({
          kind: row.kind,
          instanceId: row.instance_id,
          requestedBy: 'system',
          payload: {
            ...row.payload,
            retryOf: row.id,
            attempt: attempt + 1,
          },
          steps: stepsForKind,
        });
        scheduled += 1;
        this.metrics.jobRetries.labels('scheduled').inc();
        await this.announce(row, created.job.id, attempt + 1);
        await this.audit
          .append({
            action: 'job.retry.scheduled',
            actorType: 'system',
            actorId: 'scheduler',
            targetType: 'job',
            targetId: created.job.id,
            outcome: 'success',
            detail: {
              previousJobId: row.id,
              kind: row.kind,
              attempt: attempt + 1,
              errorCode: row.error_code,
              delayMs: backoffMs(this.config, attempt),
            },
          })
          .catch((error: unknown) => {
            this.logger.error(
              { jobId: created.job.id, err: errorMessage(error) },
              'retry scheduled but the audit row could not be appended',
            );
          });
        this.logger.log(
          { jobId: created.job.id, previousJobId: row.id, attempt: attempt + 1, kind: row.kind },
          'transient failure retried',
        );
      } catch (error) {
        // A lane that is busy is expected: `deployment_job_one_active_per_instance` is the real
        // serialisation guard, and the next pass re-examines this candidate.
        if (error instanceof AppError && error.code === 'INSTANCE_BUSY') {
          skipped += 1;
          this.metrics.jobRetries.labels('skipped_busy').inc();
          continue;
        }
        skipped += 1;
        this.metrics.jobRetries.labels('skipped_error').inc();
        this.logger.error(
          { jobId: row.id, err: errorMessage(error) },
          'a transient failure could not be retried',
        );
      }
    }

    return { scheduled, skipped };
  }

  /**
   * The retry policy's one visible trace, written where an operator already looks: both job logs.
   *
   * Without it the console shows two unrelated rows — one failed, one queued — and nothing says they
   * are the same work, so "it retried itself" is indistinguishable from "somebody started it again".
   * The log is the surface that needs no contract change and is already streamed to the screen.
   *
   * A log write that fails must not undo a queued retry, hence the swallow: `job.retry.scheduled`
   * and the successor row are the durable record.
   */
  private async announce(row: FailedJob, successorId: string, attempt: number): Promise<void> {
    const budget = this.config.SEAMNEX_JOB_RETRY_MAX_ATTEMPTS;
    const delay = Math.round(backoffMs(this.config, attempt - 1) / 1_000);
    await Promise.all([
      this.jobs
        .appendLog(
          successorId,
          'system',
          `Retried automatically after job ${row.id} failed with ${row.error_code} ` +
            `(attempt ${attempt} of ${budget}).`,
        )
        .catch(() => undefined),
      this.jobs
        .appendLog(
          row.id,
          'system',
          `Retry queued automatically: job ${successorId} ` +
            `(attempt ${attempt} of ${budget}, after ${delay} s).`,
        )
        .catch(() => undefined),
    ]);
  }

  /** Why this failure is left alone, or null when it should be retried. */
  private refusal(
    row: FailedJob,
    steps: ReadonlyMap<string, readonly StepStateRow[]>,
    now: Date,
  ): string | null {
    if (!isTransientJobError(row.error_code)) return 'not_transient';
    if (row.payload.manual === true) return 'manual';
    if (NEVER_AUTOMATIC_KINDS.has(row.kind)) return 'needs_human';
    if (this.pipelines.stepsFor(row.kind).length === 0) return 'unregistered_kind';

    const attempt = attemptOf(row.payload);
    if (attempt >= this.config.SEAMNEX_JOB_RETRY_MAX_ATTEMPTS) return 'attempts_spent';

    const dueAt = new Date(row.finished_at).getTime() + backoffMs(this.config, attempt);
    if (dueAt > now.getTime()) return 'not_due';

    if (!APPLY_GATED_KINDS.has(row.kind)) return null;

    const applyLabel = this.pipelines
      .stages(row.kind)
      ?.find((stage) => stage.name === 'apply')?.step;
    // Without a resolvable boundary the platform cannot prove the change was not applied, and an
    // unprovable retry is exactly what this rule exists to prevent.
    if (applyLabel === undefined) return 'unproven_boundary';
    const started = (steps.get(row.id) ?? []).some(
      (step) =>
        step.name === applyLabel && (step.state === 'running' || step.state === 'succeeded'),
    );
    return started ? 'apply_started' : null;
  }

  /** One query for every candidate's steps: a per-job read would be N round trips per pass. */
  private async stepsFor(
    jobIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly StepStateRow[]>> {
    const result = await this.pool.query<StepStateRow>(
      `SELECT job_id, name, state FROM job_step WHERE job_id = ANY($1::uuid[])`,
      [jobIds],
    );
    const grouped = new Map<string, StepStateRow[]>();
    for (const row of result.rows) {
      const list = grouped.get(row.job_id) ?? [];
      list.push(row);
      grouped.set(row.job_id, list);
    }
    return grouped;
  }
}

/** Attempt 1 is the first run; a retried job carries the attempt it is about to become. */
function attemptOf(payload: Record<string, unknown>): number {
  const value = payload.attempt;
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/** Exponential, capped: an outage that lasts an hour must not become sixty retries. */
function backoffMs(config: AppConfig, attempt: number): number {
  return Math.min(
    config.SEAMNEX_JOB_RETRY_MAX_DELAY_MS,
    config.SEAMNEX_JOB_RETRY_BACKOFF_MS * 2 ** (attempt - 1),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
