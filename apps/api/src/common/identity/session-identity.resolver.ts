import { Inject, Injectable } from '@nestjs/common';
import { PLATFORM_ROLES, type PlatformRole } from '@seamnex/domain';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import {
  MACHINE_CLIENT_SERVICE,
  type MachineClientAuthenticator,
} from '../../modules/m09-access-control/access-control.contract';
import {
  SESSION_SERVICE,
  type SessionService,
} from '../../modules/m10-portal-bff/session.contract';
import { headerValue, parseCookies } from '../http/cookies';
import { AppError } from '../problem/app-error';
import type { IdentityResolver } from './identity.resolver';
import type { RequestContext } from './request-context';

/** Guest sessions are the least privileged; a machine client has no human role at all. */
const GUEST: PlatformRole = 'R6';

/**
 * Phase 3 identity resolver (ADR-BE-06 removal).
 *
 * Precedence: bearer token (machine client) → `seamnex_session` cookie → anonymous operation → 401.
 * Bearer first is deliberate: a service that also happens to hold a browser cookie must act as the
 * service, so its response cannot depend on ambient browser state.
 *
 * The cookie carries only an opaque id; every claim comes from the Redis record. A cookie that no
 * longer resolves answers `SESSION_EXPIRED`, which is distinguishable from "never signed in" and
 * lets the client redirect with the right message.
 */
@Injectable()
export class SessionIdentityResolver implements IdentityResolver {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(MACHINE_CLIENT_SERVICE) private readonly machines: MachineClientAuthenticator,
  ) {}

  async resolve(
    request: FastifyRequest & { requestId?: string },
    operation: { anonymous?: true },
  ): Promise<RequestContext> {
    const base = {
      requestId: request.requestId ?? 'unknown',
      processRole: this.config.SEAMNEX_ROLE,
    };

    const token = bearerToken(headerValue(request.headers, 'authorization'));
    if (token !== undefined) {
      const principal = await this.machines.authenticate(token);
      if (principal === null) {
        throw new AppError({
          code: 'UNAUTHORIZED',
          detail: 'The bearer token is not valid for any machine client.',
          remediation: 'Provision a client token or sign in as a user.',
        });
      }
      return {
        ...base,
        subject: { idpId: principal.id, username: principal.name },
        role: GUEST,
        actorType: 'service',
        sessionId: null,
        instanceId: null,
        scopes: principal.scopes,
        mfaSatisfied: false,
        mfaMethod: 'none',
        mfaAsserted: false,
        sessionExpiresAt: null,
        sessionIdleExpiresAt: null,
        csrfToken: null,
        groups: [],
      };
    }

    const cookies = parseCookies(headerValue(request.headers, 'cookie'));
    const sid = cookies[this.config.SESSION_COOKIE_NAME];
    if (sid !== undefined) {
      const session = await this.sessions.read(sid);
      if (session === null) {
        // An anonymous operation treats a stale cookie as "not signed in" so the sign-in probe
        // answers 200 `authenticated:false` instead of tripping `seamnex:unauthorized` on a cold start.
        // Every other operation keeps the distinguishable expiry answer.
        if (operation.anonymous === true) return this.anonymous(base);
        throw new AppError({
          code: 'SESSION_EXPIRED',
          detail: 'The session has ended through idle or absolute expiry, or was revoked.',
          remediation: 'Sign in again at /sign-in.',
        });
      }
      // The idle deadline, not the absolute one: the cookie is renewed against this value so an
      // active user never loses their session at the deadline computed when they signed in.
      const idleSeconds = await this.sessions.idleSeconds();
      return {
        ...base,
        subject: { idpId: session.sub, username: session.username },
        role: primaryRole(session.roles),
        actorType: 'user',
        sessionId: session.sid,
        instanceId: session.instanceId,
        scopes: [],
        mfaSatisfied: session.mfaSatisfied,
        mfaMethod: session.mfaMethod,
        // Records written before this field existed are read as "not asserted": the gate then
        // stays silent rather than refusing on a value it never stored.
        mfaAsserted: session.mfaAsserted === true,
        sessionExpiresAt: new Date(session.absoluteExpiresAt).toISOString(),
        sessionIdleExpiresAt: new Date(session.lastSeen + idleSeconds * 1_000).toISOString(),
        csrfToken: session.csrfToken,
        groups: session.groups,
      };
    }

    if (operation.anonymous === true) return this.anonymous(base);

    throw new AppError({
      code: 'UNAUTHORIZED',
      detail: 'This operation requires an authenticated session.',
      remediation: 'Sign in at /sign-in.',
    });
  }

  /**
   * No session is required, but the context must still exist: handlers receive one parameter and
   * the audit row needs an actor. `anonymous` can never satisfy a matrix capability.
   */
  private anonymous(base: {
    requestId: string;
    processRole: AppConfig['SEAMNEX_ROLE'];
  }): RequestContext {
    return {
      ...base,
      subject: { idpId: 'anonymous', username: 'anonymous' },
      role: GUEST,
      actorType: 'anonymous',
      sessionId: null,
      instanceId: null,
      scopes: [],
      mfaSatisfied: false,
      mfaMethod: 'none',
      mfaAsserted: false,
      sessionExpiresAt: null,
      sessionIdleExpiresAt: null,
      csrfToken: null,
      groups: [],
    };
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : undefined;
}

/** The most privileged role wins, using the declared order R1…R6. */
function primaryRole(roles: readonly PlatformRole[]): PlatformRole {
  for (const role of PLATFORM_ROLES) {
    if (roles.includes(role)) return role;
  }
  return GUEST;
}
