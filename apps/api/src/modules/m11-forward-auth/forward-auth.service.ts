import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { launchTicketKey, type LaunchTicketPayload } from '../../common/launch/bootstrap';
import { REDIS } from '../../redis/redis.module';
import { SESSION_READER, type SessionReader } from '../m10-portal-bff/session.contract';
import type { ForwardAuthService } from './forward-auth.contract';

const CACHE_TTL_SECONDS = 60;

/** Platform-owned surfaces authenticate themselves and never reach a product router. */
const STATIC_PREFIXES = [
  '/api/',
  '/healthz',
  '/readyz',
  '/metrics',
  '/sign-in',
  '/assets/',
] as const;

type Decision = { allow: boolean; headers: Record<string, string>; reason: string };

/**
 * 4D.4 - the forward-auth decision.
 *
 * Hot-path discipline (design §6.2, §13.3): one Redis read for the session, at most two PostgreSQL
 * reads to resolve the route and the entitlement, then a 60 s cache. Nothing here calls Docker.
 *
 * This service only ever *emits* `X-Platform-*`; Traefik is configured with
 * `trustForwardHeader: false`, so a client that sets the header cannot forge a decision.
 */
@Injectable()
export class CachedForwardAuthService implements ForwardAuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(SESSION_READER) private readonly sessions: SessionReader,
  ) {}

  async decide(input: { host: string; path: string; sessionId: string | null }): Promise<Decision> {
    // Traefik forwards the client's Host verbatim, and a product that answers with an absolute
    // redirect keeps the dev port on it (`shop.localhost:8020`). `instance_route.host` stores the
    // bare name, so an un-normalised host matched no route and a signed-in user was refused with
    // "host is not routed by the platform".
    const host = bareHost(input.host);
    if (STATIC_PREFIXES.some((prefix) => input.path.startsWith(prefix))) {
      return allow({}, 'static prefix');
    }

    const cacheKey = `seamnex:fa:${host}:${input.sessionId ?? 'anonymous'}:${input.path.split('/')[1] ?? ''}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached !== null) {
      const decision = JSON.parse(cached) as Decision;
      /*
       * Only the route and the entitlement are cached, never the session. A cached `allow` meant a
       * disabled account, a signed-out session or a lapsed absolute deadline kept reaching the
       * product for up to the cache lifetime — the one place where a 60 s cache becomes a security
       * window rather than a performance detail. Re-reading the session costs one Redis GET and
       * makes revocation take effect on the next request.
       */
      if (!decision.allow) return decision;
      return (await this.sessions.get(input.sessionId ?? '').catch(() => null)) === null
        ? deny('session not found or expired')
        : decision;
    }

    const decision = await this.evaluate({ ...input, host });
    await this.redis
      .set(cacheKey, JSON.stringify(decision), 'EX', CACHE_TTL_SECONDS)
      .catch(() => undefined);
    return decision;
  }

  /**
   * Single use is the whole point: `GETDEL` makes the redemption atomic, so two tabs racing on the
   * same ticket cannot both win. The host check is what stops a ticket minted for one product from
   * planting that session on another route.
   */
  async redeem(input: { ticket: string; host: string }): Promise<{
    readonly sessionId: string;
    readonly instanceId: string;
    readonly subjectIdpId: string;
  } | null> {
    if (input.ticket.length === 0 || input.ticket.length > 128) return null;
    const raw = await this.redis.getdel(launchTicketKey(input.ticket)).catch(() => null);
    if (raw === null) return null;

    let payload: LaunchTicketPayload;
    try {
      payload = JSON.parse(raw) as LaunchTicketPayload;
    } catch {
      return null;
    }

    const route = await this.pool.query<{ instance_id: string }>(
      `SELECT instance_id FROM instance_route WHERE lower(host) = lower($1)`,
      [bareHost(input.host)],
    );
    if (route.rows[0]?.instance_id !== payload.instanceId) return null;
    // A ticket for an expired session would set a cookie the next request throws away.
    const session = await this.sessions.get(payload.sessionId).catch(() => null);
    if (session === null) return null;
    if (session.absoluteExpiresAt <= Date.now()) return null;
    return {
      sessionId: payload.sessionId,
      instanceId: payload.instanceId,
      subjectIdpId: session.sub,
    };
  }

  /** Explicit invalidation for entitlement, session and gate changes. */
  async invalidate(host?: string): Promise<void> {
    const pattern = host === undefined ? 'seamnex:fa:*' : `seamnex:fa:${bareHost(host)}:*`;
    const keys = await this.redis.keys(pattern).catch(() => [] as string[]);
    if (keys.length > 0) await this.redis.del(...keys).catch(() => undefined);
  }

  private async evaluate(input: {
    host: string;
    path: string;
    sessionId: string | null;
  }): Promise<Decision> {
    if (input.sessionId === null) return deny('no session');

    const session = await this.sessions.get(input.sessionId).catch(() => null);
    if (session === null) return deny('session not found or expired');
    // The key TTL is the *idle* lifetime, so a session that keeps being used outlives its own hard
    // deadline in Redis. The absolute deadline is part of the record and has to be enforced here
    // too, or a product route accepts a session the API has already refused.
    if (session.absoluteExpiresAt <= Date.now())
      return deny('session reached its absolute lifetime');

    const route = await this.pool.query<{
      instance_id: string;
      gated: boolean;
      published: boolean;
      auth_mode: string;
    }>(
      `SELECT instance_id, gated, published, auth_mode FROM instance_route WHERE lower(host) = lower($1)`,
      [input.host],
    );
    const row = route.rows[0];
    if (row === undefined) return deny('host is not routed by the platform');
    if (row.gated || !row.published) return deny('the restore gate holds product routes');

    /*
     * Two columns this query used to name do not exist, and the failure mode was the worst one
     * available: `revoked_at` is not part of `entitlement` (revocation deletes the row), so every
     * authenticated request threw `42703`, Traefik surfaced it as `500`, and a gated product looked
     * like a platform outage rather than a refusal. The row's existence *is* the entitlement.
     *
     * The groups came from `idp_group.member_sub`, a column the group mirror has never carried —
     * membership is resolved by the identity sync into the session. Emitting it from the session is
     * both correct and cheaper: one fewer query on the hot path, which is the discipline §13.3 asks
     * for.
     */
    const entitled = await this.pool.query(
      `SELECT 1 FROM entitlement WHERE subject_idp_id = $1 AND instance_id = $2`,
      [session.sub, row.instance_id],
    );
    if (entitled.rowCount === 0) return deny('no entitlement for this product');

    return allow(
      {
        'X-Platform-User': session.sub,
        'X-Platform-Groups': session.groups.join(','),
        'X-Platform-Instance': row.instance_id,
      },
      `entitled session (${row.auth_mode})`,
    );
  }
}

/**
 * Lower-cases the host and drops a port. Route hosts are names, never IP literals, so a trailing
 * `:port` is the only shape that has to be tolerated — including the bracketed IPv6 form.
 */
function bareHost(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.replace(/:\d+$/, '');
}

function allow(headers: Record<string, string>, reason: string): Decision {
  return { allow: true, headers, reason };
}

function deny(reason: string): Decision {
  return { allow: false, headers: {}, reason };
}
