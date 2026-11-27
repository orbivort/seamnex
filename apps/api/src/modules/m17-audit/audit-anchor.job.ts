import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditAnchorRecord, AuditService } from './audit.contract';
import { AUDIT_SERVICE } from './audit.contract';
import { AnchorStore } from './anchor-store.service';

/**
 * Daily signed anchor, copied off-host (design §7.2 `audit_anchor`, NFR-4.10, AC-15).
 *
 * The anchor records the last sequence and hash of a *closed* day, so deleting a whole partition
 * later is detectable: the chain can be recomputed only up to an anchored point. Two things used to
 * be missing and are now the job's whole purpose — the signature (an unsigned hash stored in the
 * same database it protects proves little) and the copy outside the host (tamper evidence that
 * lives only where the attacker lives is not evidence).
 *
 * `run` is idempotent and retries forward: the anchor row is written once, while its off-host copy
 * is attempted again on the next tick after a failure. A day whose copy cannot be written is
 * reported through the audit chain rather than a log line nobody reads, once per day.
 */
@Injectable()
export class AuditAnchorJob {
  private readonly logger = new Logger('audit-anchor');
  /** The day whose off-host failure is already in the chain, so a retry loop reports once a day. */
  private reportedFailureFor: string | undefined;

  constructor(
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(AnchorStore) private readonly store: AnchorStore,
  ) {}

  /**
   * `day` is the UTC day being closed; the default anchors yesterday, because a day is only closed
   * once it has ended. Anchoring "today" at midnight recorded a boundary that could be rewritten
   * for the rest of the day, which is the opposite of what an anchor is for.
   */
  async run(day: Date = lastClosedUtcDay(new Date())): Promise<AuditAnchorRecord | null> {
    const anchor = await this.audit.anchor(day);
    if (anchor === null) {
      this.logger.log({ day: day.toISOString().slice(0, 10) }, 'no audit events to anchor');
      return null;
    }

    const exported = await this.audit.exportAnchors();
    let key: string;
    try {
      key = await this.store.put(anchor, exported.signing, exported.chainHead);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { day: anchor.day, key: this.store.keyFor(anchor.day), err: reason },
        'the audit anchor could not be copied off-host',
      );
      await this.reportFailureOnce(anchor, reason);
      throw error;
    }
    this.reportedFailureFor = undefined;

    /*
     * Recorded only after both halves happened, and best-effort: a chain write that fails must not
     * make the scheduler rewrite the object every tick for the rest of the day.
     */
    await this.audit
      .append({
        action: 'audit.anchor.recorded',
        actorType: 'system',
        actorId: 'audit-anchor-job',
        targetType: 'audit_anchor',
        targetId: anchor.day,
        outcome: 'success',
        detail: {
          day: anchor.day,
          lastSeq: anchor.lastSeq,
          offHostKey: key,
          signed: anchor.signature !== null,
        },
      })
      .catch((error: unknown) => {
        this.logger.error(
          { day: anchor.day, err: error instanceof Error ? error.message : String(error) },
          'anchor written but its audit row could not be appended',
        );
      });

    this.logger.log(
      { day: anchor.day, lastSeq: anchor.lastSeq, key, signed: anchor.signature !== null },
      'signed audit anchor written and copied off-host',
    );
    return anchor;
  }

  /**
   * NFR-4.10's failure mode, recorded where an auditor will look.
   *
   * An anchor that never left the host leaves the platform unable to prove tamper evidence for
   * that day; the append itself can fail, and then the log line in the caller is all there is,
   * which is why it carries the object key.
   */
  private async reportFailureOnce(anchor: AuditAnchorRecord, reason: string): Promise<void> {
    if (this.reportedFailureFor === anchor.day) return;
    this.reportedFailureFor = anchor.day;
    await this.audit
      .append({
        action: 'audit.anchor.offhost_failed',
        actorType: 'system',
        actorId: 'audit-anchor-job',
        targetType: 'audit_anchor',
        targetId: anchor.day,
        outcome: 'failure',
        detail: { day: anchor.day, key: this.store.keyFor(anchor.day), reason },
      })
      .catch(() => undefined);
  }
}

/** The most recent UTC day that has fully elapsed — the only day that can be anchored. */
export function lastClosedUtcDay(value: Date): Date {
  return new Date(startOfUtcDay(value).getTime() - 86_400_000);
}

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
