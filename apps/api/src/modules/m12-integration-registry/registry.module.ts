import { Module } from '@nestjs/common';
import { REGISTRY_SERVICE } from './registry.contract';
import { RegistryFeedService } from './registry-feed.service';
import { PostgresRegistryService } from './registry.service';

@Module({
  providers: [
    RegistryFeedService,
    { provide: REGISTRY_SERVICE, useClass: PostgresRegistryService },
  ],
  exports: [REGISTRY_SERVICE, RegistryFeedService],
})
export class RegistryModule {}
