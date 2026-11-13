import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { redactSample } from '../../common/privacy/sample-redaction';
import { N8nClient } from './n8n.client';

/** A run that claims to be in flight, with the n8n id and the IR its nodes were copied from. */
type RunningRun = {
  id: string;
  workflow_id: string;
  started_at: Date;
  compiled_n8n_id: string;
  ir: { nodes: { id: string; label: string }[] };
};

/** n8n answers `error`/`crashed` with `finished: false`, so its `status` is the only terminal signal. */
const TERMINAL = new Set(['success', 'error', 'crashed']);

/**
 * How often the sample sweep may run.
 *
 * It is a whole-table `UPDATE`, and the poller ticks every 10 s by default: running it per tick would
 * be ~8 600 no-op writes a day against a table that only grows. An hour is far below the 30-day
 * retention window, so an expired sample is never shown for longer than a pass.
 */
const SAMPLE_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * ADR-BE-12 D9 — the n8n execution mirror.
 *
 * `POST /workflows/:id/run` can start an execution and nothing else: the webhook acknowledges the
 * delivery, and the outcome lives in n8n. Without this poller every run stayed `running` for ever
 * (the driver row was created, n8n finished in milliseconds, and the platform never noticed), so
 * the failed-run queue, the replay flow and the run history all reported a state that no execution
 * was in.
 *
 * Matching a run to its execution is by time, because n8n's public API returns no correlation id
 * for a webhook delivery and `workflow_run` has no column for one. Each execution is claimed by at
 * most one run: runs are visited oldest first and an execution is matched to the earliest
 * *unclaimed* one that started at or after it (5 s of clock slack), which is what a sequential
 * operator sees. Concurrent runs of one workflow could in principle be matched out of order — the
 * honest fix is an execution-id column, which is a migration.
 */
@Injectable()
export class RunMirrorService implements OnApplicationShutdown {
  private readonly logger = new Logger('workflow-run-mirror');
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private lastSweepAt = 0;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(N8nClient) private readonly n8n: N8nClient,
  ) {}

  /**
   * The poller used to be called from the scheduler's one-minute pass, which made it a one-minute
   * poller whatever `SEAMNEX_N8N_EXECUTION_POLL_MS` said. It owns its interval now.
   */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        // A failed pass used to be swallowed here; a poller that has stopped settling runs must say so.
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'workflow run mirror pass failed',
        );
      });
    }, this.config.SEAMNEX_N8N_EXECUTION_POLL_MS);
    // A poller must not hold the process open during shutdown.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  /** One pass. Returns how many runs it settled, so a test can assert on it rather than on a timer. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    /*
     * Retention rides the pass that already writes these rows: a separate scheduler job would be one
     * more thing that can be forgotten in a role that does not run it. It sits *before* the
     * readiness gate because it does not depend on n8n — samples captured while the adapter was
     * configured must still expire after an operator disables it.
     */
    if (this.sweepDue()) {
      await this.sweepSamples().catch((error: unknown) => {
        this.logger.warn(
          `workflow sample retention sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    if (!this.n8n.ready()) return 0;
    this.busy = true;
    try {
      const runs = await this.pool.query<RunningRun>(
        `SELECT r.id, r.workflow_id, r.started_at, v.compiled_n8n_id, v.ir
           FROM workflow_run r
           JOIN workflow_version v ON v.id = r.version_id
          WHERE r.state = 'running' AND r.finished_at IS NULL AND v.compiled_n8n_id IS NOT NULL
          ORDER BY r.started_at ASC
          LIMIT 50`,
      );
      const claimed = new Set<string>();
      let settled = 0;
      for (const group of groupByCompiledId(runs.rows)) {
        const executions = (await this.n8n.executions(group.key, 20))
          .filter((entry) => entry.startedAt.length > 0)
          .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
        for (const run of group.runs) {
          const notBefore = run.started_at.getTime() - 5_000;
          const match = executions.find(
            (entry) => !claimed.has(entry.id) && Date.parse(entry.startedAt) >= notBefore,
          );
          if (match === undefined) continue;
          claimed.add(match.id);
          if (await this.settle(run, match.id)) settled += 1;
        }
      }
      return settled;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Whether this pass should sweep. The timestamp is claimed before the statement runs, so a failing
   * sweep is retried on the next window rather than on every tick — a product outage is not a reason
   * to hammer the table.
   */
  private sweepDue(): boolean {
    const now = Date.now();
    if (now - this.lastSweepAt < SAMPLE_SWEEP_INTERVAL_MS) return false;
    this.lastSweepAt = now;
    return true;
  }

  /**
   * FR-5.5/GDPR: a captured item is authoring data with a short life. Once it is older than the
   * retention window it is nulled in place — the run row and its outcome stay, the payload does not.
   */
  async sweepSamples(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE workflow_run_node
          SET sample_item = NULL, sample_truncated = false
        WHERE sample_item IS NOT NULL
          AND sample_captured_at < now() - make_interval(days => $1)`,
      [this.config.SEAMNEX_WORKFLOW_SAMPLE_RETENTION_DAYS],
    );
    return result.rowCount ?? 0;
  }

  private async settle(run: RunningRun, executionId: string): Promise<boolean> {
    const detail = await this.n8n.execution(executionId).catch(() => null);
    if (detail === null || !TERMINAL.has(detail.status)) return false;

    const succeeded = detail.status === 'success';
    const state = succeeded ? 'succeeded' : 'failed';
    const message = succeeded
      ? null
      : (detail.error ??
        detail.nodes.find((node) => node.error !== null)?.error ??
        'n8n reported a failure.');

    /*
     * The run ended when n8n says it ended, not when this pass noticed. `now()` here made the run
     * table's Duration the settle latency: the same 265 ms execution reported 38.1 s, 60.0 s and
     * 135.8 s on three consecutive runs, because the poller is a minute-grained background pass.
     */
    await this.pool.query(
      `UPDATE workflow_run
          SET state = $2, finished_at = $3, error = $4::jsonb
        WHERE id = $1 AND state = 'running'`,
      [
        run.id,
        state,
        stoppedAt(detail.stoppedAt),
        message === null ? null : JSON.stringify({ message }),
      ],
    );

    for (const node of run.ir.nodes) {
      const observed = detail.nodes.find((entry) => entry.name === node.label);
      /*
       * FR-5.5: the item the node produced is what its downstream node receives, so it is the sample
       * a mapping's `from` path is checked against. Redacted and capped here, at the only point the
       * payload exists in this process — the column never holds an unredacted item.
       */
      const redacted =
        observed?.sample === null || observed?.sample === undefined
          ? null
          : redactSample(observed.sample);
      await this.pool.query(
        // No `records` column: the row set has none, and the read model reports 0 for it rather
        // than inventing a count the platform never measured. `error` is jsonb — a bare string is
        // not valid json and aborted the pass after the run row had already moved.
        `UPDATE workflow_run_node
            SET state = $3, duration_ms = $4, error = $5::jsonb,
                sample_item = $6::jsonb, sample_captured_at = $7, sample_truncated = $8
          WHERE run_id = $1 AND node_id = $2`,
        [
          run.id,
          node.id,
          // A node with no result never started: an earlier node failed and n8n stopped there.
          observed?.state ?? 'queued',
          observed?.durationMs ?? 0,
          observed?.error == null ? null : JSON.stringify({ message: observed.error }),
          redacted === null || redacted.item === null ? null : JSON.stringify(redacted.item),
          redacted === null ? null : new Date(),
          redacted?.truncated === true,
        ],
      );
    }

    await this.audit
      .append({
        action: succeeded ? 'workflow.run.succeeded' : 'workflow.run.failed',
        actorType: 'system',
        actorId: 'broker-proxy',
        targetType: 'workflow_run',
        targetId: run.id,
        outcome: succeeded ? 'success' : 'failure',
        detail: { workflowId: run.workflow_id, executionId, status: detail.status },
      })
      .catch(() => undefined);
    return true;
  }
}

/**
 * n8n's end of an execution, as a `Date` the driver accepts.
 *
 * A missing or unparseable stamp falls back to the wall clock: a run recorded as ended a moment late
 * is a rounding error, a run recorded as ended in 1970 is a data defect.
 */
function stoppedAt(value: string | null): Date {
  if (value === null) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function groupByCompiledId(runs: RunningRun[]): { key: string; runs: RunningRun[] }[] {
  const groups = new Map<string, RunningRun[]>();
  for (const run of runs) {
    const list = groups.get(run.compiled_n8n_id) ?? [];
    list.push(run);
    groups.set(run.compiled_n8n_id, list);
  }
  return [...groups].map(([key, list]) => ({ key, runs: list }));
}
