import { Module } from '@nestjs/common';
import { DockerModule } from '../../common/docker/docker.module';
import { CredentialBrokerModule } from '../m14-credential-broker/credential-broker.module';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { WORKFLOW_EGRESS_SERVICE } from './egress.contract';
import { BrokerEgressService } from './egress.service';

/**
 * M25 — the broker's outbound hop (4E.4, AD-10).
 *
 * It depends on M14 for the scope behind a token and on M15 for the product credential; it owns no
 * table of its own, because the only thing it decides is whether one call may leave the platform.
 */
@Module({
  imports: [DockerModule, CredentialBrokerModule, SecretsModule],
  providers: [{ provide: WORKFLOW_EGRESS_SERVICE, useClass: BrokerEgressService }],
  exports: [WORKFLOW_EGRESS_SERVICE],
})
export class WorkflowEgressModule {}
