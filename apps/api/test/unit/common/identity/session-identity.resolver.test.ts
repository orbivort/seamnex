import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../../../src/config/config';
import { SessionIdentityResolver } from '../../../../src/common/identity/session-identity.resolver';
import type { SessionRecord } from '../../../../src/modules/m10-portal-bff/session.contract';
import { AppError } from '../../../../src/common/problem/app-error';

const CONFIG = {
  SEAMNEX_ROLE: 'api',
  SESSION_COOKIE_NAME: 'seamnex_session',
} as unknown as AppConfig;

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: 'sid-1',
    sub: 'sub-1',
    username: 'alice',
    displayName: 'Alice',
    email: 'alice@example.test',
    groups: ['operators'],
    roles: ['R4'],
    mfaSatisfied: true,
    mfaMethod: 'totp',
    mfaAsserted: true,
    csrfToken: 'csrf',
    instanceId: null,
    createdAt: Date.now(),
    lastSeen: 1_700_000_000_000,
    absoluteExpiresAt: 1_700_003_600_000,
    ...overrides,
  };
}

let s: ReturnType<typeof services>;
let resolver: SessionIdentityResolver;

function services() {
  return {
    sessions: {
      read: vi.fn().mockResolvedValue(null),
      idleSeconds: vi.fn().mockResolvedValue(1_800),
    },
    machines: { authenticate: vi.fn().mockResolvedValue(null) },
  };
}

beforeEach(() => {
  s = services();
  resolver = new SessionIdentityResolver(CONFIG, s.sessions as never, s.machines as never);
});

function request(headers: Record<string, unknown> = {}, requestId?: string): FastifyRequest {
  return {
    headers,
    ...(requestId === undefined ? {} : { requestId }),
  } as unknown as FastifyRequest;
}

async function refuses(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the resolver to refuse');
}

describe('machine client precedence', () => {
  it('resolves a valid bearer token as a service actor, before any cookie', async () => {
    s.machines.authenticate.mockResolvedValue({
      id: 'mc-1',
      name: 'n8n',
      scopes: ['jobs.read'],
    });

    const context = await resolver.resolve(
      request({ authorization: 'Bearer token-1', cookie: 'seamnex_session=sid-1' }, 'rid-1'),
      {},
    );

    expect(s.machines.authenticate).toHaveBeenCalledWith('token-1');
    expect(s.sessions.read).not.toHaveBeenCalled();
    expect(context).toMatchObject({
      requestId: 'rid-1',
      processRole: 'api',
      subject: { idpId: 'mc-1', username: 'n8n' },
      role: 'R6',
      actorType: 'service',
      scopes: ['jobs.read'],
      sessionId: null,
      csrfToken: null,
    });
  });

  it('refuses an unknown bearer token rather than falling back to the cookie', async () => {
    s.machines.authenticate.mockResolvedValue(null);
    const error = await refuses(resolver.resolve(request({ authorization: 'Bearer nope' }), {}));

    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.detail).toContain('not valid for any machine client');
    expect(s.sessions.read).not.toHaveBeenCalled();
  });

  it('ignores a scheme that is not Bearer', async () => {
    s.sessions.read.mockResolvedValue(record());

    const context = await resolver.resolve(
      request({ authorization: 'Basic dXNlcjpwYXNz', cookie: 'seamnex_session=sid-1' }),
      {},
    );

    expect(s.machines.authenticate).not.toHaveBeenCalled();
    expect(context.actorType).toBe('user');
  });

  it('ignores a Bearer header with no token', async () => {
    s.sessions.read.mockResolvedValue(record());
    await resolver.resolve(
      request({ authorization: 'Bearer   ', cookie: 'seamnex_session=sid-1' }),
      {},
    );
    expect(s.machines.authenticate).not.toHaveBeenCalled();
  });
});

describe('session cookie', () => {
  it('projects the stored session into a user context', async () => {
    s.sessions.read.mockResolvedValue(record({ roles: ['R4', 'R2'] }));

    const context = await resolver.resolve(
      request({ cookie: 'seamnex_session=sid-1' }, 'rid-2'),
      {},
    );

    expect(s.sessions.read).toHaveBeenCalledWith('sid-1');
    expect(s.sessions.idleSeconds).toHaveBeenCalledOnce();
    expect(context).toMatchObject({
      requestId: 'rid-2',
      subject: { idpId: 'sub-1', username: 'alice' },
      role: 'R2',
      actorType: 'user',
      sessionId: 'sid-1',
      mfaSatisfied: true,
      mfaMethod: 'totp',
      mfaAsserted: true,
      csrfToken: 'csrf',
      groups: ['operators'],
    });
    expect(context.sessionIdleExpiresAt).toBe(
      new Date(1_700_000_000_000 + 1_800_000).toISOString(),
    );
  });

  it('reads a record without mfaAsserted as "not asserted" rather than refusing later', async () => {
    s.sessions.read.mockResolvedValue(record());
    const stored = record() as { mfaAsserted?: boolean };
    delete stored.mfaAsserted;
    s.sessions.read.mockResolvedValue(stored);

    const context = await resolver.resolve(request({ cookie: 'seamnex_session=sid-1' }), {});
    expect(context.mfaAsserted).toBe(false);
  });

  it('falls back to the guest role when the record grants no known role', async () => {
    s.sessions.read.mockResolvedValue(record({ roles: [] }));
    const context = await resolver.resolve(request({ cookie: 'seamnex_session=sid-1' }), {});
    expect(context.role).toBe('R6');
  });

  it('answers SESSION_EXPIRED for a cookie that no longer resolves', async () => {
    s.sessions.read.mockResolvedValue(null);
    const error = await refuses(resolver.resolve(request({ cookie: 'seamnex_session=stale' }), {}));

    expect(error.code).toBe('SESSION_EXPIRED');
    expect(error.remediation).toContain('/sign-in');
  });

  it('treats a stale cookie as "not signed in" for an anonymous operation', async () => {
    s.sessions.read.mockResolvedValue(null);

    const context = await resolver.resolve(request({ cookie: 'seamnex_session=stale' }, 'rid-3'), {
      anonymous: true,
    });

    expect(context).toMatchObject({
      requestId: 'rid-3',
      actorType: 'anonymous',
      subject: { idpId: 'anonymous' },
      role: 'R6',
      sessionId: null,
    });
  });
});

describe('no credential', () => {
  it('answers an anonymous context for a declared anonymous operation', async () => {
    const context = await resolver.resolve(request(), { anonymous: true });
    expect(context.actorType).toBe('anonymous');
    expect(context.mfaSatisfied).toBe(false);
    expect(context.mfaAsserted).toBe(false);
  });

  it('refuses a non-anonymous operation', async () => {
    const error = await refuses(resolver.resolve(request(), {}));

    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.detail).toContain('requires an authenticated session');
  });

  it('uses the sentinel request id when Fastify did not mint one', async () => {
    const context = await resolver.resolve(request(), { anonymous: true });
    expect(context.requestId).toBe('unknown');
  });

  it('ignores an unrelated cookie', async () => {
    await expect(
      resolver.resolve(request({ cookie: 'other=1' }), { anonymous: true }),
    ).resolves.toMatchObject({ actorType: 'anonymous' });
    expect(s.sessions.read).not.toHaveBeenCalled();
  });
});
