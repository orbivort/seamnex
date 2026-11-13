import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { CachedForwardAuthService } from '../../../../src/modules/m11-forward-auth/forward-auth.service';

/**
 * The cached-decision boundary. A cache entry is keyed by host, session and the first path segment,
 * and two shapes of request make that key degenerate: a path with no second segment, and a request
 * with no session at all. Both must still re-read the session before a cached `allow` is honoured —
 * the cache holds the route and the entitlement, never the session.
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
    getdel: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async () => 1),
    keys: vi.fn(async () => [...store.keys()]),
  };
}

function setup(options: {
  redis: ReturnType<typeof fakeRedis>;
  sessions?: { get: (id: string) => Promise<unknown> };
}) {
  const db = fakeDb();
  const sessions = options.sessions ?? { get: vi.fn(async () => null) };
  const service = new CachedForwardAuthService(db.pool, options.redis as never, sessions as never);
  return { db, sessions, service };
}

const ALLOW = JSON.stringify({
  allow: true,
  headers: { 'X-Platform-User': 'uuid-1' },
  reason: 'old',
});

describe('degenerate cache keys', () => {
  it('keys a path with no second segment on an empty segment', async () => {
    const redis = fakeRedis();
    const { service } = setup({ redis });

    // `cart` (no leading slash) has one segment, so the key ends in an empty namespace rather than
    // in `undefined`.
    await service.decide({ host: 'shop.test', path: 'cart', sessionId: 'sess-1' });

    expect(redis.get).toHaveBeenCalledWith('seamnex:fa:shop.test:sess-1:');
  });

  it('re-reads the session under the anonymous key and refuses when there is none', async () => {
    // A cached allow keyed for `anonymous` can only be honoured by a session, and `''` is not one.
    const redis = fakeRedis({ 'seamnex:fa:shop.test:anonymous:': ALLOW });
    const sessions = { get: vi.fn(async () => null) };
    const { service } = setup({ redis, sessions });

    const decision = await service.decide({ host: 'shop.test', path: 'cart', sessionId: null });

    expect(sessions.get).toHaveBeenCalledWith('');
    expect(decision).toEqual({
      allow: false,
      headers: {},
      reason: 'session not found or expired',
    });
  });

  it('refuses a cached allow when the session read fails outright', async () => {
    const redis = fakeRedis({ 'seamnex:fa:shop.test:sess-1:cart': ALLOW });
    const sessions = {
      get: vi.fn(async () => Promise.reject(new Error('session redis down'))),
    };
    const { service } = setup({ redis, sessions });

    // A failed session read is "no session": the cached grant of passage is not evidence of one.
    await expect(
      service.decide({ host: 'shop.test', path: '/cart/1', sessionId: 'sess-1' }),
    ).resolves.toEqual({
      allow: false,
      headers: {},
      reason: 'session not found or expired',
    });
  });
});
