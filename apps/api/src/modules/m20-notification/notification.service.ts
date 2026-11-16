import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AlertChannel } from '@seamnex/domain';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { withTransaction } from '@seamnex/db';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import type {
  AlertChannelInput,
  NoticeRecipient,
  NotificationService,
} from './notification.contract';

/** Severity of one threshold breach, and the words used for it in the alert body. */
type CapacityAxis = {
  key: 'cpu' | 'memory' | 'disk';
  label: string;
  unit: string;
  threshold: number;
  usedMilliOrMb: number;
  limitMilliOrMb: number;
};

const DEFAULT_THRESHOLDS = { cpuPercent: 75, memoryPercent: 90, diskPercent: 85 };

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
    recipient?: NoticeRecipient;
  }): Promise<{ queued: boolean; suppressedBy: string | null }> {
    const suppressedBy = await this.activeWindow(input.instanceId ?? null);
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO notification
         (severity, subject, body, state, suppression_reason, recipient_name, recipient_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.severity,
        input.subject,
        input.body,
        suppressedBy === null ? 'queued' : 'suppressed',
        suppressedBy,
        // FR-4.11: the addressee is part of the record. A suppressed owner notice that named nobody
        // would be indistinguishable from a platform-wide broadcast in the alert history.
        input.recipient?.name ?? null,
        input.recipient?.email ?? null,
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
    await this.deliver(
      notificationId,
      { severity: input.severity, subject: input.subject, body: input.body },
      input.recipient,
    );
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

    // FR-4.5 — capacity thresholds. The figures are the same ones the board renders (they come from
    // the same `settings` rows), so a screen cannot promise an alert the platform does not send.
    const thresholds = await this.capacityThresholds();
    const usage = await this.pool.query<{
      id: string;
      slug: string;
      resources: { cpu?: number; memoryMb?: number; diskMb?: number } | null;
      sampled_at: Date | null;
      cpu_milli: number | null;
      memory_mb: number | null;
      disk_mb: number | null;
      containers: number | null;
    }>(
      `SELECT i.id, i.slug, i.payload->'resources' AS resources,
              s.sampled_at, s.cpu_milli, s.memory_mb, s.disk_mb, s.containers
         FROM instance i
         LEFT JOIN LATERAL (
           SELECT u.sampled_at, u.cpu_milli, u.memory_mb, u.disk_mb, u.containers
             FROM instance_usage_sample u
            WHERE u.instance_id = i.id
            ORDER BY u.sampled_at DESC
            LIMIT 1
         ) s ON true
        WHERE i.deleted_at IS NULL AND i.state = 'ready'`,
    );
    const maxAgeMs = this.config.SEAMNEX_CAPACITY_SAMPLE_INTERVAL_MS * 2;
    for (const row of usage.rows) {
      if (row.sampled_at === null || (row.containers ?? 0) === 0) continue;
      if (Date.now() - row.sampled_at.getTime() > maxAgeMs) continue;
      const axes: CapacityAxis[] = [
        {
          key: 'cpu',
          label: 'CPU',
          unit: 'millicores',
          threshold: thresholds.cpuPercent,
          usedMilliOrMb: row.cpu_milli ?? 0,
          limitMilliOrMb: (row.resources?.cpu ?? 0) * 1000,
        },
        {
          key: 'memory',
          label: 'memory',
          unit: 'MB',
          threshold: thresholds.memoryPercent,
          usedMilliOrMb: row.memory_mb ?? 0,
          limitMilliOrMb: row.resources?.memoryMb ?? 0,
        },
        {
          key: 'disk',
          label: 'disk',
          unit: 'MB',
          threshold: thresholds.diskPercent,
          usedMilliOrMb: row.disk_mb ?? 0,
          limitMilliOrMb: row.resources?.diskMb ?? 0,
        },
      ];
      for (const axis of axes) {
        if (axis.limitMilliOrMb <= 0) continue;
        const percent = (axis.usedMilliOrMb / axis.limitMilliOrMb) * 100;
        if (percent < axis.threshold) continue;
        // Quantised per instance and axis, so a series that hovers at the line alerts once per dedupe
        // window instead of once per sample.
        const subject = `Capacity: ${row.slug} ${axis.label} above ${axis.threshold}%`;
        if (await this.recentlySent(subject)) continue;
        const critical = percent >= axis.threshold + 10;
        const outcome = await this.notify({
          severity: critical ? 'critical' : 'warning',
          subject,
          body: `${row.slug} is using ${Math.round(axis.usedMilliOrMb)} of ${Math.round(axis.limitMilliOrMb)} ${axis.unit} (${Math.round(percent)} %), at or above the configured ${axis.threshold} % threshold. Sampled ${row.sampled_at.toISOString()}.`,
          instanceId: row.id,
        });
        if (outcome.queued) sent += 1;
        else suppressed += 1;
      }
    }

    /*
     * FR-4.11 — break-glass notices are addressed to the domain owner.
     *
     * Two changes from the previous pass, both about honesty:
     *   - the owner is resolved from the instance's catalogue entry. It used to be the literal
     *     "Platform", so the requirement "notifies the domain owner" named the wrong party.
     *   - the window is a marker, not a ten-minute look-back. A grant whose first evaluation ran late
     *     was never announced at all; now each transition is announced exactly once, whenever it is
     *     first observed, and the row says when.
     */
    const notices = await this.pool.query<{
      id: string;
      state: string;
      instance_id: string | null;
      expires_at: Date | null;
      product: string | null;
      owner_name: string | null;
      owner_email: string | null;
    }>(
      `SELECT b.id, b.state, b.instance_id, b.expires_at,
              coalesce(i.payload->>'product', i.entry_key) AS product,
              c.payload #>> '{owner,name}' AS owner_name,
              c.payload #>> '{owner,email}' AS owner_email
         FROM break_glass_session b
         LEFT JOIN instance i ON i.id = b.instance_id
         LEFT JOIN catalog_entry c ON c.key = i.entry_key
        WHERE (b.state = 'active' AND b.grant_notified_at IS NULL AND b.granted_at IS NOT NULL)
           OR (b.state = 'expired' AND b.expiry_notified_at IS NULL)`,
    );
    for (const notice of notices.rows) {
      const granted = notice.state === 'active';
      const product = notice.product ?? 'the platform';
      const owner = notice.owner_name ?? 'Platform';
      const email = notice.owner_email ?? null;
      const subject = granted
        ? `Break-glass access granted on ${product} (${notice.id.slice(0, 8)})`
        : `Break-glass access expired on ${product} (${notice.id.slice(0, 8)})`;
      const addressee = `This notice is addressed to the domain owner, ${owner}${
        email === null ? ' (no mailbox recorded on the catalogue entry)' : ` (${email})`
      }.`;
      // The marker is the normal path; the dedupe window still matters when a previous pass sent the
      // notice but failed before writing the marker, so a restart cannot mail the owner twice.
      if (await this.recentlySent(subject)) {
        await this.markAnnounced(notice.id, granted);
        continue;
      }
      const outcome = await this.notify({
        severity: 'critical',
        subject,
        body: granted
          ? `${product} break-glass elevation ${notice.id} is active until ${notice.expires_at?.toISOString() ?? 'an unrecorded time'}. ${addressee}`
          : `${product} break-glass elevation ${notice.id} has expired and its product account was revoked. ${addressee}`,
        instanceId: notice.instance_id,
        recipient: { name: owner, email },
      });
      if (outcome.queued) sent += 1;
      else suppressed += 1;
      await this.markAnnounced(notice.id, granted);
    }

    return { sent, suppressed };
  }

  async flush(limit = 25): Promise<number> {
    const queued = await this.pool.query<{
      id: string;
      severity: string;
      subject: string;
      body: string;
      recipient_name: string | null;
      recipient_address: string | null;
    }>(
      `SELECT id, severity, subject, body, recipient_name, recipient_address FROM notification
        WHERE state = 'queued' ORDER BY created_at LIMIT $1`,
      [limit],
    );
    let delivered = 0;
    for (const row of queued.rows) {
      const ok = await this.deliver(
        row.id,
        {
          severity: row.severity as 'info' | 'warning' | 'critical',
          subject: row.subject,
          body: row.body,
        },
        // A retry must keep addressing the same party: the recipient is part of the stored notice,
        // not of the call that happened to create it.
        row.recipient_name == null
          ? undefined
          : { name: row.recipient_name, email: row.recipient_address },
      );
      if (ok) delivered += 1;
    }
    return delivered;
  }

  // ---------------------------------------------------------------------------------------------

  private async deliver(
    notificationId: string,
    message: { severity: 'info' | 'warning' | 'critical'; subject: string; body: string },
    recipient?: NoticeRecipient,
  ): Promise<boolean> {
    const channels = await this.pool.query<ChannelRow>(
      `SELECT id, type, target, enabled FROM alert_channel WHERE enabled = true ORDER BY type, target`,
    );
    const targets = this.addressedChannels(channels.rows, recipient);
    if (targets.length === 0) {
      // Recorded as failed rather than dropped: "no channel configured" is an operational fact.
      await this.pool.query(
        `UPDATE notification SET state = 'failed', suppression_reason = $2 WHERE id = $1`,
        [notificationId, 'no enabled alert channel'],
      );
      return false;
    }

    let delivered: string | null = null;
    for (const channel of targets) {
      const result = await this.send(channel, message);
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

  /**
   * The channels one notice goes to.
   *
   * An addressed notice prefers the enabled email channel whose target is the owner's mailbox. When
   * the catalogue records no address, or no channel points at it, the notice still goes to every
   * enabled channel — the requirement is that the owner is told, and a silent drop because the
   * operator never created an owner-specific channel would be the worse failure. The fallback is
   * logged, and the row still records the named owner, so "was the owner told?" has an answer.
   */
  private addressedChannels(channels: ChannelRow[], recipient?: NoticeRecipient): ChannelRow[] {
    const email = recipient?.email?.trim().toLowerCase();
    if (email === undefined || email.length === 0) return channels;
    const addressed = channels.filter(
      (channel) => channel.type === 'email' && channel.target.trim().toLowerCase() === email,
    );
    if (addressed.length > 0) return addressed;
    this.logger.warn(
      { recipient: recipient?.name, address: email },
      'no alert channel targets the domain owner; delivering through every enabled channel',
    );
    return channels;
  }

  /**
   * FR-4.11 — "announced once" as data.
   *
   * The update is conditional so a concurrent pass cannot overwrite the first timestamp, and it is
   * written even when the notice was suppressed: a window means "held", not "never happened".
   */
  private async markAnnounced(sessionId: string, granted: boolean): Promise<void> {
    await this.pool.query(
      granted
        ? `UPDATE break_glass_session SET grant_notified_at = now()
            WHERE id = $1 AND grant_notified_at IS NULL`
        : `UPDATE break_glass_session SET expiry_notified_at = now()
            WHERE id = $1 AND expiry_notified_at IS NULL`,
      [sessionId],
    );
  }

  /** FR-4.5 thresholds, with the same defaults the migration seeds. */
  private async capacityThresholds(): Promise<typeof DEFAULT_THRESHOLDS> {
    const result = await this.pool.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM settings
        WHERE key IN (
          'capacity_cpu_alert_percent',
          'capacity_memory_alert_percent',
          'capacity_disk_alert_percent'
        )`,
    );
    const read = new Map(result.rows.map((row) => [row.key, row.value]));
    const number = (key: string, fallback: number): number => {
      const raw = read.get(key);
      const parsed = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
      cpuPercent: number('capacity_cpu_alert_percent', DEFAULT_THRESHOLDS.cpuPercent),
      memoryPercent: number('capacity_memory_alert_percent', DEFAULT_THRESHOLDS.memoryPercent),
      diskPercent: number('capacity_disk_alert_percent', DEFAULT_THRESHOLDS.diskPercent),
    };
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
