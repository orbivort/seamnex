import { Inject, Injectable, Logger } from '@nestjs/common';
import { CAPABILITY_MATRIX, type PlatformRole } from '@seamnex/domain';
import type {
  Backup,
  BackupPosture,
  PlatformRestoreStatus,
  RecoveryOverview,
  RestoreDrill,
  RestorePhaseStatus,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { DockerEngineClient } from '../../common/docker/docker.client';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import {
  INTEGRATION_SERVICE,
  type IntegrationService,
} from '../m07-integration/integration.contract';
import { OUTBOX_SERVICE, type Outbox } from '../m17-audit/audit.contract';
import { JobService } from '../../jobs/job.service';
import { PipelineRegistry } from '../../jobs/pipeline-registry';
import type { BackupRestoreService, ScheduleInput } from './backup-restore.contract';

type BackupRow = {
  id: string;
  kind: 'instance' | 'platform';
  instance_id: string | null;
  render_set_id: string | null;
  state: string;
  started_at: Date;
  finished_at: Date | null;
  size_bytes: string | null;
  object_key: string | null;
  manifest: Record<string, unknown>;
  verified_at: Date | null;
  verify_method: string | null;
  error_code: string | null;
};

type RestoreRow = {
  id: string;
  backup_id: string;
  phase: string;
  state: string;
  started_at: Date;
  finished_at: Date | null;
  login_verified_at: Date | null;
  concurrency: number;
  justification: string | null;
  detail: Record<string, unknown>;
  requested_by_name: string | null;
};

/** FR-1.36: the fixed order a platform restore is reported against. */
const PLATFORM_PHASE_ORDER = [
  'preparing',
  'idp',
  'control_plane',
  'login_verified',
  'products',
  'verify',
  'complete',
] as const;

type PlatformPhase = (typeof PLATFORM_PHASE_ORDER)[number];

const PLATFORM_PHASE_LABELS: Record<PlatformPhase, string> = {
  preparing: 'Preparing the clean host',
  idp: 'Identity provider',
  control_plane: 'Control plane',
  login_verified: 'Administrative login verified',
  products: 'Product instances (parallel)',
  verify: 'Verification',
  complete: 'Complete',
};

const PLATFORM_PHASE_DETAIL: Record<PlatformPhase, string> = {
  preparing: 'Scratch stack prepared on the clean host; nothing is published yet.',
  idp: 'Realm, database and configuration restored first; no product route is reachable.',
  control_plane: 'Entitlements, audit, job history, workflow definitions and keys restored.',
  login_verified: 'An administrative login succeeded; only now may product routes be republished.',
  products: 'Product instances restored in parallel at the configured concurrency.',
  verify: 'Smoke tests per deployment: admin login and record count within tolerance.',
  complete: 'Gate released; routes republished with their previous publication state.',
};

/**
 * The API used to answer `phases: []` because `restore_run` stores one phase, not seven. The screen
 * renders a fixed seven-cell timeline, so it drew nothing. The projection is derived instead: every
 * phase before the current one has completed, the current one is where the run is, the rest wait.
 * Per-phase timestamps are unknown, so they stay null and the screen renders state, not a fake time.
 */
function platformTimeline(run: RestoreRow): RestorePhaseStatus[] {
  const failed = run.state === 'failed';
  const stoppedAt = typeof run.detail.failedPhase === 'string' ? run.detail.failedPhase : null;
  const currentPhase = failed
    ? ((stoppedAt as PlatformPhase | null) ?? 'verify')
    : ((run.phase as PlatformPhase | null) ?? 'preparing');
  const currentIndex = Math.max(0, PLATFORM_PHASE_ORDER.indexOf(currentPhase));
  const failedReason = typeof run.detail.failedReason === 'string' ? run.detail.failedReason : null;

  return PLATFORM_PHASE_ORDER.map((phase, index) => {
    const state: RestorePhaseStatus['state'] = failed
      ? index < currentIndex
        ? 'succeeded'
        : index === currentIndex
          ? 'failed'
          : 'pending'
      : index < currentIndex
        ? 'succeeded'
        : index === currentIndex
          ? run.phase === 'complete'
            ? 'succeeded'
            : 'running'
          : 'pending';

    return {
      phase,
      label: PLATFORM_PHASE_LABELS[phase],
      state,
      startedAt: state === 'running' ? run.started_at.toISOString() : null,
      finishedAt:
        state === 'succeeded' && phase === 'complete'
          ? (run.finished_at?.toISOString() ?? null)
          : null,
      detail:
        state === 'failed' && failedReason !== null
          ? `${PLATFORM_PHASE_DETAIL[phase]} ${failedReason}`
          : PLATFORM_PHASE_DETAIL[phase],
    };
  });
}

/**
 * 4C facade. Mutations record a row and hand off to the backup-runner role; nothing here blocks on
 * an upload or a dump.
 */
@Injectable()
export class PostgresBackupRestoreService implements BackupRestoreService {
  private readonly logger = new Logger('m16-backup-restore');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    // `instance_route` (the restore gate) is M07's table; M16 asks, it does not write.
    @Inject(INTEGRATION_SERVICE) private readonly integration: IntegrationService,
    @Inject(OUTBOX_SERVICE) private readonly outbox: Outbox,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(PipelineRegistry) private readonly pipelines: PipelineRegistry,
    /** Used only to bring back the product containers a restore had to stop. */
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
  ) {}

  async backups(instanceId: string): Promise<Backup[]> {
    const result = await this.pool.query<BackupRow>(
      `SELECT * FROM backup WHERE instance_id = $1 ORDER BY started_at DESC LIMIT 50`,
      [instanceId],
    );
    return Promise.all(result.rows.map((row) => this.toBackup(row)));
  }

  async schedule(
    instanceId: string,
    input: ScheduleInput,
    actorId: string,
  ): Promise<BackupPosture> {
    await this.assertInstance(instanceId);
    const cadence = cadenceOf(input.schedule);
    const nextRun = input.enabled ? nextRunAt(cadence, input.timezone) : null;
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await tx.query(
        `INSERT INTO backup_schedule (instance_id, cadence, hour_utc, weekday, timezone, next_run_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (instance_id) DO UPDATE
            SET cadence = EXCLUDED.cadence, hour_utc = EXCLUDED.hour_utc, weekday = EXCLUDED.weekday,
                timezone = EXCLUDED.timezone, next_run_at = EXCLUDED.next_run_at,
                updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [instanceId, cadence, 2, cadence === 'weekly' ? 0 : null, input.timezone, nextRun, actorId],
      );
      await this.audit.append(
        {
          action: 'instance.backup.schedule.updated',
          actorType: 'user',
          actorId,
          targetType: 'instance',
          targetId: instanceId,
          outcome: 'success',
          detail: { cadence, timezone: input.timezone, enabled: input.enabled },
        },
        tx,
      );
    });
    return this.posture(instanceId);
  }

  async createInstanceBackup(
    instanceId: string,
    requestedBy: string,
  ): Promise<{ backupId: string; jobId: string }> {
    const instance = await this.assertInstance(instanceId);
    const renderSetId = await this.activeRenderSet(instanceId);
    const backup = await this.pool.query<{ id: string }>(
      `INSERT INTO backup (kind, instance_id, render_set_id, state) VALUES ('instance', $1, $2, 'running') RETURNING id`,
      [instanceId, renderSetId],
    );
    const backupId = backup.rows[0]?.id;
    if (backupId === undefined) throw internal('The backup row was not created.');
    const job = await this.createJob('backup', instanceId, requestedBy, {
      backupId,
      slug: instance.slug,
    });
    return { backupId, jobId: job };
  }

  async verify(backupId: string, actorId: string): Promise<{ backupId: string; jobId: string }> {
    const backup = await this.loadBackup(backupId);
    const job = await this.createJob('verify', backup.instance_id, actorId, {
      backupId,
      mode: 'backup',
    });
    return { backupId: backup.id, jobId: job };
  }

  async restore(
    backupId: string,
    justification: string,
    actorId: string,
  ): Promise<{ restoreId: string; jobId: string }> {
    const backup = await this.loadBackup(backupId);
    if (backup.kind !== 'instance' || backup.instance_id === null) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'An instance restore needs an instance backup.',
        remediation: 'Use the platform restore endpoint for a platform-tier backup.',
      });
    }
    const run = await this.pool.query<{ id: string }>(
      `INSERT INTO restore_run (backup_id, phase, state, justification, concurrency)
       VALUES ($1, 'preparing', 'running', $2, $3) RETURNING id`,
      [backupId, justification, 4],
    );
    const restoreId = run.rows[0]?.id;
    if (restoreId === undefined) throw internal('The restore run was not created.');
    const job = await this.createJob('restore', backup.instance_id, actorId, {
      backupId,
      restoreId,
    });
    return { restoreId, jobId: job };
  }

  async restoreDrill(instanceId: string, actorId: string): Promise<RestoreDrill> {
    const instance = await this.assertInstance(instanceId);
    const latest = await this.pool.query<{ id: string }>(
      `SELECT id FROM backup WHERE instance_id = $1 AND state = 'succeeded' ORDER BY finished_at DESC LIMIT 1`,
      [instanceId],
    );
    const backupId = latest.rows[0]?.id;
    if (backupId === undefined) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: 'A drill needs a successful backup to restore.',
        remediation:
          'Take a backup first; a drill restores a real artefact, it does not fabricate one.',
      });
    }
    const drill = await this.pool.query<{ id: string; performed_at: Date }>(
      `INSERT INTO restore_drill (instance_id, smoke_test, passed, evidence_url)
       VALUES ($1, 'pending', false, '') RETURNING id, performed_at`,
      [instanceId],
    );
    const row = drill.rows[0];
    if (row === undefined) throw internal('The drill row was not created.');
    await this.createJob('verify', instanceId, actorId, {
      backupId,
      mode: 'drill',
      drillId: row.id,
    });
    return {
      id: row.id,
      instanceId,
      instanceLabel: instance.slug,
      performedAt: row.performed_at.toISOString(),
      smokeTest: 'queued',
      passed: false,
      evidenceUrl: `job:${row.id}`,
    };
  }

  async platformBackup(actorId: string): Promise<{ backupId: string; jobId: string }> {
    const backup = await this.pool.query<{ id: string }>(
      `INSERT INTO backup (kind, state) VALUES ('platform', 'running') RETURNING id`,
    );
    const backupId = backup.rows[0]?.id;
    if (backupId === undefined) throw internal('The backup row was not created.');
    const job = await this.createJob('platform-backup', null, actorId, {
      backupId,
      label: 'Platform-state backup',
      summary: 'Capture the platform state, including the identity-provider realm.',
    });
    return { backupId, jobId: job };
  }

  async platformRestore(
    backupId: string,
    justification: string,
    actorId: string,
  ): Promise<{ restoreId: string; jobId: string }> {
    const backup = await this.loadBackup(backupId);
    if (backup.kind !== 'platform') {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'A platform restore needs a platform backup.',
      });
    }
    // The contract only says "non-empty", so a one-letter reason passed here while the screen asked
    // for twenty characters. A recovery event is audited; the recorded reason has to be usable.
    if (justification.trim().length < 20) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'A platform restore needs a written justification of at least 20 characters.',
        remediation: 'Describe the incident, the scope and the expected outcome.',
      });
    }
    // A 0-byte capture that never finished was accepted as a restore source: the run then took the
    // gate down and stopped every product for an artefact that does not exist.
    if (backup.state !== 'succeeded') {
      throw new AppError({
        code: 'STATE_CONFLICT',
        status: 409,
        detail: `Backup ${backup.id} is ${backup.state}; a restore needs a finished capture.`,
        remediation: 'Wait for the capture to finish, or take a new platform backup.',
      });
    }
    const running = await this.pool.query<{ id: string }>(
      `SELECT r.id FROM restore_run r JOIN backup b ON b.id = r.backup_id
        WHERE b.kind = 'platform' AND r.state = 'running'
        ORDER BY r.started_at DESC LIMIT 1`,
    );
    const active = running.rows[0]?.id;
    if (active !== undefined) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        status: 409,
        detail: `Platform restore ${active} is still running.`,
        remediation: 'One platform restore at a time: finish or fail the current run first.',
      });
    }

    let restoreId: string | null = null;
    try {
      restoreId = await withTransaction(this.pool, async (tx) => {
        await this.audit.lockChain(tx);
        // FR-1.36 ordering: the gate closes *before* the restore starts, so no product is reachable
        // while its data is being replaced. `instance_route` belongs to M07, so the statement runs
        // there — inside this transaction, because the gate and the restore row must commit together.
        await this.integration.setAllRoutesGated(tx, true);
        await this.outbox.emit(tx, {
          aggregateType: 'instance_route',
          aggregateId: 'all',
          eventType: 'instance_route.changed',
          payload: { reason: 'platform-restore', gated: true },
        });
        const run = await tx.query<{ id: string }>(
          `INSERT INTO restore_run (backup_id, phase, state, justification, concurrency)
           VALUES ($1, 'preparing', 'running', $2, 4) RETURNING id`,
          [backupId, justification],
        );
        return run.rows[0]?.id ?? null;
      });
      if (restoreId === null) throw internal('The restore run was not created.');
      const job = await this.createJob('platform-restore', null, actorId, {
        backupId,
        restoreId,
        label: `Platform restore ${restoreId}`,
        summary:
          'Restore the identity provider first, the control plane second, then products in parallel.',
      });
      return { restoreId, jobId: job };
    } catch (error) {
      // The gate is already down at this point. Without compensation a refused job left routes
      // unpublished with nothing running to release them.
      if (restoreId !== null) await this.abandonRestore(restoreId).catch(() => undefined);
      throw error;
    }
  }

  async platformRestoreStatus(): Promise<PlatformRestoreStatus> {
    const runs = await this.platformRuns(1);
    const latest = runs[0] ?? null;
    const gated = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM instance_route WHERE gated`,
    );
    const gateOpen = Number(gated.rows[0]?.count ?? '0') === 0;

    return {
      run: latest === null ? null : { ...latest, routesUnpublishedUntilLogin: !gateOpen },
      gate: {
        routesPublished: gateOpen,
        loginVerifiedAt: latest?.loginVerifiedAt ?? null,
        detail: gateOpen
          ? 'Product routes are published.'
          : 'Product routes are held until an administrative login is verified.',
      },
      generatedAt: new Date().toISOString(),
    };
  }

  async recoveryOverview(): Promise<RecoveryOverview> {
    const [backups, drills, runs] = await Promise.all([
      this.pool.query<BackupRow>(`SELECT * FROM backup ORDER BY started_at DESC LIMIT 25`),
      this.pool.query<{
        id: string;
        instance_id: string | null;
        performed_at: Date;
        smoke_test: string | null;
        passed: boolean;
        evidence_url: string | null;
      }>(
        `SELECT id, instance_id, performed_at, smoke_test, passed, evidence_url FROM restore_drill ORDER BY performed_at DESC LIMIT 25`,
      ),
      this.platformRuns(10),
    ]);
    const gate = await this.platformRestoreStatus();
    // "Last verified restore" means a restore whose administrative login was proven — not a backup
    // that a drill once verified. It answered `never` after a completed restore.
    const lastVerified = runs.find(
      (run) => run.state === 'succeeded' && run.loginVerifiedAt !== null,
    );
    return {
      generatedAt: new Date().toISOString(),
      backups: await Promise.all(backups.rows.map((row) => this.toBackup(row))),
      // The timeline used to be hardcoded to `[]`, so the screen always said "no restore has run"
      // while a restore was closing the gate.
      runs,
      drills: drills.rows.map((row) => ({
        id: row.id,
        instanceId: row.instance_id,
        instanceLabel: row.instance_id ?? 'platform',
        performedAt: row.performed_at.toISOString(),
        smokeTest: row.smoke_test ?? 'unknown',
        passed: row.passed,
        evidenceUrl: row.evidence_url ?? '',
      })),
      gate: gate.gate,
      contents: [
        { label: 'Platform database', detail: 'pg_dump --format=custom', included: true },
        {
          label: 'Identity provider',
          detail: 'Keycloak database dump plus realm export',
          included: true,
        },
        {
          label: 'Edge configuration',
          detail: 'Traefik dynamic configuration and acme.json',
          included: true,
        },
        { label: 'Audit anchor', detail: 'audit_anchor rows', included: true },
        { label: 'Catalogue repository', detail: 'bare clone of the working tree', included: true },
      ],
      lastBackupAt:
        backups.rows.find((row) => row.state === 'succeeded')?.finished_at?.toISOString() ?? null,
      lastVerifiedRestoreAt: lastVerified?.finishedAt ?? null,
    };
  }

  /**
   * The gate opens on evidence, not on a timer: an authenticated platform operator polling the
   * restore status after the IdP came back is the proof FR-1.36 asks for. A restore whose gate never
   * opens stays `failed` and visible, which is the correct outcome for a broken identity provider.
   */
  async openGateAfterLogin(
    actorId: string,
    role: string,
  ): Promise<{ opened: boolean; reason: string }> {
    const allowed = CAPABILITY_MATRIX['recovery.manage'][role as PlatformRole] !== 'none';
    if (!allowed) return { opened: false, reason: 'the caller cannot manage recovery' };

    const pending = await this.pool.query<{ id: string }>(
      `SELECT id FROM restore_run
        WHERE state = 'running' AND phase = 'login_verified' AND login_verified_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
    );
    const runId = pending.rows[0]?.id;
    if (runId === undefined) return { opened: false, reason: 'no restore is waiting for a login' };

    const stopped = await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const run = await tx.query<{ detail: Record<string, unknown> }>(
        `UPDATE restore_run
            SET login_verified_at = now(), state = 'succeeded', phase = 'complete', finished_at = now()
          WHERE id = $1
          RETURNING detail`,
        [runId],
      );
      // `published` is the operator's decision, not the restore's. Republishing everything here
      // overrode a route that was deliberately unpublished before the restore; only the gate moves.
      await this.integration.setAllRoutesGated(tx, false);
      await this.outbox.emit(tx, {
        aggregateType: 'instance_route',
        aggregateId: 'all',
        eventType: 'instance_route.changed',
        payload: { reason: 'restore-login-verified', gated: false },
      });
      await this.audit.append(
        {
          action: 'platform.restore.gate_opened',
          actorType: 'user',
          actorId,
          targetType: 'restore_run',
          targetId: runId,
          outcome: 'success',
          detail: { role },
        },
        tx,
      );
      const detail = run.rows[0]?.detail ?? {};
      return Array.isArray(detail.stoppedContainers)
        ? detail.stoppedContainers.filter((id): id is string => typeof id === 'string')
        : [];
    });

    // The control-plane phase has to stop every product. A restore that publishes the routes and
    // leaves those containers down is a complete outage reported as a success.
    let restarted = 0;
    for (const containerId of stopped) {
      await this.docker
        .start(containerId)
        .then(() => {
          restarted += 1;
        })
        .catch(() => undefined);
    }
    if (stopped.length > 0) {
      await this.audit
        .append({
          action: 'platform.restore.products_started',
          actorType: 'service',
          actorId: 'backup-runner',
          targetType: 'restore_run',
          targetId: runId,
          outcome: restarted === stopped.length ? 'success' : 'failure',
          detail: { restarted, stopped: stopped.length },
        })
        .catch(() => undefined);
    }

    return {
      opened: true,
      reason: `restore ${runId} verified by an administrative login; ${restarted}/${stopped.length} product container(s) restarted`,
    };
  }

  async tickSchedules(): Promise<number> {
    const due = await this.pool.query<{ instance_id: string; cadence: string; timezone: string }>(
      `SELECT instance_id, cadence, timezone FROM backup_schedule
        WHERE cadence <> 'off' AND next_run_at IS NOT NULL AND next_run_at <= now()`,
    );
    let started = 0;
    for (const row of due.rows) {
      try {
        await this.createInstanceBackup(row.instance_id, 'scheduler');
      } catch (error) {
        /*
         * The cadence is **not** consumed. It used to be: the failure was swallowed with
         * `.catch(() => undefined)`, `next_run_at` moved a whole period forward and the row was
         * counted as started — so an instance could go a period with no backup, no failure record,
         * and a green board.
         *
         * The retry is scheduled fifteen minutes out rather than left in the past. Leaving it due
         * would re-attempt on every scheduler pass, turning a permanent failure into a log storm,
         * and a storm is easier to ignore than one line per quarter hour. The backup stays owed;
         * only the attempt is deferred.
         */
        this.logger.error(
          `scheduled backup for ${row.instance_id} could not be started: ` +
            `${error instanceof Error ? error.message : String(error)}; ` +
            'retrying in 15 minutes',
        );
        try {
          await this.pool.query(
            `UPDATE backup_schedule
                SET next_run_at = now() + interval '15 minutes', updated_at = now()
              WHERE instance_id = $1`,
            [row.instance_id],
          );
        } catch (retryError) {
          // Reported, not rethrown: one instance's bookkeeping must not abandon the rest of the pass.
          this.logger.error(
            `could not schedule a retry for ${row.instance_id}: ` +
              `${retryError instanceof Error ? retryError.message : String(retryError)}`,
          );
        }
        continue;
      }
      await this.pool.query(
        `UPDATE backup_schedule SET next_run_at = $2, updated_at = now() WHERE instance_id = $1`,
        [row.instance_id, nextRunAt(cadenceOf(row.cadence), row.timezone)],
      );
      started += 1;
    }
    return started;
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Platform runs only. `restore_run` has no kind column, so an instance restore used to be reported
   * as "the platform restore" — the join on the backup is what tells them apart.
   */
  private async platformRuns(limit: number): Promise<RecoveryOverview['runs']> {
    const rows = await this.pool.query<RestoreRow>(
      `SELECT r.id, r.backup_id, r.phase, r.state, r.started_at, r.finished_at,
              r.login_verified_at, r.concurrency, r.justification, r.detail,
              COALESCE(u.display_name, u.username, j.requested_by) AS requested_by_name
         FROM restore_run r
         JOIN backup b ON b.id = r.backup_id AND b.kind = 'platform'
         LEFT JOIN LATERAL (
           SELECT requested_by FROM deployment_job
            WHERE payload->>'restoreId' = r.id::text
            ORDER BY created_at DESC LIMIT 1
         ) j ON true
         LEFT JOIN idp_user u ON u.idp_id = j.requested_by
        ORDER BY r.started_at DESC
        LIMIT $1`,
      [limit],
    );

    return rows.rows.map((row) => ({
      id: row.id,
      backupId: row.backup_id,
      kind: 'platform' as const,
      phase: row.phase as RecoveryOverview['runs'][number]['phase'],
      state: row.state as 'running' | 'succeeded' | 'failed',
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      loginVerifiedAt: row.login_verified_at?.toISOString() ?? null,
      concurrency: Math.min(12, Math.max(4, row.concurrency)),
      failedReason: typeof row.detail.failedReason === 'string' ? row.detail.failedReason : null,
      phases: platformTimeline(row),
      justification: row.justification?.trim() || 'not recorded',
      requestedBy: row.requested_by_name ?? 'platform',
      routesUnpublishedUntilLogin: true,
    }));
  }

  /** Compensation for a restore whose job could not be created: the gate goes back up. */
  private async abandonRestore(restoreId: string): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await tx.query(`DELETE FROM restore_run WHERE id = $1 AND state = 'running'`, [restoreId]);
      await this.integration.setAllRoutesGated(tx, false);
      await this.outbox.emit(tx, {
        aggregateType: 'instance_route',
        aggregateId: 'all',
        eventType: 'instance_route.changed',
        payload: { reason: 'platform-restore-refused', gated: false },
      });
    });
  }

  private async posture(instanceId: string): Promise<BackupPosture> {
    const schedule = await this.pool.query<{
      cadence: string;
      timezone: string;
      next_run_at: Date | null;
    }>(`SELECT cadence, timezone, next_run_at FROM backup_schedule WHERE instance_id = $1`, [
      instanceId,
    ]);
    const latest = await this.pool.query<{ finished_at: Date | null; verified_at: Date | null }>(
      `SELECT finished_at, verified_at FROM backup WHERE instance_id = $1 AND state = 'succeeded'
        ORDER BY finished_at DESC LIMIT 1`,
      [instanceId],
    );
    const row = schedule.rows[0];
    const last = latest.rows[0];
    return {
      lastSuccessAt: last?.finished_at?.toISOString() ?? null,
      lastVerifiedRestoreAt: last?.verified_at?.toISOString() ?? null,
      schedule: row?.cadence ?? 'off',
      scheduleTimezone: row?.timezone ?? 'UTC',
      scheduleEnabled: (row?.cadence ?? 'off') !== 'off',
      verified: last?.verified_at !== null && last?.verified_at !== undefined,
    };
  }

  private async toBackup(row: BackupRow): Promise<Backup> {
    const label = await this.pool.query<{ slug: string }>(
      `SELECT slug FROM instance WHERE id = $1`,
      [row.instance_id],
    );
    return {
      id: row.id,
      kind: row.kind,
      instanceId: row.instance_id,
      instanceLabel: label.rows[0]?.slug ?? (row.kind === 'platform' ? 'platform' : 'unknown'),
      state: row.state as Backup['state'],
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      sizeBytes: Number(row.size_bytes ?? '0'),
      objectKey: row.object_key ?? '',
      includes: Array.isArray(row.manifest.includes) ? (row.manifest.includes as string[]) : [],
      verifiedAt: row.verified_at?.toISOString() ?? null,
      verifyMethod: row.verify_method,
      renderSetId: row.render_set_id ?? '',
    };
  }

  private async loadBackup(backupId: string): Promise<BackupRow> {
    const result = await this.pool.query<BackupRow>(`SELECT * FROM backup WHERE id = $1`, [
      backupId,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No backup ${backupId}.`,
        remediation: 'Refresh the recovery screen.',
      });
    }
    return row;
  }

  private async assertInstance(instanceId: string): Promise<{ id: string; slug: string }> {
    const result = await this.pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM instance WHERE id = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No instance ${instanceId}.`,
        remediation: 'Refresh the instance list.',
      });
    }
    return row;
  }

  private async activeRenderSet(instanceId: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT COALESCE(
         NULLIF(i.payload->>'activeRenderSetId', '')::uuid,
         (SELECT r.id FROM render_set r WHERE r.instance_id = i.id AND r.applied_at IS NOT NULL
           ORDER BY r.applied_at DESC LIMIT 1)
       ) AS id
         FROM instance i WHERE i.id = $1`,
      [instanceId],
    );
    return result.rows[0]?.id ?? null;
  }

  private async createJob(
    kind: string,
    instanceId: string | null,
    actorId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const steps = this.pipelines.stepsFor(kind);
    if (steps.length === 0) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail: `Job kind "${kind}" has no registered pipeline.`,
        remediation: 'This is a defect: the backup runner registers its stages at boot.',
      });
    }
    const created = await this.jobs.create({
      kind,
      ...(instanceId === null ? {} : { instanceId }),
      requestedBy: actorId,
      payload,
      steps,
    });
    return created.job.id;
  }
}

function internal(detail: string): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    detail,
    remediation: 'Retry; nothing was applied.',
  });
}

function cadenceOf(schedule: string): 'off' | 'daily' | 'weekly' | 'monthly' {
  if (schedule === 'off' || schedule === 'daily' || schedule === 'weekly' || schedule === 'monthly')
    return schedule;
  return 'daily';
}

function nextRunAt(
  cadence: 'off' | 'daily' | 'weekly' | 'monthly',
  _timezone: string,
): Date | null {
  if (cadence === 'off') return null;
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(2, 0, 0, 0);
  if (cadence === 'daily') {
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (cadence === 'weekly') {
    next.setUTCDate(next.getUTCDate() + ((7 - next.getUTCDay()) % 7 || 7));
    return next;
  }
  next.setUTCMonth(next.getUTCMonth() + 1, 1);
  return next;
}
