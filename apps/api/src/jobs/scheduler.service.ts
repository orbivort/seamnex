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
import { RunMirrorService } from '../modules/m13-workflow/run-mirror.service';

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

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(JobService) private readonly jobs: JobService,
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
      ['notification', this.notifications],
      ['backup', this.backups],
      ['integration', this.integration],
      ['sign-in relay', this.relayAccounts],
      ['workflow mirror', this.runMirror],
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
      await this.tickBackupSchedules();
      await this.reconcileIdentityNetworks();
      await this.sweepRelayAccounts();
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'scheduler pass failed',
      );
    } finally {
      this.running = false;
    }
  }

  private async anchorOncePerDay(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastAnchorDay === today) return;
    await this.anchor.run(new Date(`${today}T00:00:00.000Z`));
    this.lastAnchorDay = today;
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
   */
  async ensurePartitions(): Promise<void> {
    const today = utcDayStart(new Date());

    for (let offset = 0; offset <= this.config.SEAMNEX_PARTITION_LOOKAHEAD_DAYS; offset += 1) {
      const from = addDays(today, offset);
      // The casts are required: an untyped parameter cannot resolve the function overload.
      await this.pool.query(
        'SELECT seamnex_ensure_partition($1::text, $2::text, $3::timestamptz, $4::timestamptz)',
        ['job_log', `job_log_p${formatDay(from)}`, from, addDays(today, offset + 1)],
      );
    }

    // Audit partitions are monthly; three months of lookahead is the design's floor.
    for (let offset = 0; offset <= 2; offset += 1) {
      const from = addMonths(today, offset);
      await this.pool.query(
        'SELECT seamnex_ensure_partition($1::text, $2::text, $3::timestamptz, $4::timestamptz)',
        [
          'audit_event',
          `audit_event_p${from.getUTCFullYear()}${String(from.getUTCMonth() + 1).padStart(2, '0')}`,
          from,
          addMonths(today, offset + 1),
        ],
      );
    }

    await this.dropExpiredJobLogPartitions();
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

  private async dropExpiredJobLogPartitions(): Promise<void> {
    const result = await this.pool.query<{ partition: string }>(
      `SELECT child.relname AS partition
         FROM pg_inherits
         JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
         JOIN pg_class child ON child.oid = pg_inherits.inhrelid
        WHERE parent.relname = 'job_log'`,
    );

    const cutoff = addDays(utcDayStart(new Date()), -this.config.SEAMNEX_JOB_LOG_RETENTION_DAYS);

    for (const { partition } of result.rows) {
      const match = /^job_log_p(\d{4})(\d{2})(\d{2})$/.exec(partition);
      if (match === null) continue;
      const [, year, month, day] = match;
      const partitionDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
      if (partitionDate >= cutoff) continue;
      // Dropped through the definer function: the API role does not own the partition, and must
      // not hold DDL rights over the log just to enforce retention.
      await this.pool.query('SELECT seamnex_drop_partition($1::text, $2::text)', [
        'job_log',
        partition,
      ]);
      this.logger.log({ partition }, 'dropped expired job_log partition');
    }
  }
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function formatDay(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
}
