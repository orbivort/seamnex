import { Module } from '@nestjs/common';
import { PortalBffModule } from '../m10-portal-bff/portal-bff.module';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { RelayModule } from '../m24-sign-in-relay/relay.module';
import { IDENTITY_SYNC_SERVICE } from './identity-sync.contract';
import { PostgresIdentitySyncService } from './identity-sync.service';
import { IDENTITY_PUSH } from './identity-push.contract';
import { ProductIdentityPushService } from './product-identity.push';
import { SyncWorkerService } from './sync-worker.service';

/**
 * `PortalBffModule` is here for the session, which a disabled account's kill-switch needs (AC-12).
 * It used to arrive through a global, so this module looked like it owned sessions itself.
 *
 * `RelayModule` is here for the other half of offboarding (ADR-BE-22): disabling a person must also
 * disable the product account the relay signs in as, and delete the credential it holds.
 *
 * `SecretsModule` is the FR-2.4 role push: the product's admin token lives in the instance secret
 * scope, and the adapter opens it through the audited interface rather than reading a config value.
 */
@Module({
  imports: [PortalBffModule, RelayModule, SecretsModule],
  providers: [
    SyncWorkerService,
    { provide: IDENTITY_PUSH, useClass: ProductIdentityPushService },
    { provide: IDENTITY_SYNC_SERVICE, useClass: PostgresIdentitySyncService },
  ],
  exports: [IDENTITY_SYNC_SERVICE, SyncWorkerService],
})
export class IdentitySyncModule {}
