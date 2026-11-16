import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { OutboxService } from '../modules/m17-audit/outbox';
import { AuditAnchorJob } from '../modules/m17-audit/audit-anchor.job';
import { JobService } from './job.service';
import {
  dropExpiredAuditEventPartitions,
  dropExpiredJobLogPartitions,
  ensurePlatformPartitions,
} from '../common/db/partitions';
import { lastClosedUtcDay } from '../modules/m17-audit/audit-anchor.job';
import { METRICS } from '../common/metrics/metrics';
import type { Metrics } from '../common/metrics/metrics';
import { AUDIT_SERVICE, type AuditService } from '../modules/m17-audit/audit.contract';
import {
  GOVERNANCE_WRITES,
  type GovernanceWrites,
} from '../modules/m18-governance/governance.contract';
import {
  NOTIFICATION_SERVICE,
  type NotificationService,
} from '../modules/m20-notification/notification.contract';
import {
  BACKUP_RESTORE_SERVICE,
  type BackupRestoreService,
} from '../modules/m16-backup-restore/backup-restore.contract';
import {
  INTEGRATION_SERVICE,
  type IntegrationService,
} from '../modules/m07-integration/integration.contract';
import {
  PRODUCT_ACCOUNT_SERVICE,
  type ProductAccountService,
} from '../modules/m24-sign-in-relay/relay.contract';
import {
  ENVIRONMENT_DRIFT,
  type EnvironmentDriftService,
} from '../modules/m22-catalog-repository/environment-drift.contract';
import {
  OBSERVABILITY_SERVICE,
  type ObservabilityService,
} from '../modules/m21-observability/observability.contract';
import {
  ACCESS_CONTROL_SERVICE,
  type AccessControlService,
} from '../modules/m09-access-control/access-control.contract';
import { AppError } from '../common/problem/app-error';
import { RunMirrorService } from '../modules/m13-workflow/run-mirror.service';
import { WorkflowAuthoringService } from '../modules/m13-workflow/authoring.service';
import { PipelineRegistry } from './pipeline-registry';

/**
 * The scheduler role (deliverable 1.4/1.5): the only place that runs repeatable platform work.
 *
 * Keeping it in one process is deliberate — two schedulers would double every anchor and every
 * partition creation. The outbox claim is safe either way (`FOR UPDATE SKIP LOCKED`).
 */
@Injectable()
export class SchedulerService implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new Logger('scheduler');
  private timer: NodeJS.Timeout | undefined;
  private lastAnchorDay: string | undefined;
  private running = false;

  private lastNotificationAt = 0;
  private lastIdentityReconcileAt = 0;
  private lastRelaySweepAt = 0;
  private lastDriftSweepAt = 0;
  private lastCredentialSweepAt = 0;
  private lastScrapeReconcileAt = 0;
  /** `instanceId → epoch ms` of the last repair request, so one drift cannot queue a loop of jobs. */
  private readonly driftRepairs = new Map<string, number>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(JobService) private readonly jobs: JobService,
    /** The stage list of each kind; a drift repair queues the same `reconfigure` an operator would. */
    @Inject(PipelineRegistry) private readonly pipelines: PipelineRegistry,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditAnchorJob) private readonly anchor: AuditAnchorJob,
    /**
     * Optional so a build without M20 still schedules jobs. `NotificationModule` is global, so the
     * token resolves wherever the module is imported; an absent module leaves the token undefined.
     */
    /**
     * The break-glass sweep closes overdue grants, and closing one is evidence: the row moves only
     * if the chain can record why. `AuditModule` is global, so the token resolves here; the
     * optional form keeps a graph without it from failing to boot.
     */
    @Optional()
    @Inject(AUDIT_SERVICE)
    private readonly audit?: AuditService,
    @Optional()
    @Inject(NOTIFICATION_SERVICE)
    private readonly notifications?: NotificationService,
    /** 4C: the backup runner ticks its schedule table from this pass. */
    @Optional()
    @Inject(BACKUP_RESTORE_SERVICE)
    private readonly backups?: BackupRestoreService,
    /** 4D.1: the IdP's membership of each instance network is repaired from this pass. */
    @Optional()
    @Inject(INTEGRATION_SERVICE)
    private readonly integration?: IntegrationService,
    /**
     * 4F: the break-glass sweep. `break_glass_session` belongs to M18, so the sweep calls its
     * interface; optional because a graph without governance still has jobs to schedule.
     */
    @Optional()
    @Inject(GOVERNANCE_WRITES)
    private readonly governance?: GovernanceWrites,
    /**
     * ADR-BE-22: per-user product accounts. Their provisioning and rotation are passes rather than a
     * job kind — they are per-user work on an administrative cadence, and the deployment queue is
     * about instances.
     */
    @Optional()
    @Inject(PRODUCT_ACCOUNT_SERVICE)
    private readonly relayAccounts?: ProductAccountService,
    /**
     * ADR-BE-12 D9 places the execution mirror in the broker-proxy role, which has no deployed
     * process in this stack (`docker/compose.dev.yml` defines no such service, so the role boots and
     * idles). The scheduler role hosts it instead: same "one process owns repeatable work" rule.
     *
     * It runs on its **own** interval (`RunMirrorService.start`, 10 s by default), not on this
     * scheduler's pass. Riding the pass meant a run could only be settled once a minute, so the run
     * history showed `Running` long after n8n had finished, and the settle time leaked into the
     * recorded duration.
     */
    @Optional()
    @Inject(RunMirrorService)
    private readonly runMirror?: RunMirrorService,
    /**
     * FR-1.29 / NFR-3.6. `drift_record` is M22's table, so the producer lives there and the cadence
     * — and the decision to repair — lives here. Optional for the same reason as the others: a graph
     * without the catalog repository still has jobs to schedule.
     */
    @Optional()
    @Inject(ENVIRONMENT_DRIFT)
    private readonly drift?: EnvironmentDriftService,
    /**
     * NFR-4.14 — a live workflow's credential must not expire under it. M13 owns the mint, n8n and the
     * compiled definition; this pass owns only the cadence, exactly as the backup schedule does.
     * Optional: a process without the workflow module still has jobs to schedule.
     */
    @Optional()
    @Inject(WorkflowAuthoringService)
    private readonly workflows?: WorkflowAuthoringService,
    /**
     * FR-2.6 / AC-45 — the scrape-target projection. A target is a file Prometheus watches, so the
     * thing that must be repeated is keeping that directory equal to the set of live instances:
     * published after a deploy, removed after a delete. Optional like the other passes.
     */
    @Optional()
    @Inject(OBSERVABILITY_SERVICE)
    private readonly observability?: ObservabilityService,
    /**
     * NFR-4.10 — `audit_retention_days` has to reach the partition drop, and M09 owns settings.
     * Optional for the same reason as the others: an unreadable or absent settings source must skip
     * the pass, never fall back to a default that deletes audit data nobody asked it to delete.
     */
    @Optional()
    @Inject(ACCESS_CONTROL_SERVICE)
    private readonly access?: AccessControlService,
  ) {}

  /**
   * Partition upkeep runs at boot of *every* role, not only the scheduler. A missing `job_log`
   * partition fails every log append, and a missing `audit_event` partition refuses every audited
   * mutation — so a scheduler that has been down for longer than the lookahead window must not be
   * able to brick the API that is still serving.
   */
  async onModuleInit(): Promise<void> {
    /*
     * `@Optional()` keeps a graph without a module bootable, but an absent token used to be
     * indistinguishable from a healthy one: the pass owned by that module simply returned. One line
     * at boot says which passes this process does not run.
     */
    const absent = [
      ['audit', this.audit],
      ['audit retention', this.access],
      ['notification', this.notifications],
      ['backup', this.backups],
      ['integration', this.integration],
      ['sign-in relay', this.relayAccounts],
      ['workflow mirror', this.runMirror],
      ['workflow credentials', this.workflows],
      ['environment drift', this.drift],
      ['observability scrapes', this.observability],
    ]
      .filter(([, dependency]) => dependency === undefined)
      .map(([name]) => name);
    if (absent.length > 0) {
      this.logger.warn(
        { absent },
        'optional scheduler dependencies absent; the passes they own are skipped in this process',
      );
    }

    await this.ensurePartitions().catch((error: unknown) => {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'partition upkeep failed at boot; audited mutations will fail closed until it succeeds',
      );
    });
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.config.SEAMNEX_SCHEDULER_INTERVAL_MS);
    // The interval must not be the reason a drained process stays alive.
    this.timer.unref();
    /*
     * The mirror keeps its own timer rather than riding this pass: it is the only way a run that
     * ended 200 ms after it started is recorded within a poll interval instead of within a minute.
     * One scheduler process owns it, so there is still exactly one poller.
     */
    this.runMirror?.start();
    void this.tick();
    this.logger.log({ intervalMs: this.config.SEAMNEX_SCHEDULER_INTERVAL_MS }, 'scheduler started');
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.runMirror?.stop();
  }

  /** One pass. Public so a test can run it without waiting for the interval. */
  async tick(): Promise<void> {
    if (this.running) {
      // A skipped pass used to be invisible; an operator needs to see the scheduler falling behind.
      this.metrics.schedulerSkippedPasses.inc();
      this.logger.warn('scheduler pass skipped: the previous pass is still running');
      return;
    }
    this.running = true;
    try {
      await this.outbox.dispatchBatch();
      await this.jobs.redispatchQueued();
      await this.jobs.reapIdempotencyKeys();
      await this.anchorOncePerDay();
      await this.ensurePartitions();
      await this.sampleQueueDepth();
      await this.expireBreakGlass();
      await this.evaluateNotifications();
      await this.reconcileScrapeTargets();
      await this.tickBackupSchedules();
      await this.reconcileIdentityNetworks();
      await this.sweepRelayAccounts();
      await this.rotateWorkflowCredentials();
      await this.reconcileDrift();
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'scheduler pass failed',
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * NFR-4.10 — one signed anchor per *closed* day.
   *
   * The day is marked anchored only after `run` returns, so a failed off-host copy is retried on the
   * next pass: the anchor row is already immutable, and re-running it is a no-op that only repeats
   * the copy. Marking first would have turned one transient object-store outage into a day with no
   * off-host evidence.
   */
  private async anchorOncePerDay(): Promise<void> {
    const closed = lastClosedUtcDay(new Date());
    const day = closed.toISOString().slice(0, 10);
    if (this.lastAnchorDay === day) return;
    await this.anchor.run(closed);
    this.lastAnchorDay = day;
  }

  /**
   * FR-4.11 — "expiry revokes automatically" was a claim without a job.
   *
   * The capability reveal already refuses a session past `expires_at`, and readers derive the state,
   * so nothing could be *used* after the window. What was missing is the record: the row stayed
   * `active` until a person pressed revoke, the expiry notice never fired, and "who ended this grant
   * and when" had no answer for an auditor. This closes overdue grants and writes the evidence.
   *
   * No audit chain, no state change: a grant is never silently ended.
   */
  private async expireBreakGlass(): Promise<void> {
    const chain = this.audit;
    const governance = this.governance;
    // Closing a grant is evidence: the row moves only if the chain can record why.
    if (chain === undefined || governance === undefined) return;

    const overdue = await governance.expireOverdueBreakGlass();

    for (const row of overdue) {
      await chain.append({
        action: 'breakglass.expired',
        actorType: 'system',
        actorId: 'system',
        targetType: 'break_glass_session',
        targetId: row.id,
        outcome: 'success',
        detail: { reason: 'time box elapsed; in-product access revoked' },
      });
    }

    if (overdue.length > 0) {
      this.logger.log({ expired: overdue.length }, 'break-glass grants expired');
    }
  }

  /**
   * Partition upkeep. A missing partition is an audit append failure, which refuses a mutation
   * (AD-20) — so this must run ahead of the window, not in reaction to an error.
   *
   * The SQL lives in `common/db/partitions` because a platform restore has to repeat it: the restored
   * database carries only the partitions the dump was taken with.
   */
  async ensurePartitions(): Promise<void> {
    await ensurePlatformPartitions(this.pool, this.config.SEAMNEX_PARTITION_LOOKAHEAD_DAYS);
    const dropped = await dropExpiredJobLogPartitions(
      this.pool,
      this.config.SEAMNEX_JOB_LOG_RETENTION_DAYS,
    );
    for (const partition of dropped) {
      this.logger.log({ partition }, 'dropped expired job_log partition');
    }
    await this.applyAuditRetention();
  }

  /**
   * NFR-4.10 — apply `audit_retention_days` to `audit_event`.
   *
   * The setting existed and had no consumer: the console displayed it, an operator could change it,
   * and audit partitions were kept forever. Two guards, both in the honest direction. An unreadable
   * setting means the pass does not run — never "assume the default and delete". A value below the
   * twelve-month floor is refused by the same function, so a row seeded before the schema floor
   * cannot shorten retention either.
   *
   * The drop is DDL on a partition the API role does not own (the definer function handles it), and
   * it is audited: an auditor has to be able to tell "nothing was old enough" from "nobody ran it".
   */
  private async applyAuditRetention(): Promise<void> {
    if (this.access === undefined) return;
    const chain = this.audit;

    let retentionDays: number;
    try {
      retentionDays = (await this.access.settings()).settings.auditRetentionDays;
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'audit retention skipped: settings are unreadable, so nothing is dropped',
      );
      return;
    }

    let dropped: string[];
    try {
      dropped = await dropExpiredAuditEventPartitions(this.pool, retentionDays);
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'audit retention failed; expired partitions were not dropped',
      );
      return;
    }
    if (dropped.length === 0) return;

    for (const partition of dropped) {
      this.logger.log({ partition, retentionDays }, 'dropped expired audit_event partition');
    }
    await chain
      ?.append({
        action: 'audit.retention.enforced',
        actorType: 'system',
        actorId: 'scheduler',
        targetType: 'audit_event',
        targetId: dropped.join(','),
        outcome: 'success',
        detail: { retentionDays, partitions: dropped },
      })
      .catch((error: unknown) => {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'audit partitions were dropped but the retention row could not be appended',
        );
      });
  }

  /**
   * Health and break-glass notices at most once every five minutes. Threshold evaluation reads
   * state, so a shorter cadence would only re-derive the same answer — and the dedupe window is what
   * keeps a permanently degraded instance from writing a notification per pass.
   */
  private async evaluateNotifications(): Promise<void> {
    if (this.notifications === undefined) return;
    const now = Date.now();
    if (now - this.lastNotificationAt < 300_000) return;
    this.lastNotificationAt = now;
    const result = await this.notifications.evaluate();
    await this.notifications.flush();
    if (result.sent > 0 || result.suppressed > 0) {
      this.logger.log(
        { sent: result.sent, suppressed: result.suppressed },
        'notifications evaluated',
      );
    }
  }

  /**
   * FR-2.6 — the scrape targets, reconciled against the live portfolio.
   *
   * A minute is the cadence because the alternative is a target that outlives its instance: a
   * deleted instance's file would keep Prometheus scraping a 404 and reporting the platform's own
   * series as down. `writeTarget` skips unchanged content, so the usual pass costs N reads.
   */
  private async reconcileScrapeTargets(): Promise<void> {
    if (this.observability === undefined) return;
    const now = Date.now();
    if (now - this.lastScrapeReconcileAt < 60_000) return;
    this.lastScrapeReconcileAt = now;
    const result = await this.observability.reconcile();
    if (result.written > 0 || result.removed > 0) {
      this.logger.log(
        { written: result.written, removed: result.removed },
        'scrape targets reconciled',
      );
    }
  }

  /**
   * 4D.1 — the repair that makes "the login works" durable.
   *
   * Docker attaches a container to a network; recreating either one drops the membership. Keycloak
   * is re-created by every `compose up` after an image change, so the membership written during the
   * last reconfigure is gone long before the next one — and the product's login then fails at the
   * last step, after the browser has already been redirected back. The check verifies the
   * attachment, but only when someone asks it to; this pass asks on a cadence, so a recreation is
   * repaired within one interval instead of at the next deployment.
   */
  private async reconcileIdentityNetworks(): Promise<void> {
    if (this.integration === undefined) return;
    const now = Date.now();
    if (now - this.lastIdentityReconcileAt < this.config.SEAMNEX_IDP_RECONCILE_INTERVAL_MS) return;
    this.lastIdentityReconcileAt = now;
    await this.integration.reconcileIdentityNetworks().catch((error: unknown) => {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'identity network reconciliation failed',
      );
    });
  }

  /**
   * ADR-BE-22 — provision missing product accounts and rotate due credentials.
   *
   * Guarded by its own interval rather than by the scheduler's: provisioning talks to a product API
   * on the instance network, and doing that every pass would put a network round trip per entitlement
   * on the platform's most frequent timer.
   */
  private async sweepRelayAccounts(): Promise<void> {
    if (this.relayAccounts === undefined) return;
    const now = Date.now();
    if (now - this.lastRelaySweepAt < this.config.SEAMNEX_RELAY_SWEEP_INTERVAL_MS) return;
    this.lastRelaySweepAt = now;
    await this.relayAccounts.sweep().catch((error: unknown) => {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'sign-in relay account sweep failed',
      );
    });
  }

  /**
   * NFR-4.14 — re-issue workflow credentials before they expire.
   *
   * Its own interval rather than the scheduler pass: a rotation is a mint, an n8n credential, a push
   * and a commit per workflow, and doing that every minute would put several network round trips on
   * the platform's most frequent timer for a change that is due once a quarter.
   */
  private async rotateWorkflowCredentials(): Promise<void> {
    const workflows = this.workflows;
    if (workflows === undefined) return;
    const now = Date.now();
    if (
      now - this.lastCredentialSweepAt <
      this.config.SEAMNEX_WORKFLOW_CREDENTIAL_SWEEP_INTERVAL_MS
    ) {
      return;
    }
    this.lastCredentialSweepAt = now;
    const result = await workflows.rotateDueCredentials().catch((error: unknown) => {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'workflow credential rotation pass failed',
      );
      return { rotated: 0, skipped: 0 };
    });
    if (result.rotated > 0 || result.skipped > 0) {
      this.logger.log(
        { rotated: result.rotated, skipped: result.skipped },
        'workflow credentials rotated',
      );
    }
  }

  /**
   * FR-1.29 / NFR-3.6 — observe, then repair only what the repository can repair.
   *
   * The pass records what the running containers actually carry, audits only what is *new* (a
   * permanent drift must not write an audit row every interval), and repairs declarative drift in
   * the one direction the state-authority rule allows:
   *
   *   - `repo_ahead` — the declaration moved after the last apply, so a `reconfigure` re-renders it
   *     from the repository and the next scan proves the repair;
   *   - `runtime_ahead` — someone changed the container outside the platform. Reverting that
   *     silently would erase the only trace of the change, so the finding stays open for an
   *     operator, which is what AC-43 requires ("reported as drift, not applied silently").
   *
   * Definition drift is repaired by re-committing the recorded projection; a tree that cannot be
   * written keeps the flag and keeps blocking `start`.
   */
  private async reconcileDrift(): Promise<void> {
    const drift = this.drift;
    if (drift === undefined) return;
    const now = Date.now();
    if (now - this.lastDriftSweepAt < this.config.SEAMNEX_DRIFT_INTERVAL_MS) return;
    this.lastDriftSweepAt = now;

    for (const instanceId of await drift.scannable()) {
      let result: Awaited<ReturnType<EnvironmentDriftService['scan']>>;
      try {
        result = await drift.scan(instanceId);
      } catch (error) {
        this.logger.warn(
          { instanceId, err: error instanceof Error ? error.message : String(error) },
          'drift scan failed; the instance keeps its previous findings',
        );
        continue;
      }
      if (!result.observed) continue;

      if (result.created.length > 0) {
        await this.appendDriftAudit('instance.drift.detected', instanceId, {
          variables: result.created,
        });
      }
      const repairable = result.detected.filter((finding) => finding.direction === 'repo_ahead');
      if (repairable.length === 0) continue;
      await this.requestDriftRepair(
        instanceId,
        repairable.map((finding) => finding.varName),
      );
    }

    for (const instanceId of await drift.definitionDrift()) {
      try {
        const written = await drift.reconcileDefinition(instanceId, 'system');
        if (written === null) continue;
        await this.appendDriftAudit('instance.definition.reconciled', instanceId, {
          path: written.path,
          contentHash: written.contentHash,
        });
      } catch (error) {
        this.logger.warn(
          { instanceId, err: error instanceof Error ? error.message : String(error) },
          'definition drift could not be reconciled; start keeps refusing until it is',
        );
      }
    }
  }

  /**
   * Queue the same `reconfigure` an operator would, from the registered stage list.
   *
   * `INSTANCE_BUSY` is expected, not exceptional: `deployment_job_one_active_per_instance` is the
   * real guard against two repairs, and the cooldown keeps this pass from asking again immediately.
   */
  private async requestDriftRepair(
    instanceId: string,
    variables: readonly string[],
  ): Promise<void> {
    const last = this.driftRepairs.get(instanceId);
    if (last !== undefined && Date.now() - last < this.config.SEAMNEX_DRIFT_REPAIR_COOLDOWN_MS) {
      return;
    }
    const steps = this.pipelines.stepsFor('reconfigure');
    if (steps.length === 0) return;

    try {
      const created = await this.jobs.create({
        kind: 'reconfigure',
        instanceId,
        requestedBy: 'system',
        payload: { action: 'reconfigure', reason: 'environment-drift', variables },
        steps,
      });
      this.driftRepairs.set(instanceId, Date.now());
      await this.appendDriftAudit('instance.drift.repair_requested', instanceId, {
        jobId: created.job.id,
        variables,
      });
      this.logger.log({ instanceId, jobId: created.job.id, variables }, 'drift repair queued');
    } catch (error) {
      if (error instanceof AppError && error.code === 'INSTANCE_BUSY') {
        this.logger.debug({ instanceId }, 'drift repair skipped: another job holds the instance');
        return;
      }
      this.logger.error(
        { instanceId, err: error instanceof Error ? error.message : String(error) },
        'drift repair could not be queued',
      );
    }
  }

  /** Drift evidence names variables, never values. */
  private async appendDriftAudit(
    action: string,
    instanceId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (this.audit === undefined) return;
    await this.audit.append({
      action,
      actorType: 'system',
      actorId: 'm22-environment-drift',
      targetType: 'instance',
      targetId: instanceId,
      outcome: 'success',
      detail,
    });
  }

  /** 4C.1: due backups are started by the runner, on the scheduler's cadence. */
  private async tickBackupSchedules(): Promise<void> {
    if (this.backups === undefined) return;
    await this.backups.tickSchedules().catch((error: unknown) => {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'backup schedule pass failed',
      );
    });
  }

  /** The queue of record is the database, so its depth is what an operator needs to see. */
  private async sampleQueueDepth(): Promise<void> {
    const result = await this.pool.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text AS count FROM deployment_job GROUP BY state`,
    );
    for (const row of result.rows) {
      this.metrics.queueDepth.labels('seamnex-jobs', row.state).set(Number(row.count));
    }
  }
}
