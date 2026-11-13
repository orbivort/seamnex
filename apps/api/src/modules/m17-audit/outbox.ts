import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OutboxRow, Queryable } from '@seamnex/db';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { METRICS } from '../../common/metrics/metrics';
import type { Metrics } from '../../common/metrics/metrics';
import type { Outbox } from './audit.contract';

export type OutboxEvent = {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload?: Record<string, unknown>;
};

export type OutboxHandler = (row: OutboxRow) => Promise<void>;

const RECLAIM_AFTER_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * Transactional outbox (AD-18). Producers write the event in the same transaction as the state
 * change, so "the audit row exists but the event does not" cannot happen.
 *
 * One claimer only: the scheduler role calls `dispatchBatch`. `FOR UPDATE SKIP LOCKED` makes that
 * safe even if a second scheduler starts by mistake.
 */
@Injectable()
export class OutboxService implements Outbox {
  private readonly logger = new Logger('outbox');
  private readonly handlers = new Map<string, OutboxHandler[]>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  /** Emit inside the caller's transaction, never on its own connection. */
  async emit(tx: Queryable, event: OutboxEvent): Promise<void> {
    await tx.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload ?? {}),
      ],
    );
  }

  on(eventType: string, handler: OutboxHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    this.handlers.set(eventType, [...existing, handler]);
  }

  async claim(limit = 50): Promise<OutboxRow[]> {
    const result = await this.pool.query<OutboxRow>(
      `UPDATE outbox
          SET claimed_at = now(), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox
           WHERE dispatched_at IS NULL
             AND attempts < $2
             AND (claimed_at IS NULL OR claimed_at < now() - ($3::text || ' milliseconds')::interval)
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING id, aggregate_type, aggregate_id, event_type, payload, created_at, claimed_at, dispatched_at, attempts, last_error`,
      [limit, MAX_ATTEMPTS, String(RECLAIM_AFTER_MS)],
    );
    return result.rows;
  }

  async dispatchBatch(limit = 50): Promise<number> {
    const rows = await this.claim(limit);
    let dispatched = 0;

    for (const row of rows) {
      try {
        for (const handler of this.handlers.get(row.event_type) ?? []) await handler(row);
        await this.pool.query(
          'UPDATE outbox SET dispatched_at = now(), last_error = NULL WHERE id = $1',
          [row.id],
        );
        this.metrics.outboxDispatched.labels(row.event_type).inc();
        dispatched += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.pool.query('UPDATE outbox SET last_error = $2 WHERE id = $1', [
          row.id,
          message.slice(0, 500),
        ]);
        this.logger.warn(
          { eventType: row.event_type, attempts: row.attempts, err: message },
          'outbox handler failed',
        );
      }
    }

    return dispatched;
  }
}
