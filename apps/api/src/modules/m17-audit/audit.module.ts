import { Global, Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { AnchorStore } from './anchor-store.service';
import { AnchorSigner } from './anchor-signer';
import { AuditAnchorJob } from './audit-anchor.job';
import { AUDIT_SERVICE, OUTBOX_SERVICE } from './audit.contract';
import { AuditQueryService } from './audit-query.service';
import { PostgresAuditService } from './audit.service';
import { OutboxService } from './outbox';

/**
 * M17 — the audit chain (design §7.2). Cross-cutting: nearly every module appends to it.
 *
 * Two dependencies are new with the signed anchor, and both are cross-cutting or platform
 * machinery, so no boundary was widened: M15's secret store holds the Ed25519 key (an audited read
 * per use, like every other secret) and `common/storage` holds the bucket the daily anchor is
 * copied to. SecretsModule does not import this module, so the graph stays acyclic.
 */
@Global()
@Module({
  imports: [SecretsModule, StorageModule],
  providers: [
    PostgresAuditService,
    AuditQueryService,
    AnchorSigner,
    AnchorStore,
    AuditAnchorJob,
    // AD-18 — one outbox per process: producers inject the token, the scheduler dispatches the
    // concrete service, and both must be the instance that holds the registered handlers.
    OutboxService,
    { provide: AUDIT_SERVICE, useExisting: PostgresAuditService },
    { provide: OUTBOX_SERVICE, useExisting: OutboxService },
  ],
  exports: [AUDIT_SERVICE, OUTBOX_SERVICE, OutboxService, AuditQueryService, AuditAnchorJob],
})
export class AuditModule {}
