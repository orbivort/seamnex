import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { IMAGE_TRUST_GUARD, TrustedRegistriesReader } from './trusted-registries';

/**
 * NFR-4.16 — one allow-list reader for the whole process.
 *
 * Global because the control has to reach every context that can pull or build an image: the API
 * (pre-flight, catalogue validation), each worker role (the executor's apply pipeline) and the
 * scheduler. A per-module provider would mean each of those held its own cache and, worse, a module
 * that forgot to import it would get an unwired guard and no check at all.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    TrustedRegistriesReader,
    { provide: IMAGE_TRUST_GUARD, useExisting: TrustedRegistriesReader },
  ],
  exports: [TrustedRegistriesReader, IMAGE_TRUST_GUARD],
})
export class SecurityModule {}
