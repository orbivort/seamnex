import type { AlertChannel } from '@seamnex/domain';

export const NOTIFICATION_SERVICE = Symbol('seamnex.m20.notification');

export type AlertChannelInput = {
  readonly id?: string;
  readonly type: 'email' | 'webhook';
  readonly target: string;
  readonly enabled: boolean;
  readonly severities?: readonly ('info' | 'warning' | 'critical')[];
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
  }): Promise<{ queued: boolean; suppressedBy: string | null }>;
  /** CL-06: send a test delivery through one configured channel. */
  testChannel(channelId: string): Promise<{ ok: boolean; detail: string; deliveredAt: string }>;
  /** Threshold evaluation, driven by the scheduler: instance health and break-glass notices. */
  evaluate(): Promise<{ sent: number; suppressed: number }>;
  /** Delivers anything left queued (a channel that was down, a retry after the fact). */
  flush(limit?: number): Promise<number>;
}
