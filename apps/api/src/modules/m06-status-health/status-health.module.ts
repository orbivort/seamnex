import { Module } from '@nestjs/common';
import { DockerModule } from '../../common/docker/docker.module';
import { ExecutorModule } from '../m05-executor/executor.module';
import { SamplerService } from './sampler.service';
import { STATUS_HEALTH_SERVICE } from './status-health.contract';
import { PostgresStatusHealthService } from './status-health.service';

/**
 * M06 — status, health and readiness (4B.1, 4B.2).
 *
 * Two edges, both declared: `ExecutorModule` for the deployment state the sampler cycles, and
 * `DockerModule` for the one typed client it probes with. The Docker client used to arrive through
 * M05's re-export, which made "probing a container" look like a dependency on the executor's whole
 * surface — and was why M05 and M07 had to import each other.
 */
@Module({
  imports: [ExecutorModule, DockerModule],
  providers: [
    PostgresStatusHealthService,
    SamplerService,
    { provide: STATUS_HEALTH_SERVICE, useExisting: PostgresStatusHealthService },
  ],
  exports: [STATUS_HEALTH_SERVICE, PostgresStatusHealthService, SamplerService],
})
export class StatusHealthModule {}
