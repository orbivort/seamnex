import { Inject, Injectable } from '@nestjs/common';
import type { FieldDescriptor } from '@seamnex/domain';
import type { FieldSnapshotRow } from '@seamnex/db';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';

const COLUMNS = `id, instance_id, entry_key, operation, status, fields, detail, fetched_at, retry_after`;

/** Cache key for one product schema. The operation is part of the identity: `contacts.read` and
 * `contacts.write` accept different fields on the same instance. */
export function snapshotKey(instanceId: string, operation: string): string {
  return `${instanceId}|${operation}`;
}

@Injectable()
export class FieldSnapshotRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async get(instanceId: string, operation: string): Promise<FieldSnapshotRow | null> {
    const result = await this.pool.query<FieldSnapshotRow>(
      `SELECT ${COLUMNS} FROM field_snapshot WHERE instance_id = $1 AND operation = $2`,
      [instanceId, operation],
    );
    return result.rows[0] ?? null;
  }

  /**
   * One round trip for a whole definition. The validation pass calls this with every node's key, so
   * a workflow with twelve nodes costs one indexed lookup instead of twelve.
   */
  async forKeys(
    keys: readonly { instanceId: string; operation: string }[],
  ): Promise<Map<string, FieldSnapshotRow>> {
    const found = new Map<string, FieldSnapshotRow>();
    if (keys.length === 0) return found;
    const result = await this.pool.query<FieldSnapshotRow>(
      `SELECT ${COLUMNS} FROM field_snapshot
        WHERE (instance_id, operation) IN (SELECT * FROM unnest($1::uuid[], $2::text[]))`,
      [keys.map((key) => key.instanceId), keys.map((key) => key.operation)],
    );
    for (const row of result.rows) found.set(snapshotKey(row.instance_id, row.operation), row);
    return found;
  }

  async upsert(input: {
    instanceId: string;
    entryKey: string;
    operation: string;
    status: FieldSnapshotRow['status'];
    fields: readonly FieldDescriptor[];
    detail: string | null;
    retryAfter: Date | null;
  }): Promise<FieldSnapshotRow> {
    const result = await this.pool.query<FieldSnapshotRow>(
      `INSERT INTO field_snapshot
         (instance_id, entry_key, operation, status, fields, detail, retry_after)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (instance_id, operation) DO UPDATE
         SET entry_key = EXCLUDED.entry_key,
             status = EXCLUDED.status,
             fields = EXCLUDED.fields,
             detail = EXCLUDED.detail,
             retry_after = EXCLUDED.retry_after,
             fetched_at = now()
       RETURNING ${COLUMNS}`,
      [
        input.instanceId,
        input.entryKey,
        input.operation,
        input.status,
        JSON.stringify(input.fields),
        input.detail,
        input.retryAfter,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The field snapshot was not written.');
    return row;
  }
}
