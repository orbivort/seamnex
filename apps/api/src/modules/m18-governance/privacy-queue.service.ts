import { Inject, Injectable } from '@nestjs/common';
import type { PrivacyQueue, PrivacyRequest } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { isUuid } from '../../common/http/uuid';
import {
  dsarCatalogue,
  toPrivacyRequest,
  type DsarScope,
  type DsarRow,
  type PersonalDataMapRow,
} from './dsar-scopes';

/** The columns every reader of the queue needs; one projection keeps the mappers in step. */
const ROW_COLUMNS = `id, subject_ref, kind, state, opened_by, opened_at, closed_at, due_at, scopes, scope_progress, evidence`;

/**
 * The privacy queue read surface.
 *
 * Scopes come from the request's own snapshot, taken from `personal_data_map` when the request was
 * opened — the map is the contract with each product about *where* personal data lives. A request
 * opened before that snapshot existed is rendered against the current map, and a scope with no
 * recorded progress is `pending`, which is the truth before anyone has touched it.
 */
@Injectable()
export class PrivacyQueueService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async queue(): Promise<PrivacyQueue> {
    const [requests, map] = await Promise.all([this.rows(), this.map()]);
    return {
      generatedAt: new Date().toISOString(),
      requests: requests.map((row) => toPrivacyRequest(row, map)),
    };
  }

  /**
   * The write path answers with the record it just changed rather than `204`; reading it back
   * through the same mapper is what keeps `POST` and `GET` from describing the same request
   * differently.
   */
  async byId(id: string): Promise<PrivacyRequest> {
    if (!isUuid(id)) throw notFound(id);
    const request = await this.pool.query<DsarRow>(
      `SELECT ${ROW_COLUMNS} FROM dsar_request WHERE id = $1`,
      [id],
    );
    const row = request.rows[0];
    if (row === undefined) throw notFound(id);
    return toPrivacyRequest(row, await this.map());
  }

  /** The scope list a new request snapshots at open time. */
  async catalogue(kind: 'export' | 'delete'): Promise<DsarScope[]> {
    return dsarCatalogue(await this.map(), kind);
  }

  private async rows(): Promise<DsarRow[]> {
    const result = await this.pool.query<DsarRow>(
      `SELECT ${ROW_COLUMNS} FROM dsar_request ORDER BY opened_at DESC LIMIT 50`,
    );
    return result.rows;
  }

  private async map(): Promise<PersonalDataMapRow[]> {
    const result = await this.pool.query<PersonalDataMapRow>(
      `SELECT scope_type, scope_id, export_procedure, delete_procedure FROM personal_data_map ORDER BY scope_type, scope_id`,
    );
    return result.rows;
  }
}

/** A path parameter that is not a UUID cannot address a row; PostgreSQL would answer 500. */
function notFound(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No privacy request ${id}.`,
    remediation: 'Refresh the queue; the request may have been closed on another screen.',
  });
}
