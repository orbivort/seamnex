import { Module } from '@nestjs/common';
import { CatalogRepositoryModule } from '../m22-catalog-repository/catalog-repo.module';
import { SOURCE_RESOLVER_SERVICE, TRUSTED_REGISTRY_SERVICE } from './source-resolver.contract';
import { FilesystemSourceResolver } from './source-resolver.service';
import { PostgresTrustedRegistryService } from './trusted-registry.service';

/**
 * M02 — source resolution and the compose policy (4A.2, 4A.3).
 *
 * `CatalogRepositoryModule` is here because confirming a scaffold draft records a commit in M22's
 * table; the write lives there, so the edge has to exist.
 */
@Module({
  imports: [CatalogRepositoryModule],
  providers: [
    { provide: SOURCE_RESOLVER_SERVICE, useClass: FilesystemSourceResolver },
    { provide: TRUSTED_REGISTRY_SERVICE, useClass: PostgresTrustedRegistryService },
  ],
  exports: [SOURCE_RESOLVER_SERVICE, TRUSTED_REGISTRY_SERVICE],
})
export class SourceResolverModule {}
