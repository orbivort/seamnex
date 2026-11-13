import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ConfigModule } from '../../../src/config/config.module';
import { MetricsModule } from '../../../src/common/metrics/metrics.module';
import { DatabaseModule } from '../../../src/database/database.module';
import { StartupModule } from '../../../src/bootstrap/startup.module';
import { RendererModule } from '../../../src/modules/m03-renderer/renderer.module';
import { AuditModule } from '../../../src/modules/m17-audit/audit.module';
import { CatalogRepositoryModule } from '../../../src/modules/m22-catalog-repository/catalog-repo.module';

/**
 * The bootstrap graph is a decision, not an implementation detail: `AppModule` would also work and
 * would also open Redis and build the job queue, so a projector run could fail on a dependency the
 * projection never uses. This pins the edges `applySchemas` actually needs — including
 * `MetricsModule`, which is `@Global` only inside the graph that imports it and which the audit
 * service injects — and the absence of everything else.
 */
describe('StartupModule', () => {
  it('imports exactly the modules a projection needs', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', StartupModule);

    expect(imports).toEqual([
      ConfigModule,
      DatabaseModule,
      MetricsModule,
      AuditModule,
      CatalogRepositoryModule,
      RendererModule,
    ]);
  });
});
