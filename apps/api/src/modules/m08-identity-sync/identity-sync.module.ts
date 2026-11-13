import { Module } from '@nestjs/common';
import { PortalBffModule } from '../m10-portal-bff/portal-bff.module';
import { RelayModule } from '../m24-sign-in-relay/relay.module';
import { IDENTITY_SYNC_SERVICE } from './identity-sync.contract';
import { PostgresIdentitySyncService } from './identity-sync.service';
import { SyncWorkerService } from './sync-worker.service';

/**
 * `PortalBffModule` is here for the session, which a disabled account's kill-switch needs (AC-12).
 * It used to arrive through a global, so this module looked like it owned sessions itself.
 *
 * `RelayModule` is here for the other half of offboarding (ADR-BE-22): disabling a person must also
 * disable the product account the relay signs in as, and delete the credential it holds.
 */
@Module({
  imports: [PortalBffModule, RelayModule],
  providers: [
    SyncWorkerService,
    { provide: IDENTITY_SYNC_SERVICE, useClass: PostgresIdentitySyncService },
  ],
  exports: [IDENTITY_SYNC_SERVICE, SyncWorkerService],
})
export class IdentitySyncModule {}
