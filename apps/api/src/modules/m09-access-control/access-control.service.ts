import { Inject, Injectable } from '@nestjs/common';
import { PlatformSettingsSchema, type PlatformRole, type PlatformSettings } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { withTransaction } from '@seamnex/db';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { assertIfMatch, etagFor } from '../../common/http/etag';
import type { AccessControlService } from './access-control.contract';
import { PolicyCompiler } from './policy.compiler';

/** R5 is "member": the least privileged role that still sees a portal. */
const FALLBACK_ROLE: PlatformRole = 'R5';

/** Database key ↔ API field. The wire uses camelCase; the table uses snake_case (design §7.2). */
const SETTING_KEYS: Record<string, keyof PlatformSettings> = {
  break_glass_max_minutes: 'breakGlassMaxMinutes',
  restore_concurrency: 'restoreConcurrency',
  oversubscription_factor: 'oversubscriptionFactor',
  session_idle_minutes: 'sessionIdleMinutes',
  session_absolute_hours: 'sessionAbsoluteHours',
  audit_retention_days: 'auditRetentionDays',
  metadata_review_days: 'metadataReviewDays',
};

const FIELD_TO_KEY = new Map(Object.entries(SETTING_KEYS).map(([key, field]) => [field, key]));

const DEFAULTS = {
  breakGlassMaxMinutes: 60,
  restoreConcurrency: 4,
  oversubscriptionFactor: 1.25,
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 12,
  metadataReviewDays: 90,
  auditRetentionDays: 420,
} as const;

@Injectable()
export class PostgresAccessControlService implements AccessControlService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    // Explicit token: no `emitDecoratorMetadata` at runtime (see `contract/route-table.ts`).
    @Inject(PolicyCompiler) private readonly compiler: PolicyCompiler,
  ) {}

  async roleFor(subjectIdpId: string): Promise<PlatformRole> {
    const result = await this.pool.query<{ role: PlatformRole }>(
      `SELECT role FROM role_binding
        WHERE subject_idp_id = $1 AND (expires_at IS NULL OR expires_at > now())
        ORDER BY role
        LIMIT 1`,
      [subjectIdpId],
    );
    return result.rows[0]?.role ?? FALLBACK_ROLE;
  }

  async grantsFor(subjectIdpId: string) {
    const result = await this.pool.query<{
      role: PlatformRole;
      scope_type: 'platform' | 'domain' | 'instance';
      scope_id: string | null;
      expires_at: Date | null;
    }>(
      // DISTINCT: a platform grant has a NULL scope, so the unique constraint cannot stop a repeat
      // row; the projection must not show one role chip per historical insert.
      `SELECT DISTINCT role, scope_type, scope_id, expires_at FROM role_binding
        WHERE subject_idp_id = $1 AND (expires_at IS NULL OR expires_at > now())
        ORDER BY role`,
      [subjectIdpId],
    );
    return result.rows.map((row) => ({
      role: row.role,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      expiresAt: row.expires_at?.toISOString() ?? null,
    }));
  }

  async settings(): Promise<{ settings: PlatformSettings; etag: string }> {
    const result = await this.pool.query<{
      key: string;
      value: unknown;
      updated_by: string | null;
      updated_at: Date;
    }>(`SELECT key, value, updated_by, updated_at FROM settings`);
    const values: Record<string, unknown> = { ...DEFAULTS };
    let updatedAt = new Date(0);
    let updatedBy = 'system';

    for (const row of result.rows) {
      const field = SETTING_KEYS[row.key];
      if (field !== undefined && typeof row.value === 'number') values[field] = row.value;
      // `audit_retention_months` predates the days-based API field.
      if (row.key === 'audit_retention_months' && typeof row.value === 'number') {
        values.auditRetentionDays = row.value * 30;
      }
      if (row.updated_at > updatedAt) {
        updatedAt = row.updated_at;
        updatedBy = row.updated_by ?? 'system';
      }
    }

    const settings = PlatformSettingsSchema.parse({
      ...values,
      updatedAt: (updatedAt.getTime() === 0 ? new Date() : updatedAt).toISOString(),
      updatedBy,
    });
    return { settings, etag: etagFor([settings.updatedAt, settings.updatedBy]) };
  }

  async putSettings(
    values: Record<string, number>,
    expectedEtag: string | undefined,
    actorId: string,
  ): Promise<{ settings: PlatformSettings; etag: string }> {
    const current = await this.settings();
    // The prototype answers 412 for a missing `If-Match` as well (settings is the only declared
    // conditional operation) — a silent overwrite of platform policy is the failure mode to avoid.
    assertIfMatch({
      header: expectedEtag,
      etag: current.etag,
      required: true,
      detail: 'The settings changed since they were read.',
    });

    const merged = {
      ...current.settings,
      ...values,
      updatedAt: new Date().toISOString(),
      updatedBy: actorId,
    };
    const next = PlatformSettingsSchema.parse(merged);

    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      for (const [field, value] of Object.entries(values)) {
        const key = FIELD_TO_KEY.get(field as keyof PlatformSettings);
        if (key === undefined) continue;
        await tx.query(
          `INSERT INTO settings (key, value, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(value), actorId],
        );
      }
      await this.audit.append(
        {
          action: 'settings.updated',
          actorType: 'user',
          actorId,
          targetType: 'platform',
          targetId: 'settings',
          outcome: 'success',
          detail: { changed: Object.keys(values) },
        },
        tx,
      );
    });

    return { settings: next, etag: etagFor([next.updatedAt, next.updatedBy]) };
  }

  /**
   * ADR-BE-05: recompiling is an administrative action, and the compiled row is what a denial is
   * attributed to. The route layer evaluates through `PdpService`; this method keeps the module
   * contract as the compile seam.
   */
  async compilePolicy(): Promise<{ version: number }> {
    const compiled = await this.compiler.compile();
    return { version: compiled.version };
  }
}
