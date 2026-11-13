import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { IdentityModule } from './common/identity/identity.module';
import { MetricsModule } from './common/metrics/metrics.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { ContractModule } from './contract/contract.module';
import {
  OperationHandlers,
  OPERATION_GROUPS,
  type OperationGroup,
} from './contract/operation-handlers';
import { RouteTableService } from './contract/route-table';
import { JobHandlers } from './contract/handlers/jobs.handlers';
import { Phase2Handlers } from './contract/handlers/phase2.handlers';
import { Phase3Handlers } from './contract/handlers/phase3.handlers';
import { Phase4AHandlers } from './contract/handlers/phase4a.handlers';
import { Phase4BHandlers } from './contract/handlers/phase4b.handlers';
import { Phase4CHandlers } from './contract/handlers/phase4c.handlers';
import { Phase4DHandlers } from './contract/handlers/phase4d.handlers';
import { AuthHandlers } from './contract/handlers/auth.handlers';
import { AuditModule } from './modules/m17-audit/audit.module';
import { SecretsModule } from './modules/m15-secrets/secrets.module';
import { JobsModule } from './jobs/jobs.module';
import { NotFoundController } from './common/problem/not-found.controller';
import { ProblemFilter } from './common/problem/problem.filter';
import { RequestContextInterceptor } from './bootstrap/request-context.interceptor';
import { CsrfGuard } from './contract/guards/csrf.guard';
import { IdentityGuard } from './contract/guards/identity.guard';
import { OperationGuardBridge } from './contract/guards/nest-guard.bridge';
import { OperationGuardChain } from './contract/guards/operation-guard.chain';
import { OPERATION_GUARDS, type OperationGuard } from './contract/guards/operation-guard';
import { PolicyGuard } from './contract/guards/policy.guard';
import { RateLimitGuard } from './contract/guards/rate-limit.guard';
import { CatalogModule } from './modules/m01-catalog/catalog.module';
import { CatalogRepositoryModule } from './modules/m22-catalog-repository/catalog-repo.module';
import { SourceResolverModule } from './modules/m02-source-resolver/source-resolver.module';
import { RendererModule } from './modules/m03-renderer/renderer.module';
import { ExecutorModule } from './modules/m05-executor/executor.module';
import { StatusHealthModule } from './modules/m06-status-health/status-health.module';
import { IntegrationModule } from './modules/m07-integration/integration.module';
import { ForwardAuthModule } from './modules/m11-forward-auth/forward-auth.module';
import { CredentialBrokerModule } from './modules/m14-credential-broker/credential-broker.module';
import { TriggerIngressModule } from './modules/m23-trigger-ingress/trigger-ingress.module';
import { Phase4EHandlers } from './contract/handlers/phase4e.handlers';
import { Phase4FHandlers } from './contract/handlers/phase4f.handlers';
import { IdentitySyncModule } from './modules/m08-identity-sync/identity-sync.module';
import { AccessControlModule } from './modules/m09-access-control/access-control.module';
import { PortalBffModule } from './modules/m10-portal-bff/portal-bff.module';
import { RegistryModule } from './modules/m12-integration-registry/registry.module';
import { WorkflowModule } from './modules/m13-workflow/workflow.module';
import { GovernanceModule } from './modules/m18-governance/governance.module';
import { CapacityModule } from './modules/m19-capacity/capacity.module';
import { NotificationModule } from './modules/m20-notification/notification.module';
import { BackupRestoreModule } from './modules/m16-backup-restore/backup-restore.module';
import { RelayModule } from './modules/m24-sign-in-relay/relay.module';
import { WorkflowEgressModule } from './modules/m25-workflow-egress/workflow-egress.module';

/**
 * The single composition root (ADR-BE-03). This is the only file allowed to see more than one
 * module: individual modules communicate through their `*.contract.ts` interfaces.
 *
 * Phase 2 registers the read models and the one durable write per domain. Modules whose writer
 * lands later (M16 backup/restore, M20 notification) are imported by the phase that implements
 * them; their operations answer `501` with the owning phase in the meantime.
 */
@Module({
  imports: [
    ConfigModule,
    IdentityModule,
    MetricsModule,
    DatabaseModule,
    RedisModule,
    HealthModule,
    ContractModule,
    AuditModule,
    SecretsModule,
    JobsModule,
    CatalogRepositoryModule,
    CatalogModule,
    SourceResolverModule,
    RendererModule,
    ExecutorModule,
    StatusHealthModule,
    IntegrationModule,
    ForwardAuthModule,
    CredentialBrokerModule,
    TriggerIngressModule,
    IdentitySyncModule,
    AccessControlModule,
    PortalBffModule,
    RegistryModule,
    WorkflowModule,
    GovernanceModule,
    CapacityModule,
    NotificationModule,
    BackupRestoreModule,
    RelayModule,
    WorkflowEgressModule,
  ],
  providers: [
    RouteTableService,
    OperationHandlers,
    /*
     * The cross-cutting concerns, as framework primitives rather than imperative registrations in
     * `createApplication`. `APP_FILTER`/`APP_INTERCEPTOR`/`APP_GUARD` are resolved from the
     * container, so the filter can gain a dependency and the interceptor gets the role from
     * `APP_CONFIG` instead of a hand-passed argument.
     */
    RateLimitGuard,
    IdentityGuard,
    CsrfGuard,
    PolicyGuard,
    {
      provide: OPERATION_GUARDS,
      inject: [RateLimitGuard, IdentityGuard, CsrfGuard, PolicyGuard],
      // Registration order is evaluation order; the chain partitions it by phase.
      useFactory: (...guards: OperationGuard[]): readonly OperationGuard[] => guards,
    },
    OperationGuardChain,
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    // Protects any controller route whose path is a declared operation, with the same chain.
    { provide: APP_GUARD, useClass: OperationGuardBridge },
    AuthHandlers,
    Phase2Handlers,
    Phase3Handlers,
    Phase4AHandlers,
    Phase4BHandlers,
    Phase4CHandlers,
    Phase4DHandlers,
    Phase4EHandlers,
    Phase4FHandlers,
    JobHandlers,
    {
      provide: OPERATION_GROUPS,
      inject: [
        AuthHandlers,
        Phase2Handlers,
        Phase3Handlers,
        Phase4AHandlers,
        Phase4BHandlers,
        Phase4CHandlers,
        Phase4DHandlers,
        Phase4EHandlers,
        Phase4FHandlers,
        JobHandlers,
      ],
      useFactory: (...groups: OperationGroup[]): readonly OperationGroup[] => groups,
    },
  ],
  // Registered last so Fastify's router prefers every declared route over the catch-all.
  controllers: [NotFoundController],
})
export class AppModule {}
