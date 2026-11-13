import { AsyncLocalStorage } from 'node:async_hooks';
import type { Capability, PlatformRole } from '@seamnex/domain';
import type { RoleId } from '../../config/config';
import { requestStore } from '../logging/logger';
import { AppError } from '../problem/app-error';

/**
 * ADR-BE-06 / ADR-BE-09 D8: the request-scoped identity.
 *
 * `RequestContext` is constructed in exactly one place — `IdentityResolver.resolve` — and then
 * propagated through an AsyncLocalStorage so a service three calls deep can attribute an audit
 * row without receiving the subject as a parameter. Phase 3 swapped the resolver behind this seam
 * and deleted the development header reader (ADR-BE-06).
 */
export type Subject = {
  readonly idpId: string;
  readonly username: string;
};

export type ActorType = 'user' | 'service' | 'system' | 'anonymous';

export type RequestContext = {
  readonly requestId: string;
  /** The process role that answered (`api`, `deploy-worker`, …), not the subject's role. */
  readonly processRole: RoleId;
  /** For an anonymous operation the synthetic subject is `anonymous`; handlers must not trust it. */
  readonly subject: Subject;
  /** The highest active platform role; the PDP evaluates the matrix for it. */
  readonly role: PlatformRole;
  readonly actorType: ActorType;
  /** Opaque server-side session id for a cookie-authenticated request, otherwise null. */
  readonly sessionId: string | null;
  /** R6 single-surface scope bound to the session; null for every other role. */
  readonly instanceId: string | null;
  /** Capabilities granted directly to a machine client; empty for a human session. */
  readonly scopes: readonly Capability[];
  readonly mfaSatisfied: boolean;
  readonly mfaMethod: 'totp' | 'webauthn' | 'none';
  /**
   * Whether the identity provider stated the authentication methods. A step-up gate may only
   * refuse on evidence: `false` means "the provider said nothing", not "no second factor".
   */
  readonly mfaAsserted: boolean;
  readonly sessionExpiresAt: string | null;
  /**
   * When the idle deadline falls if the session is not touched again. The route layer renews the
   * cookie with the remaining lifetime on every authenticated response, so a working user is not
   * signed out at the deadline that was computed when they signed in (ADR-BE-13).
   */
  readonly sessionIdleExpiresAt: string | null;
  /** Session-bound CSRF token used by the request guard; never logged. */
  readonly csrfToken: string | null;
  readonly groups: readonly string[];
};

export type ResolvedIdentity = Omit<RequestContext, 'requestId' | 'processRole'>;

const contextStore = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return contextStore.getStore();
}

/**
 * Used by handlers that cannot proceed without a subject. The dispatcher always resolves one
 * before calling a handler, so this throwing is a programming error rather than a user condition.
 */
export function requireContext(): RequestContext {
  const context = contextStore.getStore();
  if (context === undefined) {
    throw new AppError({
      code: 'UNAUTHORIZED',
      detail: 'The request has no resolved identity.',
      remediation: 'Sign in and retry.',
    });
  }
  return context;
}

/**
 * Runs `fn` with both stores bound: the identity store used by handlers and the logging store
 * used by every existing service. Keeping the logging store in step is what makes the request id
 * in an audit row and in a log line the same value.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestStore.run({ requestId: context.requestId, role: context.processRole }, () =>
    contextStore.run(context, fn),
  );
}

/** The four probe/document paths of ADR-BE-06; they never resolve an identity. */
export function isAnonymousPath(path: string): boolean {
  const withoutQuery = path.split('?')[0] ?? path;
  return ANONYMOUS_PATHS.has(withoutQuery);
}

const ANONYMOUS_PATHS = new Set([
  '/api/v1/healthz',
  '/api/v1/readyz',
  '/api/v1/metrics',
  '/api/v1/openapi.json',
  '/healthz',
  '/readyz',
  '/metrics',
  '/openapi.json',
]);
