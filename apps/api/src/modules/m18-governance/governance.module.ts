import { Module } from '@nestjs/common';
import { GOVERNANCE_SERVICE, GOVERNANCE_WRITES, UPSTREAM_OBSERVER } from './governance.contract';
import { GovernanceWritesService } from './governance-writes.service';
import { PostgresGovernanceService } from './governance.service';
import { PrivacyQueueService } from './privacy-queue.service';
import { UpstreamFeedClient } from './upstream-feed.client';
import { UpstreamIngestService } from './upstream-ingest.service';
import { IdentitySyncModule } from '../m08-identity-sync/identity-sync.module';
import { AccessControlModule } from '../m09-access-control/access-control.module';
import { PortalBffModule } from '../m10-portal-bff/portal-bff.module';
import { SecretsModule } from '../m15-secrets/secrets.module';

@Module({
  // Declared edges, not globals: governance decides an access request by asking its owner (M08) to
  // apply the transition and its owner (M10) to grant the entitlement, inside one transaction.
  // M09 owns `role_binding`, which FR-4.11's approver eligibility is decided against.
  imports: [IdentitySyncModule, AccessControlModule, PortalBffModule, SecretsModule],
  providers: [
    GovernanceWritesService,
    PrivacyQueueService,
    // FR-2.12: the feeds are providers so a test can substitute them; the pass itself owns the
    // write, and the token is how the scheduler and the route reach it.
    UpstreamFeedClient,
    { provide: UPSTREAM_OBSERVER, useClass: UpstreamIngestService },
    { provide: GOVERNANCE_SERVICE, useClass: PostgresGovernanceService },
    // The write surface the scheduler reaches, as an interface rather than the class.
    { provide: GOVERNANCE_WRITES, useExisting: GovernanceWritesService },
  ],
  exports: [
    GOVERNANCE_SERVICE,
    GOVERNANCE_WRITES,
    UPSTREAM_OBSERVER,
    GovernanceWritesService,
    PrivacyQueueService,
  ],
})
export class GovernanceModule {}
