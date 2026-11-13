import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { OutboxRow } from '@seamnex/db';
import { isUuid } from '../../common/http/uuid';
import { OUTBOX_SERVICE, type Outbox } from '../m17-audit/audit.contract';
import { PRODUCT_ACCOUNT_SERVICE, type ProductAccountService } from './relay.contract';

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
 */
@Injectable()
export class RelayProvisionTrigger implements OnModuleInit {
  private readonly logger = new Logger('m24-relay-provision');

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
      await this.accounts.provisionInstance(row.aggregate_id).catch((error: unknown) => {
        this.logger.error(
          `provisioning after ${row.event_type} failed for ${row.aggregate_id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }
}
