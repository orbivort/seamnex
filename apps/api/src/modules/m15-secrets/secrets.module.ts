import { Module } from '@nestjs/common';
import { SECRETS_SERVICE } from './secrets.contract';
import { EnvelopeSecretsService } from './secrets.service';

/**
 * M15 is cross-cutting (`manifest.crossCutting`), which means every module may *depend on its
 * interface* — not that the provider is invisible. Consumers state the edge.
 */
@Module({
  providers: [{ provide: SECRETS_SERVICE, useClass: EnvelopeSecretsService }],
  exports: [SECRETS_SERVICE],
})
export class SecretsModule {}
