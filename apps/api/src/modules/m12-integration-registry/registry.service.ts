import { Inject, Injectable } from '@nestjs/common';
import type { RegistryEntry } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import type { RegistryService } from './registry.contract';

@Injectable()
export class PostgresRegistryService implements RegistryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async entries(): Promise<RegistryEntry[]> {
    const result = await this.pool.query<{ payload: RegistryEntry; stale: boolean }>(
      `SELECT payload, stale FROM registry_snapshot ORDER BY payload->>'slug'`,
    );
    return result.rows.map((row) => this.project(row.payload, row.stale));
  }

  async entry(slug: string): Promise<RegistryEntry> {
    const result = await this.pool.query<{ payload: RegistryEntry; stale: boolean }>(
      `SELECT payload, stale FROM registry_snapshot WHERE payload->>'slug' = $1`,
      [slug],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No registry entry for slug ${slug}.`,
        remediation: 'Refresh the registry projection.',
      });
    }
    return this.project(row.payload, row.stale);
  }

  async stale(): Promise<RegistryEntry[]> {
    const result = await this.pool.query<{ payload: RegistryEntry; stale: boolean }>(
      `SELECT payload, stale FROM registry_snapshot WHERE stale ORDER BY payload->>'slug'`,
    );
    return result.rows.map((row) => this.project(row.payload, row.stale));
  }

  /** `stale` is stored, but the column is the authority: a projection can be older than its row. */
  private project(payload: RegistryEntry, stale: boolean): RegistryEntry {
    const nextReview = payload.nextReviewAt === undefined ? null : Date.parse(payload.nextReviewAt);
    const overdue = nextReview !== null && Number.isFinite(nextReview) && nextReview < Date.now();
    return { ...payload, stale: stale || overdue };
  }
}
