import { Module } from '@nestjs/common';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { RENDERER_SERVICE } from './renderer.contract';
import { RenderSetService } from './render.service';
import { PostgresRendererService } from './renderer.service';

/**
 * M03 — environment resolution and the render set (4A.4).
 *
 * `RenderSetService` is a provider rather than an internal detail because the restore path loads a
 * stored set directly; it is not exported through the module token, so callers outside M03 still
 * see one interface.
 */
@Module({
  imports: [SecretsModule],
  providers: [RenderSetService, { provide: RENDERER_SERVICE, useClass: PostgresRendererService }],
  exports: [RENDERER_SERVICE],
})
export class RendererModule {}
