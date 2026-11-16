import { Module } from '@nestjs/common';
import { DockerModule } from '../../common/docker/docker.module';
import { RendererModule } from '../m03-renderer/renderer.module';
import { CATALOG_REPOSITORY } from './catalog-repo.contract';
import { WorkingTreeCatalogRepository } from './catalog-repo.service';
import { ENVIRONMENT_DRIFT } from './environment-drift.contract';
import { PostgresEnvironmentDriftService } from './environment-drift.service';
import { InstanceParamsService } from './instance-params.service';

/**
 * `InstanceParamsService` is exported as a class because the instance lifecycle writes
 * `instances/<slug>/instance.yaml` before a deployment is applied; M05 may not import M22, so the
 * contract handler orchestrates the two.
 *
 * `ENVIRONMENT_DRIFT` is exported as a token: `drift_record` is M22's table, so the producer has to
 * live here (ADR-BE-03), while the scheduler — platform machinery, not a module — is the caller
 * that owns the cadence. The M03 edge is declared in `module-boundaries.json` for the same reason:
 * the declared environment is M03's to resolve, and re-implementing its precedence chain here would
 * be a second source of truth.
 *
 * Not global: M01 and M02 are the only modules that read the working tree, and both now declare
 * the edge. Being global meant the repository adapter looked like part of the framework.
 */
@Module({
  imports: [DockerModule, RendererModule],
  providers: [
    { provide: CATALOG_REPOSITORY, useClass: WorkingTreeCatalogRepository },
    { provide: ENVIRONMENT_DRIFT, useClass: PostgresEnvironmentDriftService },
    InstanceParamsService,
  ],
  exports: [CATALOG_REPOSITORY, ENVIRONMENT_DRIFT, InstanceParamsService],
})
export class CatalogRepositoryModule {}
