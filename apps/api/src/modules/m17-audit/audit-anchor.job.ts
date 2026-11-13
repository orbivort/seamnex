import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditService } from './audit.contract';
import { AUDIT_SERVICE } from './audit.contract';

/**
 * Daily external anchor (design §7.2 `audit_anchor`, deliverable 1.5).
 *
 * The anchor records the last sequence and hash at a day boundary, so a later deletion of a whole
 * partition is detectable: the chain can be recomputed only up to an anchored point. Signing and
 * off-host storage of the anchor arrive with Phase 4C's platform backup.
 */
@Injectable()
export class AuditAnchorJob {
  private readonly logger = new Logger('audit-anchor');

  constructor(@Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  /** `day` is exclusive: the anchor covers everything before that instant (default: today 00:00Z). */
  async run(day: Date = startOfUtcDay(new Date())): Promise<void> {
    await this.audit.anchor(day);
    this.logger.log({ day: day.toISOString().slice(0, 10) }, 'audit anchor written');
  }
}

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
