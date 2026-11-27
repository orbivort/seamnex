import type { AlertChannel } from '@seamnex/domain';

export const NOTIFICATION_SERVICE = Symbol('seamnex.m20.notification');

export type AlertChannelInput = {
  readonly id?: string;
  readonly type: 'email' | 'webhook';
  readonly target: string;
  readonly enabled: boolean;
  readonly severities?: readonly ('info' | 'warning' | 'critical')[];
};

/**
 * Who a notice is addressed to (FR-4.11).
 *
 * `email` is the mailbox from the catalogue entry's owner block. `null` means the entry records no
 * address: delivery falls back to the configured channels, and the recipient is still recorded so
 * "the owner was told" is answerable from the row rather than from an operator's memory.
 */
export type NoticeRecipient = {
  readonly name: string;
  readonly email: string | null;
};

/** Owns `alert_channel` and `notification`. Settings were Phase 2; delivery is 4B.3. */
export interface NotificationService {
  channels(): Promise<AlertChannel[]>;
  /** FR-4.6: the list is replaced wholesale; at least one channel must survive. */
  replaceChannels(input: readonly AlertChannelInput[], actorId: string): Promise<AlertChannel[]>;
  /**
   * Delivery inside a maintenance window is suppressed **and recorded** (`state='suppressed'`,
   * `suppression_reason`), never silently dropped: an operator must be able to prove after the fact
   * that an alert was held, and why (FR-4.9).
   */
  notify(input: {
    severity: 'info' | 'warning' | 'critical';
    subject: string;
    body: string;
    instanceId?: string | null;
    /** The addressee, when the notice has one. Recorded on the row either way. */
    recipient?: NoticeRecipient;
  }): Promise<{ queued: boolean; suppressedBy: string | null }>;
  /** CL-06: send a test delivery through one configured channel. */
  testChannel(channelId: string): Promise<{ ok: boolean; detail: string; deliveredAt: string }>;
  /**
   * Threshold evaluation, driven by the scheduler: instance health, capacity thresholds (FR-4.5) and
   * break-glass grant/expiry notices addressed to the domain owner (FR-4.11).
   */
  evaluate(): Promise<{ sent: number; suppressed: number }>;
  /** Delivers anything left queued (a channel that was down, a retry after the fact). */
  flush(limit?: number): Promise<number>;
}
