import { describe, expect, it } from 'vitest';
import type { AuthSession } from '@seamnex/domain';
import { safeNextPath, sessionRouting } from '@seamnex/api-client';

const STUB_AUTH = {
  provider: 'stub',
  authorizeUrl: null,
  endSessionUrl: null,
  clientId: null,
  scope: null,
  redirectPath: '/sign-in',
} as const;

const anonymous: AuthSession = {
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
  auth: STUB_AUTH,
};

const signedIn: AuthSession = {
  ...anonymous,
  authenticated: true,
  subject: { idpId: 'stub:dev-owner', username: 'dev-owner', displayName: 'Dev Owner' },
  roles: ['R3'],
  groups: ['seamnex-domain-owners'],
  mfaSatisfied: false,
  csrfToken: 'csrf-1',
  createdAt: '2026-10-24T09:00:00.000Z',
  expiresAt: '2026-10-24T17:00:00.000Z',
  idleExpiresAt: '2026-10-24T09:30:00.000Z',
};

/**
 * The boot path against the real API. Both apps share this rule, and the console's prototype
 * default role is `R1`, so a missing redirect would render administrator chrome to a member.
 */
describe('live session routing', () => {
  it('sends an unauthenticated visit to the sign-in page with a return path', () => {
    const routing = sessionRouting(anonymous, { pathname: '/instances', search: '?state=ready' });

    expect(routing).toEqual({
      kind: 'redirect',
      url: '/sign-in?next=%2Finstances%3Fstate%3Dready',
      reason: 'unauthenticated',
    });
  });

  it('lets the sign-in page render when there is no session yet', () => {
    expect(sessionRouting(anonymous, { pathname: '/sign-in', search: '' })).toEqual({
      kind: 'continue',
      role: null,
    });
  });

  it('takes the asserted role over any client hint', () => {
    expect(sessionRouting(signedIn, { pathname: '/catalog', search: '?role=R1' })).toEqual({
      kind: 'continue',
      role: 'R3',
    });
  });

  it('leaves the sign-in page once a session exists', () => {
    expect(sessionRouting(signedIn, { pathname: '/sign-in', search: '?next=%2Fcatalog' })).toEqual({
      kind: 'redirect',
      url: '/catalog',
      reason: 'already-signed-in',
    });
  });

  it('refuses a return destination that leaves the origin', () => {
    expect(
      sessionRouting(signedIn, { pathname: '/sign-in', search: '?next=https%3A%2F%2Fevil.test' }),
    ).toEqual({
      kind: 'redirect',
      url: '/',
      reason: 'already-signed-in',
    });
    expect(safeNextPath('//evil.test')).toBe('/');
    expect(safeNextPath('/sign-in?next=%2Fx')).toBe('/');
  });
});
