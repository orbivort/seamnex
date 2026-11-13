import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE, OUTBOX_SERVICE } from './audit.contract';
import { PostgresAuditService } from './audit.service';
import { OutboxService } from './outbox';
import { AuditAnchorJob } from './audit-anchor.job';
import { AuditQueryService } from './audit-query.service';

/**
 * Cross-cutting (manifest `crossCutting`): every module may depend on the audit service interface,
 * and no module writes `audit_event` itself.
 */
@Global()
@Module({
  providers: [
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    OutboxService,
    { provide: OUTBOX_SERVICE, useExisting: OutboxService },
    AuditAnchorJob,
    AuditQueryService,
  ],
  exports: [AUDIT_SERVICE, OUTBOX_SERVICE, OutboxService, AuditAnchorJob, AuditQueryService],
})
export class AuditModule {}
