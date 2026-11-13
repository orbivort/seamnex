import { Module } from '@nestjs/common';
import { GOVERNANCE_SERVICE, GOVERNANCE_WRITES } from './governance.contract';
import { GovernanceWritesService } from './governance-writes.service';
import { PostgresGovernanceService } from './governance.service';
import { PrivacyQueueService } from './privacy-queue.service';
import { IdentitySyncModule } from '../m08-identity-sync/identity-sync.module';
import { PortalBffModule } from '../m10-portal-bff/portal-bff.module';
import { SecretsModule } from '../m15-secrets/secrets.module';

@Module({
  // Declared edges, not globals: governance decides an access request by asking its owner (M08) to
  // apply the transition and its owner (M10) to grant the entitlement, inside one transaction.
  imports: [IdentitySyncModule, PortalBffModule, SecretsModule],
  providers: [
    GovernanceWritesService,
    PrivacyQueueService,
    { provide: GOVERNANCE_SERVICE, useClass: PostgresGovernanceService },
    // The write surface the scheduler reaches, as an interface rather than the class.
    { provide: GOVERNANCE_WRITES, useExisting: GovernanceWritesService },
  ],
  exports: [GOVERNANCE_SERVICE, GOVERNANCE_WRITES, GovernanceWritesService, PrivacyQueueService],
})
export class GovernanceModule {}
