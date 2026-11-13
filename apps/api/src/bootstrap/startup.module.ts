import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { DatabaseModule } from '../database/database.module';
import { RendererModule } from '../modules/m03-renderer/renderer.module';
import { AuditModule } from '../modules/m17-audit/audit.module';
import { CatalogRepositoryModule } from '../modules/m22-catalog-repository/catalog-repo.module';

/**
 * The module graph a bootstrap step needs, and nothing else.
 *
 * `AppModule` would work — `roles/start-role-work.ts` builds it for every non-HTTP role — but it also
 * opens Redis, builds the job queue and starts nothing that a one-shot projection can use. A
 * bootstrap command that fails because Redis is down would be reporting the wrong dependency, and
 * `pnpm dev` runs this before the dev servers exist. The edges below are the ones `applySchemas`
 * actually needs: configuration, the pool, the metric registry the audit service and the secret store
 * inject, the audit chain it locks, the declaration files (M22) and the projection itself (M03).
 *
 * `MetricsModule` is part of the list because it is `@Global` — global *within the graph that
 * imports it* — and `PostgresAuditService` injects `METRICS`. Leaving it out fails the container at
 * boot with "Nest can't resolve dependencies", which is how this list was corrected.
 *
 * One table owner per edge, so nothing here writes outside M03 — the projector adds no second writer
 * of `env_schema_var`; it calls the same `applySchemas` the reload calls.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    MetricsModule,
    AuditModule,
    CatalogRepositoryModule,
    RendererModule,
  ],
})
export class StartupModule {}
