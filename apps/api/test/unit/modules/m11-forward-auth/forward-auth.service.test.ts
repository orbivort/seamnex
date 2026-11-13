import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { CachedForwardAuthService } from '../../../../src/modules/m11-forward-auth/forward-auth.service';

/**
 * The forward-auth decision is on every gated request, and its two dangerous properties are both
 * about caching: the decision is cached for 60 s, but the *session* never is (a cached allow would
 * keep a signed-out or disabled account reaching a product), and redemption of a launch ticket must
 * be atomic (two tabs racing on one ticket cannot both win). Both are asserted directly.
 */
function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) store.delete(key);
      return keys.length;
    }),
    keys: vi.fn(async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys()].filter((key) => key.startsWith(prefix));
    }),
  };
}

const SESSION = {
  sub: 'uuid-1',
  username: 'alice',
  groups: ['/core', '/ops'],
  absoluteExpiresAt: Date.now() + 60_000,
};

function setup(
  options: {
    routes?: Parameters<typeof fakeDb>[0];
    redis?: ReturnType<typeof fakeRedis>;
    sessions?: { get: (id: string) => Promise<unknown> };
  } = {},
) {
  const db = fakeDb(options.routes ?? []);
  const redis = options.redis ?? fakeRedis();
  const sessions = options.sessions ?? { get: vi.fn(async () => SESSION) };
  const service = new CachedForwardAuthService(db.pool, redis as never, sessions as never);
  return { db, redis, sessions, service };
}

const ROUTE = [{ instance_id: 'inst-1', gated: false, published: true, auth_mode: 'oidc' }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('decide: platform-owned surfaces', () => {
  it.each(['/api/v1/jobs', '/healthz', '/readyz', '/metrics', '/sign-in', '/assets/app.js'])(
    'allows %s without reading Redis or Postgres',
    async (path) => {
      const { redis, db, service } = setup();
      const decision = await service.decide({ host: 'shop.test', path, sessionId: null });

      expect(decision).toEqual({ allow: true, headers: {}, reason: 'static prefix' });
      expect(redis.get).not.toHaveBeenCalled();
      expect(db.calls).toEqual([]);
    },
  );
});

describe('decide: cache', () => {
  it('returns a cached allow only after re-reading the session', async () => {
    const redis = fakeRedis({
      'seamnex:fa:shop.test:sess-1:cart': JSON.stringify({
        allow: true,
        headers: { 'X-Platform-User': 'uuid-1' },
        reason: 'entitled session (oidc)',
      }),
    });
    const sessions = { get: vi.fn(async () => SESSION) };
    const { service, db } = setup({ redis, sessions });

    const decision = await service.decide({
      host: 'shop.test',
      path: '/cart/1',
      sessionId: 'sess-1',
    });

    expect(decision.allow).toBe(true);
    expect(sessions.get).toHaveBeenCalledWith('sess-1');
    // A live cache entry means no route or entitlement query.
    expect(db.calls).toEqual([]);
  });

  it('turns a cached allow into a refusal when the session is gone', async () => {
    const redis = fakeRedis({
      'seamnex:fa:shop.test:sess-1:cart': JSON.stringify({
        allow: true,
        headers: {},
        reason: 'old',
      }),
    });
    const { service } = setup({ redis, sessions: { get: vi.fn(async () => null) } });

    const decision = await service.decide({
      host: 'shop.test',
      path: '/cart/1',
      sessionId: 'sess-1',
    });

    expect(decision).toEqual({
      allow: false,
      headers: {},
      reason: 'session not found or expired',
    });
  });

  it('returns a cached refusal without consulting the session', async () => {
    const redis = fakeRedis({
      'seamnex:fa:shop.test:sess-1:cart': JSON.stringify({
        allow: false,
        headers: {},
        reason: 'no entitlement for this product',
      }),
    });
    const sessions = { get: vi.fn(async () => SESSION) };
    const { service } = setup({ redis, sessions });

    const decision = await service.decide({
      host: 'shop.test',
      path: '/cart',
      sessionId: 'sess-1',
    });

    expect(decision.reason).toBe('no entitlement for this product');
    expect(sessions.get).not.toHaveBeenCalled();
  });

  it('survives a cache read failure and evaluates normally', async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error('redis down'));
    const { service } = setup({
      redis,
      routes: [
        ['FROM instance_route', ROUTE],
        ['FROM entitlement', [{ '?column?': 1 }]],
      ],
    });

    const decision = await service.decide({
      host: 'shop.test',
      path: '/cart',
      sessionId: 'sess-1',
    });
    expect(decision.allow).toBe(true);
  });

  it('still answers when the cache write fails', async () => {
    const redis = fakeRedis();
    redis.set.mockRejectedValue(new Error('redis down'));
    const { service } = setup({
      redis,
      routes: [
        ['FROM instance_route', ROUTE],
        ['FROM entitlement', [{ '?column?': 1 }]],
      ],
    });

    const decision = await service.decide({
      host: 'shop.test',
      path: '/cart',
      sessionId: 'sess-1',
    });
    expect(decision.allow).toBe(true);
  });
});

describe('decide: evaluation', () => {
  it('refuses an anonymous request', async () => {
    const { service } = setup();
    const decision = await service.decide({ host: 'shop.test', path: '/cart', sessionId: null });
    expect(decision).toEqual({ allow: false, headers: {}, reason: 'no session' });
  });

  it('refuses a session that the platform no longer knows', async () => {
    const { service } = setup({ sessions: { get: vi.fn(async () => null) } });
    const decision = await service.decide({ host: 'shop.test', path: '/cart', sessionId: 'gone' });
    expect(decision.reason).toBe('session not found or expired');
  });

  it('enforces the absolute deadline the idle TTL cannot', async () => {
    const { service } = setup({
      sessions: { get: vi.fn(async () => ({ ...SESSION, absoluteExpiresAt: Date.now() - 1 })) },
    });
    const decision = await service.decide({ host: 'shop.test', path: '/cart', sessionId: 'sess' });
    expect(decision.reason).toBe('session reached its absolute lifetime');
  });

  it('refuses a host the platform does not route', async () => {
    const { service } = setup({ routes: [['FROM instance_route', []]] });
    const decision = await service.decide({
      host: 'unknown.test',
      path: '/cart',
      sessionId: 'sess',
    });
    expect(decision.reason).toBe('host is not routed by the platform');
  });

  it('refuses while the restore gate holds the route', async () => {
    const { service } = setup({
      routes: [['FROM instance_route', [{ ...ROUTE[0], gated: true }]]],
    });
    const decision = await service.decide({ host: 'shop.test', path: '/cart', sessionId: 'sess' });
    expect(decision.reason).toBe('the restore gate holds product routes');
  });

  it('refuses an unpublished route', async () => {
    const { service } = setup({
      routes: [['FROM instance_route', [{ ...ROUTE[0], published: false }]]],
    });
    const decision = await service.decide({ host: 'shop.test', path: '/cart', sessionId: 'sess' });
    expect(decision.reason).toBe('the restore gate holds product routes');
  });

  it('refuses a signed-in user without an entitlement row', async () => {
    const { service } = setup({
      routes: [
        ['FROM instance_route', ROUTE],
        ['FROM entitlement', []],
      ],
    });
    const decision = await service.decide({ host: 'shop.test', path: '/cart', sessionId: 'sess' });
    expect(decision.reason).toBe('no entitlement for this product');
  });

  it('allows an entitled session and emits the identity headers from the session', async () => {
    const { service } = setup({
      routes: [
        ['FROM instance_route', ROUTE],
        ['FROM entitlement', [{ '?column?': 1 }]],
      ],
    });

    const decision = await service.decide({ host: 'shop.test', path: '/cart', sessionId: 'sess' });

    expect(decision).toEqual({
      allow: true,
      headers: {
        'X-Platform-User': 'uuid-1',
        'X-Platform-Groups': '/core,/ops',
        'X-Platform-Instance': 'inst-1',
      },
      reason: 'entitled session (oidc)',
    });
  });

  it('normalises the host, dropping case, whitespace and the dev port', async () => {
    const { db, service } = setup({
      routes: [
        ['FROM instance_route', ROUTE],
        ['FROM entitlement', [{ '?column?': 1 }]],
      ],
    });

    await service.decide({ host: '  Shop.LocalHost:8020 ', path: '/cart', sessionId: 'sess' });

    const routeQuery = db.calls.find((call) => call.sql.includes('FROM instance_route'));
    expect(routeQuery?.params).toEqual(['shop.localhost']);
  });

  it('treats a failed session read as no session', async () => {
    const { service } = setup({
      sessions: { get: vi.fn(async () => Promise.reject(new Error('redis down'))) },
    });
    const decision = await service.decide({ host: 'shop.test', path: '/cart', sessionId: 'sess' });
    expect(decision.reason).toBe('session not found or expired');
  });
});

describe('redeem', () => {
  const TICKET_KEY = 'seamnex:launch:ticket-1';

  function ticket(
    payload: Record<string, unknown> = { sessionId: 'sess-1', instanceId: 'inst-1' },
  ) {
    return JSON.stringify(payload);
  }

  it('redeems a single-use ticket for the host it was minted for', async () => {
    const redis = fakeRedis({ [TICKET_KEY]: ticket() });
    const { service } = setup({
      redis,
      routes: [['FROM instance_route', [{ instance_id: 'inst-1' }]]],
    });

    await expect(service.redeem({ ticket: 'ticket-1', host: 'Shop.Test:8020' })).resolves.toEqual({
      sessionId: 'sess-1',
      // ADR-BE-22: the relay needs to know whose account, on which instance, without the ticket
      // ever carrying either.
      instanceId: 'inst-1',
      subjectIdpId: 'uuid-1',
    });
    // Single use: the second attempt finds nothing.
    await expect(service.redeem({ ticket: 'ticket-1', host: 'shop.test' })).resolves.toBeNull();
  });

  it.each([[''], ['x'.repeat(129)]])('refuses a ticket of unusable length %#', async (value) => {
    const redis = fakeRedis({ [`seamnex:launch:${value}`]: ticket() });
    const { service } = setup({ redis });
    await expect(service.redeem({ ticket: value, host: 'shop.test' })).resolves.toBeNull();
    expect(redis.getdel).not.toHaveBeenCalled();
  });

  it('refuses a ticket that is not in Redis', async () => {
    const { service } = setup({ redis: fakeRedis() });
    await expect(service.redeem({ ticket: 'unknown', host: 'shop.test' })).resolves.toBeNull();
  });

  it('refuses a payload that is not JSON', async () => {
    const redis = fakeRedis({ [TICKET_KEY]: 'not-json' });
    const { service } = setup({ redis });
    await expect(service.redeem({ ticket: 'ticket-1', host: 'shop.test' })).resolves.toBeNull();
  });

  it('refuses a ticket minted for a different instance', async () => {
    const redis = fakeRedis({ [TICKET_KEY]: ticket() });
    const { service } = setup({
      redis,
      routes: [['FROM instance_route', [{ instance_id: 'inst-2' }]]],
    });
    await expect(service.redeem({ ticket: 'ticket-1', host: 'shop.test' })).resolves.toBeNull();
  });

  it('refuses a ticket for a route that no longer exists', async () => {
    const redis = fakeRedis({ [TICKET_KEY]: ticket() });
    const { service } = setup({ redis, routes: [['FROM instance_route', []]] });
    await expect(service.redeem({ ticket: 'ticket-1', host: 'shop.test' })).resolves.toBeNull();
  });

  it('refuses a ticket whose session has ended', async () => {
    const redis = fakeRedis({ [TICKET_KEY]: ticket() });
    const { service } = setup({
      redis,
      routes: [['FROM instance_route', [{ instance_id: 'inst-1' }]]],
      sessions: { get: vi.fn(async () => null) },
    });
    await expect(service.redeem({ ticket: 'ticket-1', host: 'shop.test' })).resolves.toBeNull();
  });

  it('refuses a ticket whose session is past its absolute deadline', async () => {
    const redis = fakeRedis({ [TICKET_KEY]: ticket() });
    const { service } = setup({
      redis,
      routes: [['FROM instance_route', [{ instance_id: 'inst-1' }]]],
      sessions: { get: vi.fn(async () => ({ ...SESSION, absoluteExpiresAt: Date.now() - 1 })) },
    });
    await expect(service.redeem({ ticket: 'ticket-1', host: 'shop.test' })).resolves.toBeNull();
  });

  it('treats a Redis failure during redemption as a refusal', async () => {
    const redis = fakeRedis({ [TICKET_KEY]: ticket() });
    redis.getdel.mockRejectedValue(new Error('redis down'));
    const { service } = setup({ redis });
    await expect(service.redeem({ ticket: 'ticket-1', host: 'shop.test' })).resolves.toBeNull();
  });

  it('treats a failed session read during redemption as a refusal', async () => {
    const redis = fakeRedis({ [TICKET_KEY]: ticket() });
    const { service } = setup({
      redis,
      routes: [['FROM instance_route', [{ instance_id: 'inst-1' }]]],
      sessions: { get: vi.fn(async () => Promise.reject(new Error('redis down'))) },
    });
    await expect(service.redeem({ ticket: 'ticket-1', host: 'shop.test' })).resolves.toBeNull();
  });
});

describe('invalidate', () => {
  it('drops every cached decision for one host', async () => {
    const redis = fakeRedis({
      'seamnex:fa:shop.test:sess:cart': '{}',
      'seamnex:fa:other.test:sess:cart': '{}',
    });
    const { service } = setup({ redis });

    await service.invalidate('Shop.Test:8020');

    expect(redis.keys).toHaveBeenCalledWith('seamnex:fa:shop.test:*');
    expect([...redis.store.keys()]).toEqual(['seamnex:fa:other.test:sess:cart']);
  });

  it('drops every cached decision when no host is given', async () => {
    const redis = fakeRedis({ 'seamnex:fa:shop.test:sess:cart': '{}' });
    const { service } = setup({ redis });

    await service.invalidate();

    expect(redis.keys).toHaveBeenCalledWith('seamnex:fa:*');
    expect([...redis.store.keys()]).toEqual([]);
  });

  it('does not issue a delete when nothing matched', async () => {
    const redis = fakeRedis();
    const { service } = setup({ redis });

    await service.invalidate('shop.test');

    expect(redis.del).not.toHaveBeenCalled();
  });

  it('swallows a Redis failure: an invalidation must never fail the caller', async () => {
    const redis = fakeRedis({ 'seamnex:fa:shop.test:sess:cart': '{}' });
    redis.keys.mockRejectedValue(new Error('redis down'));
    const { service } = setup({ redis });

    await expect(service.invalidate()).resolves.toBeUndefined();
  });

  it('swallows a delete failure', async () => {
    const redis = fakeRedis({ 'seamnex:fa:shop.test:sess:cart': '{}' });
    redis.del.mockRejectedValue(new Error('redis down'));
    const { service } = setup({ redis });

    await expect(service.invalidate()).resolves.toBeUndefined();
  });
});
