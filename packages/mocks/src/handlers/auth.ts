import { http, HttpResponse } from 'msw';
import type { AuthProviderConfig, AuthSession, PlatformRole } from '@seamnex/domain';
import { actorFor, roleOf } from './utils';

/**
 * Mock session surface so the demo transport keeps serving every declared operation.
 *
 * It mirrors the real shape (`GET /auth/session` answering `authenticated:false` without a
 * session, `POST` creating one) but the identity is the demo role rather than a real provider
 * exchange. The screens that read `/auth/session` behave identically against the API.
 */

const GROUPS: Record<PlatformRole, string[]> = {
  R1: ['/seamnex-admins'],
  R2: ['/seamnex-auditors'],
  R3: ['/seamnex-domain-owners', '/seamnex-domains/revenue-customer'],
  R4: ['/seamnex-product-admins', '/seamnex-instances/core-crm'],
  R5: ['/seamnex-users'],
  R6: ['/seamnex-guests', '/seamnex-instances/finance-suite'],
};

/** The demo transport has no identity provider, so it reports the stub and offers no redirect. */
const AUTH: AuthProviderConfig = {
  provider: 'stub',
  authorizeUrl: null,
  endSessionUrl: null,
  clientId: null,
  scope: null,
  redirectPath: '/sign-in',
};

function sessionFor(role: PlatformRole, authenticated: boolean): AuthSession {
  if (!authenticated) {
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
      auth: AUTH,
    };
  }

  const now = Date.now();
  const actor = actorFor(role);
  const mfa = role === 'R1' || role === 'R2';
  return {
    authenticated: true,
    subject: { idpId: actor.id, username: actor.id, displayName: actor.name },
    roles: [role],
    groups: GROUPS[role],
    mfaSatisfied: mfa,
    mfaMethod: mfa ? 'totp' : 'none',
    csrfToken: 'mock-csrf-token',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 12 * 3_600_000).toISOString(),
    idleExpiresAt: new Date(now + 30 * 60_000).toISOString(),
    auth: AUTH,
  };
}

export const authHandlers = [
  http.get('/api/v1/auth/session', ({ request }) => {
    // In the demo the role control *is* the session; there is no cookie to inspect.
    return HttpResponse.json(sessionFor(roleOf(request), true));
  }),

  http.post('/api/v1/auth/session', ({ request }) => {
    // The demo transport does not perform a PKCE exchange; the request shape is still validated
    // by the API client before it reaches this handler.
    return HttpResponse.json(sessionFor(roleOf(request), true));
  }),
];
