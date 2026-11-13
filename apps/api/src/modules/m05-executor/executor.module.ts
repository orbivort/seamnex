import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { DockerModule } from '../../common/docker/docker.module';
import { SourceResolverModule } from '../m02-source-resolver/source-resolver.module';
import { RendererModule } from '../m03-renderer/renderer.module';
import { PlannerModule } from '../m04-planner/planner.module';
import { CapacityModule } from '../m19-capacity/capacity.module';
import { IntegrationModule } from '../m07-integration/integration.module';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { DeploymentPipeline } from './pipeline';
import { InstanceLifecycleService } from './lifecycle.service';
import { EXECUTOR_SERVICE } from './executor.contract';
import { PostgresExecutorService } from './executor.service';

@Module({
  imports: [
    JobsModule,
    SourceResolverModule,
    RendererModule,
    PlannerModule,
    CapacityModule,
    DockerModule,
    IntegrationModule,
    SecretsModule,
  ],
  providers: [
    DeploymentPipeline,
    InstanceLifecycleService,
    { provide: EXECUTOR_SERVICE, useClass: PostgresExecutorService },
  ],
  // Only the executor's own service leaves this module. `DockerModule` used to be re-exported so
  // M06 and M16 could reach the client through M05; both now import it from `common/docker`, which
  // is what removed the last reason for the M05 <-> M07 cycle.
  exports: [EXECUTOR_SERVICE],
})
export class ExecutorModule {}
