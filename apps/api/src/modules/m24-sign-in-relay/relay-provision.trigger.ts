import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { OutboxRow } from '@seamnex/db';
import { isUuid } from '../../common/http/uuid';
import { OUTBOX_SERVICE, type Outbox } from '../m17-audit/audit.contract';
import { PRODUCT_ACCOUNT_SERVICE, type ProductAccountService } from './relay.contract';

/**
 * The longest deferral this trigger waits out.
 *
 * The bootstrap window is a minute when the product was unreachable and six hours when it refused
 * the credential. Only the first is a start-up race worth waiting on; a verdict belongs to the sweep
 * and the operator, and holding a timer for hours would be a second scheduler.
 */
const MAX_DEFERRED_WAIT_MS = 5 * 60 * 1_000;

/** A boot race reopens cheaply, so a few windows are covered without becoming a retry loop. */
const MAX_DEFERRED_ATTEMPTS = 3;

/** The window is written by PostgreSQL's clock; the timer runs on this process's. */
const DEFERRED_SLACK_MS = 1_000;

/**
 * ADR-BE-22 — provisioning is asked for by the deployment that needs it, not only by the clock.
 *
 * The sweep was the whole lifecycle, and a cadence is not an event: a deployment could finish and a
 * person could open the product before the next pass, see the product's own login form, and
 * conclude the relay was broken. Restarting the scheduler — whose first tick always sweeps — was
 * the only way to shorten that, which made a design defect look like an operational workaround.
 *
 * The event is durable and idempotent (AD-18): it is written in the same transaction that records
 * the deployment, it survives a restart, and `provisionInstance` runs the sweep's own selection, so
 * a replay provisions nobody twice.
 *
 * The handler swallows a failure on purpose. The event means "ask now"; the retry policy belongs to
 * the sweep, which records `relay.account.provision_failed` and waits its quiet period. Letting the
 * outbox retry instead would spend the product administrator's credential five more times on a
 * product that has already answered.
 *
 * The one retry this class *does* own is the administrator-bootstrap window, because "the product
 * had not finished booting" is not an answer: the ask arrived seconds too early, and dropping it
 * left a fresh install on the product's login form until the next sweep. So the pass is re-run when
 * the window opens, a bounded number of times, only while the wait is short.
 */
@Injectable()
export class RelayProvisionTrigger implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('m24-relay-provision');
  /** One queued re-run per instance: a second event for the same deployment must not stack. */
  private readonly queued = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    @Inject(OUTBOX_SERVICE) private readonly outbox: Outbox,
    @Inject(PRODUCT_ACCOUNT_SERVICE) private readonly accounts: ProductAccountService,
  ) {}

  onModuleInit(): void {
    /*
     * Registered in every process that mounts M24, dispatched only by the scheduler — the same
     * arrangement `RegistryFeedService` uses for `registry.rebuild`. Registering is free; the role
     * that owns the timer is the one that calls `dispatchBatch`.
     */
    this.outbox.on('relay.provision', async (row: OutboxRow) => {
      if (!isUuid(row.aggregate_id)) {
        // A row that does not name an instance cannot be turned into a selection, and passing it to
        // PostgreSQL would raise 22P02 for what is a producer's mistake.
        this.logger.warn(
          { aggregateType: row.aggregate_type, aggregateId: row.aggregate_id },
          'a relay provisioning event carries no instance id; ignored',
        );
        return;
      }
      await this.run(row.aggregate_id, row.event_type, 0);
    });
  }

  onModuleDestroy(): void {
    // `unref` already keeps the timers from holding the process open; this keeps them from firing
    // into a shutting-down container.
    for (const timer of this.queued.values()) clearTimeout(timer);
    this.queued.clear();
  }

  /**
   * One pass, then — while the bootstrap window has deferred it — another when the window opens.
   *
   * The window is what keeps the seeded administrator's password off a product that is still
   * starting. It does not make the request obsolete, so the trigger keeps it alive rather than
   * leaving the deployment's only attempt to the sweep.
   */
  private async run(instanceId: string, eventType: string, attempt: number): Promise<void> {
    await this.accounts.provisionInstance(instanceId).catch((error: unknown) => {
      this.logger.error(
        `provisioning after ${eventType} failed for ${instanceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    if (attempt >= MAX_DEFERRED_ATTEMPTS) return;
    const until = await this.accounts.deferredUntil(instanceId).catch(() => null);
    if (until === null) return;

    const wait = Date.parse(until) - Date.now();
    // A verdict, an unparseable window or an already-open one: the sweep is the next attempt.
    if (!Number.isFinite(wait) || wait <= 0 || wait > MAX_DEFERRED_WAIT_MS) return;
    this.schedule(instanceId, wait + DEFERRED_SLACK_MS, eventType, attempt + 1);
  }

  private schedule(instanceId: string, waitMs: number, eventType: string, attempt: number): void {
    if (this.queued.has(instanceId)) return;
    const timer = setTimeout(() => {
      this.queued.delete(instanceId);
      void this.run(instanceId, eventType, attempt);
    }, waitMs);
    // The trigger must not be the reason a container stays up: the sweep is still the safety net.
    timer.unref?.();
    this.queued.set(instanceId, timer);
  }
}
