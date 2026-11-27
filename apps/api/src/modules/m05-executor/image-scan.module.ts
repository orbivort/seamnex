import { Global, Module } from '@nestjs/common';
import { DockerModule } from '../../common/docker/docker.module';
import { IMAGE_SCAN_SERVICE } from './executor.contract';
import { PostgresImageScanService } from './image-scan.service';

/**
 * NFR-4.6 / S-10 — the scan service, visible to every role.
 *
 * It is its own `@Global()` module rather than a provider of `ExecutorModule` because the retention
 * sweep lives in the scheduler, and `JobsModule` must not import `ExecutorModule` — the executor
 * imports the job surface, so that edge is a cycle the design avoids. A global module keeps one
 * instance (one `SEAMNEX_SCAN_TMP_DIR` policy, one audit wiring) while letting the pipeline, the
 * instance screen and the sweep share it.
 */
@Global()
@Module({
  imports: [DockerModule],
  providers: [{ provide: IMAGE_SCAN_SERVICE, useClass: PostgresImageScanService }],
  exports: [IMAGE_SCAN_SERVICE],
})
export class ImageScanModule {}
