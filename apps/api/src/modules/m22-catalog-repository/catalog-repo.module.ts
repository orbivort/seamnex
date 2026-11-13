import { Module } from '@nestjs/common';
import { CATALOG_REPOSITORY } from './catalog-repo.contract';
import { WorkingTreeCatalogRepository } from './catalog-repo.service';
import { InstanceParamsService } from './instance-params.service';

/**
 * `InstanceParamsService` is exported as a class because the instance lifecycle writes
 * `instances/<slug>/instance.yaml` before a deployment is applied; M05 may not import M22, so the
 * contract handler orchestrates the two.
 *
 * Not global: M01 and M02 are the only modules that read the working tree, and both now declare
 * the edge. Being global meant the repository adapter looked like part of the framework.
 */
@Module({
  providers: [
    { provide: CATALOG_REPOSITORY, useClass: WorkingTreeCatalogRepository },
    InstanceParamsService,
  ],
  exports: [CATALOG_REPOSITORY, InstanceParamsService],
})
export class CatalogRepositoryModule {}
