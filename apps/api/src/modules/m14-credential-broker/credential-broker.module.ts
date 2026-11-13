import { Module } from '@nestjs/common';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { CREDENTIAL_BROKER_SERVICE } from './credential-broker.contract';
import { BrokeredCredentialService } from './credential-broker.service';

/** M14 - the credential broker (4E.3). It brokers M15's secrets; the edge says so. */
@Module({
  imports: [SecretsModule],
  providers: [{ provide: CREDENTIAL_BROKER_SERVICE, useClass: BrokeredCredentialService }],
  exports: [CREDENTIAL_BROKER_SERVICE],
})
export class CredentialBrokerModule {}
