import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { AuthHandlers } from '../../../../src/contract/handlers/auth.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { AppError } from '../../../../src/common/problem/app-error';
import type { SessionRecord } from '../../../../src/modules/m10-portal-bff/session.contract';
import { fakeRedis } from '../../../support/fakes';
import { callHandler, operationInput, testContext } from '../../../support/operation-input';

const CONFIG = {
  allowedOrigins: ['https://portal.test'],
  SESSION_COOKIE_NAME: 'seamnex_session',
  CSRF_COOKIE_NAME: 'seamnex_csrf',
  SESSION_COOKIE_SECURE: true,
  SESSION_COOKIE_DOMAIN: undefined,
} as unknown as AppConfig;

const AUTH_CONFIG = {
  provider: 'stub',
  authorizeUrl: null,
  endSessionUrl: null,
  clientId: null,
  scope: null,
  redirectPath: '/auth/callback',
};

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: 'sid-1',
    sub: 'sub-1',
    username: 'alice',
    displayName: 'Alice',
    email: 'alice@example.test',
    groups: ['operators'],
    roles: ['R1'],
    mfaSatisfied: true,
    mfaMethod: 'totp',
    mfaAsserted: true,
    csrfToken: 'csrf-token',
    instanceId: null,
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    lastSeen: Date.parse('2026-01-01T00:10:00.000Z'),
    absoluteExpiresAt: Date.parse('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

const CLAIMS = {
  sub: 'sub-1',
  username: 'alice',
  displayName: 'Alice',
  email: 'alice@example.test',
  groups: ['operators'],
  roles: ['R1'],
  amr: ['pwd', 'otp'],
  mfaSatisfied: true,
  mfaMethod: 'totp',
  mfaAsserted: true,
  instanceId: null,
};

let s: ReturnType<typeof services>;
let handlers: ReadonlyMap<string, OperationHandler>;

function services() {
  return {
    sessions: {
      read: vi.fn().mockResolvedValue(record()),
      create: vi.fn().mockResolvedValue(record()),
      kill: vi.fn().mockResolvedValue(undefined),
      idleSeconds: vi.fn().mockResolvedValue(1_800),
      residualSessions: vi.fn().mockResolvedValue([]),
    },
    provider: {
      name: 'stub' as 'stub' | 'oidc',
      exchangeCode: vi.fn().mockResolvedValue(CLAIMS),
      authConfig: vi.fn().mockResolvedValue(AUTH_CONFIG),
    },
    audit: { append: vi.fn().mockResolvedValue({ seq: '1', hash: 'h' }) },
  };
}

beforeEach(() => {
  s = services();
  handlers = new AuthHandlers(
    CONFIG,
    s.sessions as never,
    s.provider as never,
    s.audit as never,
    fakeRedis({ count: 1, ttl: 60_000 }) as never,
  ).handlers();
});

const call = (key: string, overrides = {}) =>
  callHandler(handlers, key, operationInput(key, overrides));

describe('GET /auth/session', () => {
  it('answers authenticated:false for an anonymous caller without reading storage', async () => {
    const result = await call('GET /auth/session', {
      context: testContext({ actorType: 'anonymous', sessionId: null }),
    });

    expect(s.sessions.read).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: 'body',
      body: {
        authenticated: false,
        subject: null,
        roles: [],
        csrfToken: null,
        auth: AUTH_CONFIG,
      },
    });
  });

  it('answers authenticated:false for a user session that has expired', async () => {
    const result = await call('GET /auth/session', {
      context: testContext({ sessionId: null }),
    });
    expect(result).toMatchObject({ kind: 'body', body: { authenticated: false } });
  });

  it('projects the stored session for a signed-in user', async () => {
    const result = await call('GET /auth/session');

    expect(s.sessions.read).toHaveBeenCalledWith('sess-1');
    expect(result).toMatchObject({
      kind: 'body',
      body: {
        authenticated: true,
        subject: { idpId: 'sub-1', username: 'alice', displayName: 'Alice' },
        roles: ['R1'],
        groups: ['operators'],
        mfaSatisfied: true,
        csrfToken: 'csrf-token',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        idleExpiresAt: '2026-01-01T00:40:00.000Z',
      },
    });
  });
});

describe('POST /auth/session', () => {
  const body = {
    code: 'stub:alice',
    codeVerifier: 'verifier',
    codeChallenge: 'challenge',
    redirectUri: 'https://portal.test/auth/callback',
  };

  it('refuses a cross-site login before touching the provider', async () => {
    await expect(
      call('POST /auth/session', {
        body,
        headers: { origin: 'https://evil.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
      }),
    ).rejects.toMatchObject({ code: 'ORIGIN_REJECTED' });
    expect(s.provider.exchangeCode).not.toHaveBeenCalled();
  });

  it('creates a session, kills a replaced one and sets both cookies', async () => {
    const result = await call('POST /auth/session', {
      body,
      headers: { origin: 'https://portal.test' },
      cookies: { seamnex_session: 'old-sid' },
      context: testContext({ actorType: 'anonymous', sessionId: null }),
    });

    expect(s.sessions.kill).toHaveBeenCalledWith('old-sid', expect.stringContaining('replaced'));
    expect(s.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'sub-1', username: 'alice', mfaSatisfied: true }),
    );
    expect(s.sessions.idleSeconds).toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'body', body: { authenticated: true } });
  });

  it('does not kill a session when the browser carried no cookie', async () => {
    await call('POST /auth/session', {
      body,
      headers: { origin: 'https://portal.test' },
      context: testContext({ actorType: 'anonymous', sessionId: null }),
    });
    expect(s.sessions.kill).not.toHaveBeenCalled();
  });

  it('audits an UNAUTHORIZED refusal as a failed sign-in and rethrows it', async () => {
    const refusal = new AppError({ code: 'UNAUTHORIZED', detail: 'bad code' });
    s.provider.exchangeCode.mockRejectedValue(refusal);

    await expect(
      call('POST /auth/session', {
        body,
        headers: { origin: 'https://portal.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
      }),
    ).rejects.toBe(refusal);

    expect(s.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.signin.failed',
        outcome: 'denied',
        actorId: 'stub:alice',
      }),
    );
  });

  it.each(['MFA_REQUIRED', 'MFA_INVALID'])(
    'audits a %s refusal as an MFA refusal',
    async (code) => {
      s.provider.exchangeCode.mockRejectedValue(new AppError({ code, detail: 'second factor' }));

      await expect(
        call('POST /auth/session', {
          body,
          headers: { origin: 'https://portal.test' },
          context: testContext({ actorType: 'anonymous', sessionId: null }),
        }),
      ).rejects.toMatchObject({ code });

      expect(s.audit.append).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.mfa.refused' }),
      );
    },
  );

  it('does not audit a provider failure that is not a deliberate refusal', async () => {
    s.provider.exchangeCode.mockRejectedValue(new Error('socket closed'));

    await expect(
      call('POST /auth/session', {
        body,
        headers: { origin: 'https://portal.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
      }),
    ).rejects.toThrow('socket closed');

    expect(s.audit.append).not.toHaveBeenCalled();
  });

  it('does not audit a deliberate code that means something else', async () => {
    s.provider.exchangeCode.mockRejectedValue(
      new AppError({ code: 'UNAVAILABLE', detail: 'provider down' }),
    );

    await expect(
      call('POST /auth/session', {
        body,
        headers: { origin: 'https://portal.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    expect(s.audit.append).not.toHaveBeenCalled();
  });

  it('does not turn a refused sign-in into an accepted one when the audit write fails', async () => {
    const refusal = new AppError({ code: 'MFA_REQUIRED', detail: 'second factor' });
    s.provider.exchangeCode.mockRejectedValue(refusal);
    s.audit.append.mockRejectedValue(new Error('audit down'));

    await expect(
      call('POST /auth/session', {
        body,
        headers: { origin: 'https://portal.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
      }),
    ).rejects.toBe(refusal);
  });

  it('attributes a non-stub provider refusal to unknown rather than parsing the code', async () => {
    s.provider.name = 'oidc';
    s.provider.exchangeCode.mockRejectedValue(
      new AppError({ code: 'UNAUTHORIZED', detail: 'bad code' }),
    );

    await expect(
      call('POST /auth/session', {
        body: { ...body, code: 'stub:alice' },
        headers: { origin: 'https://portal.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(s.audit.append).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'unknown' }));
  });

  it('refuses the attempt once the per-identity limiter is exhausted, and audits it', async () => {
    handlers = new AuthHandlers(
      CONFIG,
      s.sessions as never,
      s.provider as never,
      s.audit as never,
      fakeRedis({ count: 50, ttl: 60_000 }) as never,
    ).handlers();
    const reply = operationInput('POST /auth/session').reply as unknown as {
      headers: Record<string, string>;
    };

    await expect(
      call('POST /auth/session', {
        body,
        headers: { origin: 'https://portal.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
        reply: reply as never,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    expect(reply.headers['retry-after']).toBeDefined();
    expect(s.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.signin.throttled' }),
    );
  });

  it('survives an audit failure on the throttle refusal', async () => {
    handlers = new AuthHandlers(
      CONFIG,
      s.sessions as never,
      s.provider as never,
      s.audit as never,
      fakeRedis({ count: 50, ttl: 60_000 }) as never,
    ).handlers();
    s.audit.append.mockRejectedValue(new Error('audit down'));

    await expect(
      call('POST /auth/session', {
        body,
        headers: { origin: 'https://portal.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('fails closed when the per-identity limiter cannot be read', async () => {
    handlers = new AuthHandlers(
      CONFIG,
      s.sessions as never,
      s.provider as never,
      s.audit as never,
      fakeRedis({ fail: new Error('redis down') }) as never,
    ).handlers();

    await expect(
      call('POST /auth/session', {
        body,
        headers: { origin: 'https://portal.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    expect(s.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.signin.failed', actorType: 'system' }),
    );
  });

  it('still refuses when the audit of an unavailable limiter fails', async () => {
    handlers = new AuthHandlers(
      CONFIG,
      s.sessions as never,
      s.provider as never,
      s.audit as never,
      fakeRedis({ fail: new Error('redis down') }) as never,
    ).handlers();
    s.audit.append.mockRejectedValue(new Error('audit down'));

    await expect(
      call('POST /auth/session', {
        body,
        headers: { origin: 'https://portal.test' },
        context: testContext({ actorType: 'anonymous', sessionId: null }),
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('POST /me/logout', () => {
  it('kills the session, clears both cookies and reports no residual sessions', async () => {
    const reply = operationInput('POST /me/logout').reply as unknown as {
      headers: Record<string, unknown>;
    };
    const result = await call('POST /me/logout', { reply: reply as never });

    expect(s.sessions.kill).toHaveBeenCalledWith('sess-1', expect.stringContaining('signed out'));
    expect(reply.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('Max-Age=0')]),
    );
    expect(result).toMatchObject({
      kind: 'body',
      body: { residualSessions: [], statement: expect.stringContaining('No product sessions') },
    });
  });

  it('does not kill a session that is already gone', async () => {
    await call('POST /me/logout', { context: testContext({ sessionId: null }) });
    expect(s.sessions.kill).not.toHaveBeenCalled();
  });

  it('names the residual sessions that have no verified lifetime', async () => {
    s.sessions.residualSessions.mockResolvedValue([
      { product: 'mail', maxRemainingMinutes: null },
      { product: 'chat', maxRemainingMinutes: 30 },
    ]);

    const result = await call('POST /me/logout');

    expect(result).toMatchObject({
      kind: 'body',
      body: {
        statement: expect.stringContaining('1 product session(s) have no verified lifetime'),
      },
    });
  });

  it('reports residual sessions that expire within their verified lifetime', async () => {
    s.sessions.residualSessions.mockResolvedValue([
      { product: 'mail', maxRemainingMinutes: 30 },
      { product: 'chat', maxRemainingMinutes: 60 },
    ]);

    const result = await call('POST /me/logout');

    expect(result).toMatchObject({
      kind: 'body',
      body: { statement: expect.stringContaining('2 product session(s) expire') },
    });
  });
});
