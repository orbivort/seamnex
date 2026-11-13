import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AuditEvent, AuditExportSchema, AuditProof } from '@seamnex/domain';
import type { z } from 'zod';

type AuditExport = z.infer<typeof AuditExportSchema>;
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from './audit.contract';

type AuditRow = {
  seq: string;
  id: string;
  ts: Date;
  actor_type: 'user' | 'service' | 'system';
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  outcome: 'success' | 'failure' | 'denied';
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

export type AuditFilter = {
  readonly action?: string;
  readonly actor?: string;
  readonly outcome?: string;
  readonly target?: string;
  readonly cursor?: string;
  readonly limit?: string;
};

/**
 * The audit read surface (FR-4.3, AC-15).
 *
 * Kept apart from `AuditService` because that one is the *writer*: it holds the chain lock and
 * appends. A reader must never share a provider with the append path — one day someone would add a
 * query inside a locked transaction and lengthen the critical section for every audited mutation.
 */
@Injectable()
export class AuditQueryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  /** Keyset pagination on `seq` descending: stable while rows are appended underneath the reader. */
  async page(
    filter: AuditFilter,
  ): Promise<{ items: AuditEvent[]; nextCursor: string | null; total: number }> {
    const limit = clamp(Number(filter.limit ?? 100));
    const params: unknown[] = [];
    const where: string[] = [];

    if (filter.action !== undefined && filter.action.length > 0) {
      /*
       * Actions are dotted (`auth.session.created`), and the console filters by namespace
       * (`auth`). Equality alone made every category in the filter return nothing, so the match
       * accepts a full action name or a whole dotted prefix. `starts_with` rather than `LIKE`:
       * the caller's text is never treated as a pattern, so `%` cannot widen the selection.
       */
      params.push(filter.action);
      where.push(`(action = $${params.length} OR starts_with(action, $${params.length} || '.'))`);
    }
    if (filter.outcome !== undefined && filter.outcome.length > 0) {
      params.push(filter.outcome);
      where.push(`outcome = $${params.length}`);
    }
    if (filter.actor !== undefined && filter.actor.length > 0) {
      params.push(`%${filter.actor}%`);
      where.push(`actor_id ILIKE $${params.length}`);
    }
    if (filter.target !== undefined && filter.target.length > 0) {
      params.push(`%${filter.target}%`);
      where.push(`(target_id ILIKE $${params.length} OR target_type ILIKE $${params.length})`);
    }
    if (filter.cursor !== undefined && filter.cursor.length > 0 && /^\d+$/.test(filter.cursor)) {
      params.push(filter.cursor);
      where.push(`seq < $${params.length}::bigint`);
    }

    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    params.push(limit + 1);
    /*
     * `ORDER BY audit_event.seq`, never the bare `seq`: a bare name in ORDER BY is resolved
     * against the *output* columns first, and `seq::text` above makes that output column text.
     * The list then came back 999, 998, … 990, 99, 989 — newest first only within a digit
     * length — and the keyset cursor below skipped and repeated rows on every next page.
     */
    const rows = await this.pool.query<AuditRow>(
      `SELECT seq::text, id, ts, actor_type, actor_id, action, target_type, target_id, outcome, detail, prev_hash, hash
         FROM audit_event ${clause}
        ORDER BY audit_event.seq DESC
        LIMIT $${params.length}`,
      params,
    );

    const page = rows.rows.slice(0, limit);
    const total = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_event ${clause}`,
      params.slice(0, params.length - 1),
    );

    return {
      items: page.map(toEvent),
      nextCursor: rows.rows.length > limit ? (page[page.length - 1]?.seq ?? null) : null,
      total: Number(total.rows[0]?.count ?? '0'),
    };
  }

  /**
   * The proof for one row: its own links plus the short walk that precedes it, and the anchor that
   * covers its day. `chainValid` is the verifier's answer, not a recomputation here.
   */
  async proof(seq: string): Promise<AuditProof> {
    const target = await this.pool.query<AuditRow>(
      `SELECT seq::text, id, ts, actor_type, actor_id, action, target_type, target_id, outcome, detail, prev_hash, hash
         FROM audit_event WHERE seq = $1::bigint`,
      [seq],
    );
    const row = target.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        status: 404,
        detail: `No audit event has sequence ${seq}.`,
        remediation: 'Search the audit trail again; the sequence may have been mistyped.',
      });
    }

    const walk = await this.pool.query<{ seq: string; hash: string }>(
      `SELECT seq::text, hash FROM audit_event WHERE seq <= $1::bigint ORDER BY audit_event.seq DESC LIMIT 6`,
      [seq],
    );
    const verification = await this.audit.verify(seq, seq);

    const day = new Date(row.ts).toISOString().slice(0, 10);
    // `audit_anchor` is keyed on `day`. This read used `anchor_day`, a column that has never
    // existed, and a `.catch()` turned the resulting error into "not anchored yet" — so the drawer
    // reported an unanchored chain even on a day that was anchored.
    const anchor = await this.pool.query<{ signature: string | null }>(
      `SELECT signature FROM audit_anchor WHERE day = $1::date LIMIT 1`,
      [day],
    );

    return {
      seq: Number(row.seq),
      hash: row.hash,
      prevHash: row.prev_hash,
      algorithm: 'sha256(prev_hash || canonical(row))',
      chainValid: verification.valid,
      verifiedAt: new Date().toISOString(),
      anchoredDay: day,
      anchorSignature: anchor.rows[0]?.signature ?? 'not anchored yet',
      path: walk.rows.map((entry) => ({ seq: Number(entry.seq), hash: entry.hash })),
    };
  }

  /**
   * CL-11 / FR-4.3: a signed range export, with the range made explicit rather than page-derived.
   *
   * The range is returned with its events, not only with a count: a file whose `count` and
   * `sha256` describe rows it does not contain cannot be checked by whoever receives it.
   *
   * The upper bound covers its whole millisecond. A contract timestamp carries milliseconds while
   * `ts` is stored with microseconds, so the client's `to` is the *truncated* spelling of the
   * newest row: `ts <= to` silently dropped that row from every export, including the event that
   * proved the chain.
   */
  async exportRange(from: string, to: string): Promise<AuditExport> {
    const rows = await this.pool.query<AuditRow>(
      `SELECT seq::text, id, ts, actor_type, actor_id, action, target_type, target_id, outcome, detail, prev_hash, hash
         FROM audit_event
        WHERE ts >= $1::timestamptz AND ts < $2::timestamptz + interval '1 millisecond'
        ORDER BY audit_event.seq`,
      [from, to],
    );
    const events = rows.rows.map(toEvent);
    const verification = await this.audit.verify(
      rows.rows[0]?.seq ?? '0',
      rows.rows[rows.rows.length - 1]?.seq ?? '0',
    );
    const sha256 = createHash('sha256')
      .update(rows.rows.map((row) => row.hash).join(''))
      .digest('hex');

    return {
      exportedAt: new Date().toISOString(),
      count: events.length,
      events,
      from,
      to,
      sha256,
      chainValid: verification.valid,
      downloadName: `audit-${from.slice(0, 10)}-${to.slice(0, 10)}.json`,
    };
  }
}

function toEvent(row: AuditRow): AuditEvent {
  return {
    seq: Number(row.seq),
    id: row.id,
    ts: row.ts.toISOString(),
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: row.target_id,
    outcome: row.outcome,
    detail:
      typeof row.detail === 'string'
        ? row.detail
        : Object.keys(row.detail).length === 0
          ? 'no detail'
          : JSON.stringify(row.detail),
    subjectRef: String((row.detail as { subjectRef?: string }).subjectRef ?? row.target_id),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

function clamp(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.min(Math.floor(limit), 100);
}
