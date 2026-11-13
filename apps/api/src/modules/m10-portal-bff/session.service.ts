import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PlatformRole, ResidualSession } from '@seamnex/domain';
import type { Pool } from 'pg';
import { Repository } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import {
  ACCESS_CONTROL_SERVICE,
  type AccessControlService,
} from '../m09-access-control/access-control.contract';
import { SIGN_IN_RELAY, type SignInRelay } from '../m24-sign-in-relay/relay.contract';
import type { SessionCreateInput, SessionRecord, SessionService } from './session.contract';
import { SessionStore } from './session.store';

/** Refresh `last_seen` at most this often, so a read path costs one Redis GET in the common case. */
const TOUCH_INTERVAL_MS = 60_000;
/** `settings` is read at most once a minute; the values change on an administrative timescale. */
const SETTINGS_TTL_MS = 60_000;
/** Idle enforcement may overrun by this much because of the touch interval; documented in the ADR. */
const FALLBACK_IDLE_MINUTES = 30;
const FALLBACK_ABSOLUTE_HOURS = 12;

/**
 * Opaque, server-side sessions (deliverable 3.2).
 *
 * The cookie carries 256 bits of randomness and nothing else. Idle and absolute lifetimes come
 * from `settings` (not from the request), the absolute deadline is stored in the record so a Redis
 * TTL cannot silently extend it, and every terminal action is audited.
 */
@Injectable()
export class RedisSessionService extends Repository implements SessionService {
  private readonly logger = new Logger('session');
  private settingsCache: { idleMinutes: number; absoluteHours: number; at: number } | undefined;

  constructor(
    @Inject(PG_POOL) pool: Pool,
    // Explicit token: the runtime emits no `design:paramtypes` (ADR-BE-17).
    @Inject(SessionStore) private readonly store: SessionStore,
    @Inject(ACCESS_CONTROL_SERVICE) private readonly access: AccessControlService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    /*
     * ADR-BE-22: optional on purpose. Signing out of the platform must drop the cached product
     * sessions, but the session store must not depend on the relay being deployed — a deployment
     * without the relay constructs this service with four arguments and behaves as before.
     */
    @Optional() @Inject(SIGN_IN_RELAY) private readonly relay?: SignInRelay,
  ) {
    super(pool);
  }

  async create(input: SessionCreateInput): Promise<SessionRecord> {
    const [idleMinutes, absoluteHours] = await Promise.all([
      this.idleMinutes(),
      this.absoluteHours(),
    ]);
    const now = Date.now();
    const record: SessionRecord = {
      sid: newSessionId(),
      sub: input.sub,
      username: input.username,
      displayName: input.displayName,
      email: input.email,
      groups: [...input.groups],
      roles: [...input.roles] as PlatformRole[],
      mfaSatisfied: input.mfaSatisfied,
      mfaMethod: input.mfaMethod,
      mfaAsserted: input.mfaAsserted,
      csrfToken: randomBytes(32).toString('base64url'),
      instanceId: input.instanceId,
      createdAt: now,
      lastSeen: now,
      absoluteExpiresAt: now + absoluteHours * 3_600_000,
    };

    await this.store.save(record, idleMinutes * 60);
    // Fail closed: if the audit row cannot be written the session must not be handed out, otherwise
    // a sign-in could be invisible to the audit trail.
    await this.audit.append({
      action: 'auth.session.created',
      actorType: 'user',
      actorId: record.sub,
      targetType: 'session',
      targetId: record.sid,
      outcome: 'success',
      detail: {
        mfaSatisfied: record.mfaSatisfied,
        mfaAsserted: record.mfaAsserted === true,
        roles: record.roles,
      },
    });
    return record;
  }

  async read(sid: string): Promise<SessionRecord | null> {
    const record = await this.store.get(sid);
    if (record === null) return null;

    if (record.absoluteExpiresAt <= Date.now()) {
      await this.store.delete(record.sid, record.sub);
      this.logger.log({ msg: 'session reached its absolute lifetime', sub: record.sub });
      return null;
    }

    const now = Date.now();
    if (now - record.lastSeen >= TOUCH_INTERVAL_MS) {
      const touched: SessionRecord = { ...record, lastSeen: now };
      const idleMinutes = await this.idleMinutes();
      await this.store.touch(touched, idleMinutes * 60);
      return touched;
    }
    return record;
  }

  async kill(sid: string, reason: string): Promise<void> {
    const record = await this.store.get(sid);
    await this.store.delete(sid, record?.sub);
    if (record != null) await this.dropRelayedSessions(record.sub);
    await this.audit
      .append({
        action: 'auth.session.revoked',
        actorType: record === null ? 'system' : 'user',
        actorId: record?.sub ?? 'unknown',
        targetType: 'session',
        targetId: sid,
        outcome: 'success',
        detail: { reason },
      })
      // A user who asked to sign out must not be kept signed in because the audit log is down.
      .catch((error: unknown) => {
        this.logger.error({
          msg: 'session revoked but the audit row could not be written',
          sid,
          err: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async killSubject(sub: string, reason: string): Promise<number> {
    const ids = await this.store.subjectSessionIds(sub);
    for (const sid of ids) await this.store.delete(sid, sub);
    await this.store.clearSubject(sub);
    await this.dropRelayedSessions(sub);

    if (ids.length > 0) {
      await this.audit
        .append({
          action: 'auth.session.revoked',
          actorType: 'system',
          actorId: sub,
          targetType: 'subject',
          targetId: sub,
          outcome: 'success',
          detail: { reason, sessions: ids.length },
        })
        .catch((error: unknown) => {
          this.logger.error({
            msg: 'subject sessions revoked but the audit row could not be written',
            sub,
            err: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return ids.length;
  }

  /**
   * ADR-BE-22 — a cached product session must not outlive the platform session that justified it.
   *
   * Best effort: a Redis failure here cannot keep the user signed in (the platform session is
   * already gone), and the product's own session lifetime is the backstop. The failure is logged, not
   * propagated — a sign-out that errors is worse than one that leaves a cookie to expire.
   */
  private async dropRelayedSessions(sub: string): Promise<void> {
    if (this.relay === undefined) return;
    await this.relay.invalidate({ subjectIdpId: sub }).catch((error: unknown) => {
      this.logger.warn({
        msg: 'signed out but the cached product sessions could not be dropped',
        sub,
        err: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * FR-3.8 / NB-4 — what the sign-out screen may say about product sessions.
   *
   * Two corrections, both from reading the panel after a real sign-out. It listed "EspoCRM — up to
   * 8 h remaining" while no EspoCRM session could exist: the number is a static
   * `integration_metadata.session_max_minutes`, not an inventory, and the product's sign-in could
   * not complete at all. So a product whose identity client is registered but whose latest
   * end-to-end check failed is not listed — there is no session to end, and telling the user to
   * "end it in the product" sends them into a login that cannot succeed. Everything else keeps its
   * verified lifetime and now carries the verification date, so the estimate reads as an estimate.
   */
  async residualSessions(sub: string): Promise<ResidualSession[]> {
    const rows = await this.many<{
      instance_id: string;
      product: string;
      session_max_minutes: number | null;
      slo_supported: boolean | null;
      verified_at: Date | null;
      idp_client_id: string | null;
      sso_ok: boolean | null;
    }>(
      `SELECT DISTINCT ON (i.id) i.id AS instance_id, c.product,
              m.session_max_minutes, m.slo_supported, m.verified_at,
              ic.client_id AS idp_client_id, sso.ok AS sso_ok
         FROM entitlement e
         JOIN instance i ON i.id = e.instance_id AND i.deleted_at IS NULL
         JOIN catalog_entry c ON c.key = i.entry_key
         LEFT JOIN integration_metadata m ON m.instance_id = i.id
         LEFT JOIN idp_client ic ON ic.instance_id = i.id
         LEFT JOIN LATERAL (
           SELECT ic2.ok FROM integration_check ic2
            WHERE ic2.instance_id = i.id AND ic2.check_type = 'sso_login'
            ORDER BY ic2.checked_at DESC LIMIT 1
         ) sso ON true
        WHERE e.subject_idp_id = $1
        ORDER BY i.id, c.product`,
      [sub],
    );

    return rows
      .filter((row) => !(row.idp_client_id !== null && row.sso_ok === false))
      .map((row) => {
        const verified = row.verified_at !== null;
        return {
          instanceId: row.instance_id,
          product: row.product,
          maxRemainingMinutes: verified ? row.session_max_minutes : null,
          singleLogout: verified && row.slo_supported === true,
          verifiedAt: row.verified_at?.toISOString() ?? null,
        };
      });
  }

  async idleSeconds(): Promise<number> {
    return (await this.idleMinutes()) * 60;
  }

  async absoluteSeconds(): Promise<number> {
    return (await this.absoluteHours()) * 3_600;
  }

  private async idleMinutes(): Promise<number> {
    return (await this.settings()).idleMinutes;
  }

  private async absoluteHours(): Promise<number> {
    return (await this.settings()).absoluteHours;
  }

  private async settings(): Promise<{ idleMinutes: number; absoluteHours: number }> {
    if (this.settingsCache !== undefined && Date.now() - this.settingsCache.at < SETTINGS_TTL_MS) {
      return this.settingsCache;
    }
    try {
      const { settings } = await this.access.settings();
      this.settingsCache = {
        idleMinutes: settings.sessionIdleMinutes,
        absoluteHours: settings.sessionAbsoluteHours,
        at: Date.now(),
      };
    } catch (error) {
      this.logger.warn(
        `settings unavailable; using the documented session defaults (${String(error)})`,
      );
      this.settingsCache = {
        idleMinutes: FALLBACK_IDLE_MINUTES,
        absoluteHours: FALLBACK_ABSOLUTE_HOURS,
        at: Date.now(),
      };
    }
    return this.settingsCache;
  }
}

function newSessionId(): string {
  // 256 bits, URL-safe: guessing one is not a search problem anyone wins.
  return randomBytes(32).toString('base64url');
}
