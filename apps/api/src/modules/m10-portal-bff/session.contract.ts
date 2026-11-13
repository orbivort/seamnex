import type { PlatformRole, ResidualSession } from '@seamnex/domain';

export const SESSION_SERVICE = Symbol('seamnex.m10.session');

/**
 * The raw record read, without the lifetime bookkeeping `SessionService.read` performs.
 *
 * M11 decides access on the forward-auth hot path (design §13.3): one Redis GET per request and
 * nothing else. Routing it through `SessionService.read` would also touch `lastSeen` and re-read
 * `settings`, turning a read-only decision into a write on every product request. The token exists
 * so M11 depends on M10's interface instead of importing `session.store` — which was a boundary
 * violation, not an optimisation.
 */
export const SESSION_READER = Symbol('seamnex.m10.session-reader');

export interface SessionReader {
  get(sid: string): Promise<SessionRecord | null>;
}

/**
 * The server-side session record. Every field the PDP or the profile needs is resolved from
 * storage; nothing about identity is read from the cookie, which only carries an opaque id.
 */
export type SessionRecord = {
  readonly sid: string;
  readonly sub: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly groups: readonly string[];
  readonly roles: readonly PlatformRole[];
  readonly mfaSatisfied: boolean;
  readonly mfaMethod: 'totp' | 'webauthn' | 'none';
  /** Whether the provider stated how the user authenticated (ADR-BE-14). Absent on old records. */
  readonly mfaAsserted?: boolean;
  /** Bound to the session and mirrored into the readable `seamnex_csrf` cookie. */
  readonly csrfToken: string;
  /** R6 single-surface scope; null for every other role. */
  readonly instanceId: string | null;
  readonly createdAt: number;
  readonly lastSeen: number;
  readonly absoluteExpiresAt: number;
};

export type SessionCreateInput = {
  readonly sub: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly groups: readonly string[];
  readonly roles: readonly PlatformRole[];
  readonly mfaSatisfied: boolean;
  readonly mfaMethod: 'totp' | 'webauthn' | 'none';
  readonly mfaAsserted: boolean;
  readonly instanceId: string | null;
};

/**
 * M10 owns the Redis session (design §7.2). The interface deliberately exposes the lifetime in
 * seconds so the route layer can set the cookie without querying `settings` a second time.
 */
export interface SessionService {
  create(input: SessionCreateInput): Promise<SessionRecord>;
  /** Returns null for a missing or expired session; a present cookie with null means `SESSION_EXPIRED`. */
  read(sid: string): Promise<SessionRecord | null>;
  kill(sid: string, reason: string): Promise<void>;
  /** Terminates every session for a subject; used when a user is disabled (AC-12). */
  killSubject(sub: string, reason: string): Promise<number>;
  /** FR-3.8: only verified `integration_metadata` contributes; otherwise `maxRemainingMinutes` is null. */
  residualSessions(sub: string): Promise<ResidualSession[]>;
  /** Idle lifetime in seconds, from `settings` with a 60 s cache. */
  idleSeconds(): Promise<number>;
  /** Absolute lifetime in seconds, from `settings` with a 60 s cache. */
  absoluteSeconds(): Promise<number>;
}
