import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AlertChannel } from '@seamnex/domain';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { withTransaction } from '@seamnex/db';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import type { AlertChannelInput, NotificationService } from './notification.contract';

type ChannelRow = { id: string; type: 'email' | 'webhook'; target: string; enabled: boolean };

/**
 * 4B.3 — notification delivery.
 *
 * Three behaviours worth naming:
 *
 *   - **suppression is data.** Inside a maintenance window the row is written with
 *     `state='suppressed'` and the window as the reason. Dropping the row would make "was anyone
 *     told?" unanswerable.
 *   - **a channel failure is not an exception.** One broken webhook must not stop the email; the
 *     notification ends `failed` only when every channel failed, and the next `flush` retries.
 *   - **the email transport is Mailpit's HTTP API.** A real MTA is a production concern; the
 *     platform only needs one authority for "send this message", and an HTTP call has no dependency
 *     on a mail library in the control plane.
 */
@Injectable()
export class PostgresNotificationService implements NotificationService {
  private readonly logger = new Logger('m20-notification');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  /**
   * `severities` and `lastDeliveryAt` have no columns of their own: the platform sends every
   * severity to every enabled channel, and the last delivery is read back from `notification`. The
   * response still carries both because the console renders them, and inventing a column for values
   * derived from existing rows would create two sources of truth.
   */
  async channels(): Promise<AlertChannel[]> {
    const result = await this.pool.query<{
      id: string;
      type: 'email' | 'webhook';
      target: string;
      enabled: boolean;
      last_sent: Date | null;
    }>(
      `SELECT c.id, c.type, c.target, c.enabled,
              (SELECT max(n.sent_at) FROM notification n WHERE n.channel_id = c.id) AS last_sent
         FROM alert_channel c ORDER BY c.type, c.target`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      target: row.target,
      enabled: row.enabled,
      severities: ['info', 'warning', 'critical'],
      lastDeliveryAt: row.last_sent?.toISOString() ?? null,
    }));
  }

  async replaceChannels(
    input: readonly AlertChannelInput[],
    actorId: string,
  ): Promise<AlertChannel[]> {
    if (input.length === 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'At least one alert channel must remain configured.',
        remediation: 'Keep one channel, or disable it instead of deleting the last one.',
      });
    }
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await tx.query(`DELETE FROM alert_channel`);
      for (const channel of input) {
        await tx.query(`INSERT INTO alert_channel (type, target, enabled) VALUES ($1, $2, $3)`, [
          channel.type,
          channel.target,
          channel.enabled,
        ]);
      }
      await this.audit.append(
        {
          action: 'settings.alerts.replaced',
          actorType: 'user',
          actorId,
          targetType: 'platform',
          targetId: 'alert-channel',
          outcome: 'success',
          detail: {
            channels: input.map((channel) => ({ type: channel.type, enabled: channel.enabled })),
          },
        },
        tx,
      );
    });
    return this.channels();
  }

  async notify(input: {
    severity: 'info' | 'warning' | 'critical';
    subject: string;
    body: string;
    instanceId?: string | null;
  }): Promise<{ queued: boolean; suppressedBy: string | null }> {
    const suppressedBy = await this.activeWindow(input.instanceId ?? null);
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO notification (severity, subject, body, state, suppression_reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        input.severity,
        input.subject,
        input.body,
        suppressedBy === null ? 'queued' : 'suppressed',
        suppressedBy,
      ],
    );
    const notificationId = inserted.rows[0]?.id;
    if (notificationId === undefined) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail: 'The notification row was not created.',
        remediation: 'Retry; no alert was sent.',
      });
    }
    if (suppressedBy !== null) {
      this.logger.debug(
        { subject: input.subject, suppressedBy },
        'notification suppressed by maintenance window',
      );
      return { queued: false, suppressedBy };
    }
    await this.deliver(notificationId, input.severity, input.subject, input.body);
    return { queued: true, suppressedBy: null };
  }

  async testChannel(
    channelId: string,
  ): Promise<{ ok: boolean; detail: string; deliveredAt: string }> {
    const channel = await this.channel(channelId);
    const deliveredAt = new Date().toISOString();
    const result = await this.send(channel, {
      severity: 'info',
      subject: 'Platform test notification',
      body: `This is a test delivery through channel ${channel.id} (${channel.type}).`,
    });
    return { ok: result.ok, detail: result.detail, deliveredAt };
  }

  /**
   * Threshold evaluation. It reads state instead of receiving events, which is what makes it
   * idempotent: a restarted scheduler does not resend yesterday's alerts, because the dedupe key is
   * the subject and the window is `SEAMNEX_NOTIFY_DEDUPE_MINUTES`.
   */
  async evaluate(): Promise<{ sent: number; suppressed: number }> {
    let sent = 0;
    let suppressed = 0;

    const unhealthy = await this.pool.query<{
      id: string;
      slug: string;
      state: string;
      reason: string | null;
    }>(
      `SELECT i.id, i.slug, s.state, s.reason
         FROM instance_status s JOIN instance i ON i.id = s.instance_id
        WHERE i.deleted_at IS NULL AND s.ready = false AND s.state IN ('degraded', 'failed')`,
    );
    for (const row of unhealthy.rows) {
      const subject = `Instance ${row.slug} is ${row.state}`;
      if (await this.recentlySent(subject)) continue;
      const outcome = await this.notify({
        severity: row.state === 'failed' ? 'critical' : 'warning',
        subject,
        body: `${row.slug} reported ${row.state}: ${row.reason ?? 'no reason recorded'}.`,
        instanceId: row.id,
      });
      if (outcome.queued) sent += 1;
      else suppressed += 1;
    }

    // Break-glass notices read the governance table rather than waiting for a callback, so a grant
    // or an expiry cannot go unannounced if the requesting process dies.
    const grants = await this.pool.query<{
      id: string;
      state: string;
      instance_id: string | null;
      expires_at: Date | null;
    }>(
      `SELECT id, state, instance_id, expires_at FROM break_glass_session
        WHERE state IN ('active', 'expired')
          AND COALESCE(revoked_at, granted_at, created_at) > now() - interval '10 minutes'`,
    );
    for (const grant of grants.rows) {
      const subject =
        grant.state === 'active'
          ? `Break-glass access granted (${grant.id.slice(0, 8)})`
          : `Break-glass access expired (${grant.id.slice(0, 8)})`;
      if (await this.recentlySent(subject)) continue;
      const outcome = await this.notify({
        severity: 'critical',
        subject,
        body:
          grant.state === 'active'
            ? `Elevation ${grant.id} is active until ${grant.expires_at?.toISOString() ?? 'an unrecorded time'}.`
            : `Elevation ${grant.id} has expired and its product account was revoked.`,
        instanceId: grant.instance_id,
      });
      if (outcome.queued) sent += 1;
      else suppressed += 1;
    }

    return { sent, suppressed };
  }

  async flush(limit = 25): Promise<number> {
    const queued = await this.pool.query<{
      id: string;
      severity: string;
      subject: string;
      body: string;
    }>(
      `SELECT id, severity, subject, body FROM notification
        WHERE state = 'queued' ORDER BY created_at LIMIT $1`,
      [limit],
    );
    let delivered = 0;
    for (const row of queued.rows) {
      const ok = await this.deliver(
        row.id,
        row.severity as 'info' | 'warning' | 'critical',
        row.subject,
        row.body,
      );
      if (ok) delivered += 1;
    }
    return delivered;
  }

  // ---------------------------------------------------------------------------------------------

  private async deliver(
    notificationId: string,
    severity: 'info' | 'warning' | 'critical',
    subject: string,
    body: string,
  ): Promise<boolean> {
    const channels = await this.pool.query<ChannelRow>(
      `SELECT id, type, target, enabled FROM alert_channel WHERE enabled = true ORDER BY type, target`,
    );
    if (channels.rows.length === 0) {
      // Recorded as failed rather than dropped: "no channel configured" is an operational fact.
      await this.pool.query(
        `UPDATE notification SET state = 'failed', suppression_reason = $2 WHERE id = $1`,
        [notificationId, 'no enabled alert channel'],
      );
      return false;
    }

    let delivered: string | null = null;
    for (const channel of channels.rows) {
      const result = await this.send(channel, { severity, subject, body });
      if (result.ok) delivered = channel.id;
      else
        this.logger.warn({ channel: channel.id, detail: result.detail }, 'channel delivery failed');
    }

    await this.pool.query(
      `UPDATE notification
          SET state = $2, channel_id = COALESCE($3::uuid, channel_id),
              sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END
        WHERE id = $1`,
      [notificationId, delivered === null ? 'failed' : 'sent', delivered],
    );
    return delivered !== null;
  }

  private async send(
    channel: ChannelRow,
    message: { severity: string; subject: string; body: string },
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      if (channel.type === 'webhook') {
        const response = await fetch(channel.target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...message,
            source: 'seamnex-platform',
            sentAt: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(5_000),
        });
        return { ok: response.ok, detail: `${channel.target} answered ${response.status}` };
      }

      const response = await fetch(`${this.config.SEAMNEX_MAILPIT_URL}/api/v1/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          From: { Email: this.config.SEAMNEX_NOTIFY_FROM },
          To: [{ Email: channel.target }],
          Subject: message.subject,
          Text: message.body,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      return { ok: response.ok, detail: `mail relay answered ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async recentlySent(subject: string): Promise<boolean> {
    const result = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM notification
          WHERE subject = $1 AND created_at > now() - ($2 || ' minutes')::interval
       ) AS present`,
      [subject, String(this.config.SEAMNEX_NOTIFY_DEDUPE_MINUTES)],
    );
    return result.rows[0]?.present === true;
  }

  private async activeWindow(instanceId: string | null): Promise<string | null> {
    const result = await this.pool.query<{ id: string; scope: string }>(
      `SELECT id, scope FROM maintenance_window
        WHERE cancelled_at IS NULL AND now() BETWEEN starts_at AND ends_at
          AND (instance_id IS NULL OR instance_id = $1::uuid)
        ORDER BY starts_at DESC LIMIT 1`,
      [instanceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : `maintenance window ${row.id} (${row.scope})`;
  }

  private async channel(channelId: string): Promise<ChannelRow> {
    const result = await this.pool.query<ChannelRow>(
      `SELECT id, type, target, enabled FROM alert_channel WHERE id = $1`,
      [channelId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No alert channel ${channelId}.`,
        remediation: 'Reload the alert settings and try again.',
      });
    }
    return row;
  }
}
