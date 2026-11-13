import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { DockerEngineClient } from './docker.client';

/**
 * The Docker adapter as platform infrastructure, not as M05's private property.
 *
 * It lives outside `modules/` because four modules (M05 executor, M06 status, M07 integration,
 * M16 backup) need one typed client with one connection policy. It used to sit inside
 * `m05-executor`, which forced the other three to import `../m05-executor/docker.client` — a
 * boundary violation, and the reason M05 and M07 imported each other's module classes.
 *
 * One provider, one connection policy, no cycle, no deep import.
 */
@Module({
  imports: [ConfigModule],
  providers: [DockerEngineClient],
  exports: [DockerEngineClient],
})
export class DockerModule {}
