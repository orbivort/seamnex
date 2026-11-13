import type {
  AuthProviderConfig,
  AuthSession,
  LogoutResponse,
  ResidualSession,
} from '@seamnex/domain';

/**
 * The two provider shapes the API can describe, and the session envelopes the screens consume.
 *
 * They are values rather than builders of builders: every field is required by the contract, so a
 * literal is the shortest honest description of "what the server sent", and a test that cares about
 * one field overrides just that one.
 */
export const STUB_AUTH: AuthProviderConfig = {
  provider: 'stub',
  authorizeUrl: null,
  endSessionUrl: null,
  clientId: null,
  scope: null,
  redirectPath: '/sign-in',
};

export const OIDC_AUTH: AuthProviderConfig = {
  provider: 'oidc',
  authorizeUrl: 'https://idp.example.test/auth',
  endSessionUrl: 'https://idp.example.test/logout',
  clientId: 'seamnex-console',
  scope: 'openid profile email',
  redirectPath: '/sign-in',
};

/** A signed-out session, which still carries the provider config the sign-in screen renders. */
export function signedOutSession(auth: AuthProviderConfig = STUB_AUTH): AuthSession {
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

/** A signed-in session for `role`, under the given provider. */
export function signedInSession(
  role: AuthSession['roles'][number],
  auth: AuthProviderConfig = STUB_AUTH,
): AuthSession {
  return {
    authenticated: true,
    subject: { idpId: 'idp-1', username: 'dev-user', displayName: 'Dev User' },
    roles: [role],
    groups: ['platform'],
    mfaSatisfied: true,
    mfaMethod: 'totp',
    csrfToken: 'csrf-token',
    createdAt: '2026-01-01T09:00:00.000Z',
    expiresAt: '2026-01-01T17:00:00.000Z',
    idleExpiresAt: '2026-01-01T10:00:00.000Z',
    auth,
  };
}

export function residualSession(overrides: Partial<ResidualSession> = {}): ResidualSession {
  return {
    instanceId: 'inst-1',
    product: 'Core CRM',
    maxRemainingMinutes: 480,
    singleLogout: false,
    verifiedAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
  };
}

export function logoutResponse(overrides: Partial<LogoutResponse> = {}): LogoutResponse {
  return {
    signedOutAt: '2026-01-01T09:30:00.000Z',
    residualSessions: [],
    statement: 'Your platform session has ended.',
    ...overrides,
  };
}
