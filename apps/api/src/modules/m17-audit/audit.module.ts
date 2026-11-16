import { Global, Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { AnchorStore } from './anchor-store.service';
import { AnchorSigner } from './anchor-signer';
import { AuditAnchorJob } from './audit-anchor.job';
import { AUDIT_SERVICE } from './audit.contract';
import { AuditQueryService } from './audit-query.service';
import { PostgresAuditService } from './audit.service';

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
    { provide: AUDIT_SERVICE, useExisting: PostgresAuditService },
  ],
  exports: [AUDIT_SERVICE, AuditQueryService, AuditAnchorJob],
})
export class AuditModule {}
