import { Inject, Injectable } from '@nestjs/common';
import { JOB_KINDS, type Job, type JobPage } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { AppError } from '../common/problem/app-error';
import { buildPage, decodeCursor, readLimit, type Cursor } from '../common/http/cursor';
import { isUuid } from '../common/http/uuid';

type Row = {
  id: string;
  kind: string;
  instance_id: string | null;
  entry_key: string | null;
  state: string;
  requested_by: string | null;
  /** Resolved from the identity directory; `requested_by` is a subject id, not a name. */
  requested_by_name: string | null;
  error_code: string | null;
  error_detail: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

const KINDS = new Set<string>(JOB_KINDS);

/**
 * Deliverable 2.5 — the paged job projection.
 *
 * Kept beside `JobService` rather than inside it because the list query is a read model: the
 * service owns the write path (state machine, queue, audit) and this owns the shape the screens
 * page through.
 */
@Injectable()
export class JobQueryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(filter: {
    instanceId?: string;
    kind?: string;
    state?: string;
    cursor?: string;
    limit?: string;
  }): Promise<JobPage> {
    const limit = readLimit(filter.limit);
    const cursor = decodeCursor(filter.cursor);
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.instanceId !== undefined) {
      if (!isUuid(filter.instanceId)) return { items: [], nextCursor: null, total: 0 };
      params.push(filter.instanceId);
      where.push(`instance_id = $${params.length}`);
    }
    if (filter.kind !== undefined) {
      params.push(filter.kind);
      where.push(`kind = $${params.length}`);
    }
    if (filter.state !== undefined) {
      params.push(filter.state);
      where.push(`state = $${params.length}`);
    }

    const total = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM deployment_job ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}`,
      params,
    );

    const pageParams = [...params];
    let keyset = '';
    if (cursor !== undefined && 'createdAt' in cursor) {
      pageParams.push(cursor.createdAt, cursor.id);
      keyset = `AND (created_at, id) < ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::uuid)`;
    }
    pageParams.push(limit + 1);

    const rows = await this.pool.query<Row>(
      `SELECT j.id, j.kind, j.instance_id, i.entry_key, j.state, j.requested_by,
              COALESCE(u.display_name, u.username) AS requested_by_name,
              j.error_code, j.error_detail,
              j.payload, j.created_at, j.started_at, j.finished_at
         FROM deployment_job j LEFT JOIN instance i ON i.id = j.instance_id
         LEFT JOIN idp_user u ON u.idp_id = j.requested_by
        ${where.length === 0 ? 'WHERE' : 'WHERE'} ${where.length === 0 ? 'true' : where.join(' AND ')} ${keyset}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT $${pageParams.length}`,
      pageParams,
    );

    const page = buildPage(
      rows.rows,
      limit,
      Number.parseInt(total.rows[0]?.count ?? '0', 10),
      cursorOf,
    );
    return {
      items: await this.project(page.items),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  async detail(jobId: string): Promise<Job> {
    if (!isUuid(jobId)) throw notFound(jobId);
    const rows = await this.pool.query<Row>(
      `SELECT j.id, j.kind, j.instance_id, i.entry_key, j.state, j.requested_by,
              COALESCE(u.display_name, u.username) AS requested_by_name,
              j.error_code, j.error_detail,
              j.payload, j.created_at, j.started_at, j.finished_at
         FROM deployment_job j LEFT JOIN instance i ON i.id = j.instance_id
         LEFT JOIN idp_user u ON u.idp_id = j.requested_by
        WHERE j.id = $1`,
      [jobId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound(jobId);
    const projected = await this.project([row]);
    const job = projected[0];
    if (job === undefined) throw notFound(jobId);
    return job;
  }

  private async project(rows: readonly Row[]): Promise<Job[]> {
    if (rows.length === 0) return [];
    const steps = await this.pool.query<{
      job_id: string;
      seq: number;
      name: string;
      state: string;
      started_at: Date | null;
      finished_at: Date | null;
      message: string | null;
    }>(
      `SELECT job_id, seq, name, state, started_at, finished_at, message
         FROM job_step WHERE job_id = ANY($1::uuid[]) ORDER BY seq`,
      [rows.map((row) => row.id)],
    );

    return rows.map((row) => {
      const own = steps.rows.filter((step) => step.job_id === row.id);
      const done = own.filter(
        (step) => step.state === 'succeeded' || step.state === 'skipped',
      ).length;
      const kind = KINDS.has(row.kind) ? (row.kind as Job['kind']) : 'deploy';
      return {
        id: row.id,
        kind,
        instanceId: row.instance_id,
        entryKey: row.entry_key,
        label:
          typeof row.payload.label === 'string'
            ? row.payload.label
            : `${kind} · ${row.entry_key ?? 'platform'}`,
        state: row.state as Job['state'],
        progress:
          own.length === 0
            ? row.state === 'succeeded'
              ? 100
              : 0
            : Math.round((done / own.length) * 100),
        createdAt: row.created_at.toISOString(),
        startedAt: row.started_at?.toISOString() ?? null,
        finishedAt: row.finished_at?.toISOString() ?? null,
        // A subject id is not a person. The join above resolves the directory name; an id with no
        // directory row (a service actor, or a deleted user) still falls back to what was recorded.
        requestedBy: row.requested_by_name ?? row.requested_by ?? 'system',
        summary: typeof row.payload.summary === 'string' ? row.payload.summary : `${kind} job`,
        errorCode: row.error_code,
        errorMessage: row.error_detail,
        steps: own.map((step) => ({
          seq: step.seq,
          name: step.name,
          state: step.state as Job['steps'][number]['state'],
          startedAt: step.started_at?.toISOString() ?? null,
          finishedAt: step.finished_at?.toISOString() ?? null,
          message: step.message,
        })),
      };
    });
  }
}

function cursorOf(row: Row): Cursor {
  return { createdAt: row.created_at.toISOString(), id: row.id };
}

function notFound(id: string): AppError {
  return new AppError({ code: 'NOT_FOUND', status: 404, detail: `No such job ${id}.` });
}
