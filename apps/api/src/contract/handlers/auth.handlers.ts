import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AuthSession, SignInRequest } from '@seamnex/domain';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import {
  clearSessionCookieHeaders,
  headerValue,
  sessionCookieHeaders,
} from '../../common/http/cookies';
import { assertAllowedOrigin } from '../../common/http/csrf';
import { createRateLimiter, subjectKey, type RateLimiter } from '../../common/http/rate-limit';
import { AppError, isAppError } from '../../common/problem/app-error';
import {
  IDENTITY_PROVIDER,
  type IdentityProvider,
} from '../../common/identity/identity-provider.contract';
import { AUDIT_SERVICE, type AuditService } from '../../modules/m17-audit/audit.contract';
import { REDIS } from '../../redis/redis.module';
import {
  SESSION_SERVICE,
  type SessionRecord,
  type SessionService,
} from '../../modules/m10-portal-bff/session.contract';
import type { OperationHandler, OperationInput, OperationResult } from '../operation-handler';
import type { OperationGroup } from '../operation-handlers';

/**
 * Per-identity attempt ceiling (ADR-BE-13).
 *
 * The contract's limiter is per client, which bounds one attacker and does nothing against a botnet
 * spread over a thousand addresses. Ten attempts per five minutes against one account is far above
 * what a person needs and far below what guessing a six-digit second factor requires. It is
 * deliberately higher than the per-client limit so a shared office NAT does not lock out a user by
 * itself; the two buckets bound different attacks.
 */
const SUBJECT_ATTEMPT_LIMIT = 10;
const SUBJECT_ATTEMPT_WINDOW_SECONDS = 300;

/**
 * Deliverable 3.2 — the session surface.
 *
 * `GET /auth/session` is anonymous and answers 200 with `authenticated: false` when there is no
 * session, so a cold start does not raise `seamnex:unauthorized`. `POST /auth/session` is the only way
 * a session comes into existence, the only operation with a declared rate limit, and the only one
 * that also carries a second, per-identity limiter. `POST /me/logout` ends the session and reports
 * the residual product sessions.
 */
@Injectable()
export class AuthHandlers implements OperationGroup {
  readonly tag = 'auth';
  private readonly logger = new Logger('auth.handlers');
  private readonly attempts: RateLimiter;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(REDIS) redis: Redis,
  ) {
    // Fail closed: if this limiter cannot count, the attempt is refused rather than let through.
    this.attempts = createRateLimiter(
      redis,
      (error: unknown) => this.logger.error(`per-identity limiter unavailable (${String(error)})`),
      { failClosed: true },
    );
  }

  handlers(): ReadonlyMap<string, OperationHandler> {
    return new Map<string, OperationHandler>([
      ['GET /auth/session', async (input) => this.current(input)],
      ['POST /auth/session', async (input) => this.signIn(input)],
      ['POST /me/logout', async (input) => this.logout(input)],
    ]);
  }

  private async current(input: OperationInput): Promise<OperationResult> {
    if (input.context.actorType !== 'user' || input.context.sessionId === null) {
      return { kind: 'body', body: await this.body(null), status: 200 };
    }
    const record = await this.sessions.read(input.context.sessionId);
    return { kind: 'body', body: await this.body(record), status: 200 };
  }

  private async signIn(input: OperationInput): Promise<OperationResult> {
    // Login CSRF: a cross-site form must not sign a victim into an attacker's account. The origin
    // check runs before the code exchange so a rejected request never touches the provider.
    assertAllowedOrigin({
      origin: headerValue(input.headers, 'origin'),
      allowedOrigins: this.config.allowedOrigins,
      secFetchSite: headerValue(input.headers, 'sec-fetch-site'),
    });

    const request = input.body as SignInRequest;
    await this.throttleSubject(input, request.code);

    let claims;
    try {
      claims = await this.provider.exchangeCode({
        code: request.code,
        codeVerifier: request.codeVerifier,
        codeChallenge: request.codeChallenge,
        redirectUri: request.redirectUri,
        mfaCode: request.mfaCode,
      });
    } catch (error) {
      await this.auditSignInFailure(request.code, error);
      throw error;
    }

    // A new sign-in replaces whatever session the browser already carried. Without this a user who
    // signs in again — or a shared browser — keeps every previous session alive, and "sign out"
    // would leave the older one working for the rest of its idle window.
    const replaced = input.cookies[this.config.SESSION_COOKIE_NAME];
    if (replaced !== undefined) {
      await this.sessions.kill(replaced, 'replaced by a new sign-in');
    }

    const record = await this.sessions.create({
      sub: claims.sub,
      username: claims.username,
      displayName: claims.displayName,
      email: claims.email,
      groups: claims.groups,
      roles: claims.roles,
      mfaSatisfied: claims.mfaSatisfied,
      mfaMethod: claims.mfaMethod,
      mfaAsserted: claims.mfaAsserted,
      instanceId: claims.instanceId,
    });

    const idleSeconds = await this.sessions.idleSeconds();
    input.reply.header(
      'set-cookie',
      sessionCookieHeaders(this.config, {
        sid: record.sid,
        csrfToken: record.csrfToken,
        maxAgeSeconds: idleSeconds,
      }),
    );
    this.logger.log({ msg: 'session created', sub: record.sub, mfa: record.mfaSatisfied });
    return { kind: 'body', body: await this.body(record), status: 200 };
  }

  private async logout(input: OperationInput): Promise<OperationResult> {
    const sub = input.context.subject.idpId;
    // FR-3.8: the residual set comes from verified integration metadata, never from an estimate.
    const residualSessions = await this.sessions.residualSessions(sub);
    if (input.context.sessionId !== null) {
      await this.sessions.kill(input.context.sessionId, 'user signed out');
    }
    input.reply.header('set-cookie', clearSessionCookieHeaders(this.config));

    const unverified = residualSessions.filter(
      (session) => session.maxRemainingMinutes === null,
    ).length;
    const statement =
      residualSessions.length === 0
        ? 'Signed out. No product sessions remain.'
        : unverified > 0
          ? `Signed out. ${unverified} product session(s) have no verified lifetime; end them in the product.`
          : `Signed out. ${residualSessions.length} product session(s) expire within their verified lifetime.`;

    return {
      kind: 'body',
      body: { signedOutAt: new Date().toISOString(), residualSessions, statement },
      status: 200,
    };
  }

  /** The per-identity half of the sign-in throttle; the per-client half is declared in the contract. */
  private async throttleSubject(input: OperationInput, code: string): Promise<void> {
    const decision = await this.attempts.consume(
      'auth-subject',
      subjectKey(code),
      SUBJECT_ATTEMPT_LIMIT,
      SUBJECT_ATTEMPT_WINDOW_SECONDS,
    );
    if (decision.allowed) return;

    if (decision.degraded) {
      await this.auditUnavailable('the per-identity limiter could not be read');
      throw new AppError({
        code: 'UNAVAILABLE',
        detail: 'The sign-in attempt limiter cannot be reached, so no attempt is accepted.',
        remediation: 'Retry shortly. Readiness reports the failing dependency.',
      });
    }

    await this.audit
      .append({
        action: 'auth.signin.throttled',
        actorType: 'user',
        actorId: this.signInActor(code),
        targetType: 'session',
        targetId: 'none',
        outcome: 'denied',
        detail: { bucket: 'auth-subject', retryAfterSeconds: decision.retryAfterSeconds },
      })
      .catch((error: unknown) =>
        this.logger.error(`throttle refusal not audited (${String(error)})`),
      );

    // Same wire contract as the per-client limiter: `Retry-After` for a client that reads headers,
    // and the wait repeated in the detail for the browser that renders the problem document.
    input.reply.header('retry-after', String(decision.retryAfterSeconds));
    throw new AppError({
      code: 'RATE_LIMITED',
      detail: `Too many attempts for this account. Retry after ${decision.retryAfterSeconds} seconds.`,
    });
  }

  private async auditSignInFailure(code: string, error: unknown): Promise<void> {
    if (!isAppError(error)) return;
    const action =
      error.code === 'MFA_REQUIRED' || error.code === 'MFA_INVALID'
        ? 'auth.mfa.refused'
        : error.code === 'UNAUTHORIZED'
          ? 'auth.signin.failed'
          : null;
    if (action === null) return;

    // AC-46/ADR-BE-13: a refusal is evidence even though no session exists. A failure to record it
    // must not turn a refused sign-in into an accepted one, so the write is best-effort.
    await this.audit
      .append({
        action,
        actorType: 'user',
        actorId: this.signInActor(code),
        targetType: 'session',
        targetId: 'none',
        outcome: 'denied',
        detail: { code: error.code, provider: this.provider.name },
      })
      .catch((auditError: unknown) => {
        this.logger.error(`sign-in refusal could not be audited (${String(auditError)})`);
      });
  }

  private async auditUnavailable(reason: string): Promise<void> {
    await this.audit
      .append({
        action: 'auth.signin.failed',
        actorType: 'system',
        actorId: 'system',
        targetType: 'session',
        targetId: 'none',
        outcome: 'denied',
        detail: { code: 'UNAVAILABLE', reason },
      })
      .catch(() => undefined);
  }

  /**
   * The session payload, plus how to start one. `auth` is present in both shapes because the
   * sign-in screen renders *before* a session exists — it is the one field that must not be
   * conditional on being signed in.
   */
  private async body(record: SessionRecord | null): Promise<AuthSession> {
    const auth = await this.provider.authConfig();
    if (record === null) {
      return {
        authenticated: false,
        subject: null,
        roles: [],
        groups: [],
        mfaSatisfied: false,
        mfaMethod: 'none',
        csrfToken: null,
        createdAt: null,
        expiresAt: null,
        idleExpiresAt: null,
        auth,
      };
    }
    const idleSeconds = await this.sessions.idleSeconds();
    return {
      authenticated: true,
      subject: { idpId: record.sub, username: record.username, displayName: record.displayName },
      roles: [...record.roles],
      groups: [...record.groups],
      mfaSatisfied: record.mfaSatisfied,
      mfaMethod: record.mfaMethod,
      csrfToken: record.csrfToken,
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.absoluteExpiresAt).toISOString(),
      idleExpiresAt: new Date(record.lastSeen + idleSeconds * 1_000).toISOString(),
      auth,
    };
  }

  /**
   * The identity an audit row attributes a failed attempt to.
   *
   * Only the stub's documented `stub:<user>` shape is decoded. A live provider's code is opaque
   * credential material: parsing it would either fabricate an actor or copy a secret into the
   * audit trail, so a provider-mode refusal is attributed to `unknown` and the row's `provider`
   * detail says which authority refused.
   */
  private signInActor(code: string): string {
    if (this.provider.name !== 'stub' || !code.startsWith('stub:')) return 'unknown';
    return `stub:${code.slice('stub:'.length).trim()}`;
  }
}
