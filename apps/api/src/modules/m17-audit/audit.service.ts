import { Inject, Injectable, Logger } from '@nestjs/common';
import { withTransaction, type Queryable } from '@seamnex/db';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { METRICS } from '../../common/metrics/metrics';
import type { Metrics } from '../../common/metrics/metrics';
import { AppError } from '../../common/problem/app-error';
import { maskDeep } from '../../common/logging/masking';
import { currentRequestId } from '../../common/logging/logger';
import { AnchorSigner } from './anchor-signer';
import type {
  AuditAnchorExport,
  AuditAnchorRecord,
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
    /*
     * The signer is a constructor dependency, not a parameter of `anchor()`: an anchor without a
     * signature is the defect this closes, so there is no path that can write one unsigned.
     */
    @Inject(AnchorSigner) private readonly signer: AnchorSigner,
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

  /**
   * NFR-4.10 / AC-15 — one signed, immutable anchor per closed day.
   *
   * Three properties, and each replaced a defect:
   *
   *   - **Signed.** The row carries an Ed25519 signature over its own `{day,lastSeq,lastHash}`,
   *     made before the insert, so an anchor cannot be recomputed by someone who can write to this
   *     database. The public key travels with the export, which is what lets an auditor verify.
   *   - **Immutable.** `ON CONFLICT (day) DO NOTHING` rather than `DO UPDATE`. `0010_grants` revokes
   *     UPDATE on this table, so the old upsert was only ever legal for the owner role; more to the
   *     point, an anchor that can be advanced is not an anchor. Re-anchoring a closed day is a
   *     no-op by design, and the first row is returned instead.
   *   - **Closed day.** `day` is the day being closed, and the anchored sequence is the last event
   *     *inside* it. Anchoring "today" at midnight recorded a boundary rather than a day.
   *
   * Must not be called inside a transaction that holds the chain lock: signing reads the key from
   * the secret store, and that read appends its own audit row on another connection.
   */
  async anchor(day: Date = new Date()): Promise<AuditAnchorRecord | null> {
    const dayKey = day.toISOString().slice(0, 10);
    const start = new Date(`${dayKey}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86_400_000);

    const result = await this.pool.query<{ seq: string; hash: string }>(
      `SELECT seq, hash FROM audit_event
        WHERE ts >= $1 AND ts < $2
        ORDER BY seq DESC LIMIT 1`,
      [start.toISOString(), end.toISOString()],
    );
    const last = result.rows[0];
    if (last === undefined) return null;

    const signature = await this.signer.sign({
      day: dayKey,
      lastSeq: last.seq,
      lastHash: last.hash,
    });

    await this.pool.query(
      `INSERT INTO audit_anchor (day, last_seq, last_hash, signature)
       VALUES ($1::date, $2::bigint, $3, $4)
       ON CONFLICT (day) DO NOTHING`,
      [dayKey, last.seq, last.hash, signature],
    );

    /*
     * Read back rather than echo: a concurrent writer may have anchored this day first, and the
     * row that exists is the evidence — returning what we tried to write would report a signature
     * the table does not hold.
     */
    const stored = await this.pool.query<{
      day: string;
      last_seq: string;
      last_hash: string;
      signature: string | null;
      stored_at: Date;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, last_seq, last_hash, signature, stored_at
         FROM audit_anchor WHERE day = $1::date`,
      [dayKey],
    );
    const row = stored.rows[0];
    if (row === undefined) return null;
    return {
      day: row.day,
      lastSeq: row.last_seq,
      lastHash: row.last_hash,
      signature: row.signature,
      storedAt: row.stored_at.toISOString(),
    };
  }

  /**
   * The hash at one sequence, for the restore that has to prove it restored the set it downloaded.
   *
   * Read-only and narrow on purpose: a caller that wanted the row's other columns is asking for a
   * different question, and `audit_event` stays owned by this module either way.
   */
  async headHash(seq: string): Promise<string | null> {
    const result = await this.pool.query<{ hash: string }>(
      `SELECT hash FROM audit_event WHERE seq = $1::bigint`,
      [seq],
    );
    return result.rows[0]?.hash ?? null;
  }

  async exportAnchors(): Promise<AuditAnchorExport> {
    const anchors = await this.pool.query<{
      day: string;
      last_seq: string;
      last_hash: string;
      signature: string | null;
      stored_at: Date;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, last_seq, last_hash, signature, stored_at
         FROM audit_anchor ORDER BY day`,
    );
    const head = await this.pool.query<{ seq: string; hash: string; ts: Date }>(
      `SELECT seq, hash, ts FROM audit_event ORDER BY seq DESC LIMIT 1`,
    );
    const headRow = head.rows[0];

    return {
      anchors: anchors.rows.map((row) => ({
        day: row.day,
        lastSeq: row.last_seq,
        lastHash: row.last_hash,
        signature: row.signature,
        storedAt: row.stored_at.toISOString(),
      })),
      /*
       * NFR-4.10: the public key travels with the anchors, because a signature nobody can check is
       * a string. It is not a secret, and it is null on a deployment that has never anchored.
       */
      signing: await this.signer.describe(),
      chainHead:
        headRow === undefined
          ? null
          : { seq: headRow.seq, hash: headRow.hash, ts: headRow.ts.toISOString() },
    };
  }
}

function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}
