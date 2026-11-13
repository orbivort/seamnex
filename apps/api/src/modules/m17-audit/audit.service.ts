import { Inject, Injectable, Logger } from '@nestjs/common';
import { withTransaction, type Queryable } from '@seamnex/db';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { METRICS } from '../../common/metrics/metrics';
import type { Metrics } from '../../common/metrics/metrics';
import { AppError } from '../../common/problem/app-error';
import { maskDeep } from '../../common/logging/masking';
import { currentRequestId } from '../../common/logging/logger';
import type {
  AuditAppendInput,
  AuditAppendResult,
  AuditService,
  AuditVerification,
} from './audit.contract';

/**
 * The append point (deliverable 1.5, AD-20).
 *
 * Design choices worth stating:
 *   - the hash chain is computed by a database trigger, not here, so any writer produces a valid
 *     chain (see `0009_invariants_triggers.up.sql`);
 *   - a failed append throws `AUDIT_UNAVAILABLE`, and callers that pass their transaction have the
 *     mutation rolled back — "fail closed" is a commit property, not a convention;
 *   - `detail` is masked before it is stored, so a secret cannot enter the immutable chain.
 */
@Injectable()
export class PostgresAuditService implements AuditService {
  private readonly logger = new Logger('audit');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  /**
   * Takes the chain-tip lock. `FOR UPDATE` on the single tip row is what makes the chain correct
   * under concurrency: an advisory lock serialises writers but not their snapshots, so under
   * REPEATABLE READ a waiting writer forked the chain. Here the dependency is a row, so MVCC either
   * shows the committed predecessor or raises 40001 — and a failed append refuses the mutation.
   */
  async lockChain(tx: Queryable): Promise<void> {
    await tx.query('SELECT last_seq FROM audit_chain WHERE id = 1 FOR UPDATE');
  }

  async append(input: AuditAppendInput, tx?: Queryable): Promise<AuditAppendResult> {
    // Without a caller transaction the append still gets one: an autocommitted row would not hold
    // the chain lock across the insert, which is the whole point.
    if (tx !== undefined) return this.appendIn(tx, input);
    return withTransaction(this.pool, (client) => this.appendIn(client, input));
  }

  private async appendIn(runner: Queryable, input: AuditAppendInput): Promise<AuditAppendResult> {
    const startedAt = process.hrtime.bigint();
    const detail = maskDeep(input.detail ?? {});
    const requestId = input.requestId ?? currentRequestId() ?? null;

    try {
      await this.lockChain(runner);

      const result = await runner.query<{ seq: string; hash: string }>(
        `INSERT INTO audit_event (actor_type, actor_id, action, target_type, target_id, outcome, detail, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING seq, hash`,
        [
          input.actorType,
          input.actorId,
          input.action,
          input.targetType,
          input.targetId,
          input.outcome,
          JSON.stringify(detail),
          requestId,
        ],
      );

      const row = result.rows[0];
      if (row === undefined) throw new Error('audit append returned no row');
      this.metrics.auditAppendSeconds.labels('success').observe(elapsedSeconds(startedAt));
      return { seq: row.seq, hash: row.hash };
    } catch (error) {
      this.metrics.auditAppendSeconds.labels('failure').observe(elapsedSeconds(startedAt));
      this.logger.error(
        {
          code: 'AUDIT_UNAVAILABLE',
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          requestId,
          err: error instanceof Error ? error.message : String(error),
        },
        'audit append failed; the caller must not commit',
      );
      throw new AppError({
        code: 'AUDIT_UNAVAILABLE',
        detail: 'The change was refused because its audit row could not be written.',
        cause: error,
      });
    }
  }

  async denied(input: Omit<AuditAppendInput, 'action' | 'outcome'>): Promise<void> {
    await this.append({ ...input, action: 'access.denied', outcome: 'denied' });
  }

  /**
   * Recomputes every hash in SQL through `seamnex_audit_hash`, the same function the append trigger
   * calls. The canonical serialisation therefore lives in exactly one place: a verifier written in
   * JavaScript would eventually disagree on timestamp formatting and report a false tamper, and a
   * verifier that copy-pasted the SQL had already drifted once.
   *
   * The row immediately before the range is fetched as well, so the link *into* the range is
   * checked instead of skipped.
   */
  async verify(fromSeq: string, toSeq: string): Promise<AuditVerification> {
    const result = await this.pool.query<{
      seq: string;
      prev_hash: string;
      hash: string;
      expected: string;
      previous: string | null;
    }>(
      `WITH boundary AS (
         SELECT hash FROM audit_event WHERE seq < $1::bigint ORDER BY seq DESC LIMIT 1
       ),
       range AS (
         SELECT seq, prev_hash, hash,
                lag(hash) OVER (ORDER BY seq) AS previous,
                seamnex_audit_hash(
                  prev_hash, seq, ts, id, actor_type, actor_id, action, target_type, target_id,
                  outcome, detail, request_id
                ) AS expected
         FROM audit_event
         WHERE seq BETWEEN $1::bigint AND $2::bigint
       )
       SELECT r.seq, r.prev_hash, r.hash, r.expected,
              COALESCE(r.previous, (SELECT hash FROM boundary)) AS previous
         FROM range r
        ORDER BY r.seq`,
      [fromSeq, toSeq],
    );

    let firstBrokenSeq: string | null = null;
    for (const row of result.rows) {
      const linkBroken = row.previous !== null && row.prev_hash !== row.previous;
      const hashBroken = row.hash !== row.expected;
      if ((linkBroken || hashBroken) && firstBrokenSeq === null) firstBrokenSeq = row.seq;
    }

    return { valid: firstBrokenSeq === null, checked: result.rowCount ?? 0, firstBrokenSeq };
  }

  async anchor(day: Date = new Date()): Promise<void> {
    const result = await this.pool.query<{ seq: string; hash: string }>(
      `SELECT seq, hash FROM audit_event WHERE ts < $1 ORDER BY seq DESC LIMIT 1`,
      [day.toISOString()],
    );
    const last = result.rows[0];
    if (last === undefined) return;

    await this.pool.query(
      `INSERT INTO audit_anchor (day, last_seq, last_hash)
       VALUES ($1::date, $2::bigint, $3)
       ON CONFLICT (day) DO UPDATE SET last_seq = EXCLUDED.last_seq, last_hash = EXCLUDED.last_hash
       WHERE audit_anchor.last_seq < EXCLUDED.last_seq`,
      [day.toISOString().slice(0, 10), last.seq, last.hash],
    );
  }
}

function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}
