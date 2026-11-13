import { describe, expect, it, vi } from 'vitest';
import {
  acquireLoginLock,
  dropCachedSession,
  dropSubjectSessions,
  readCachedSession,
  relayLockKey,
  relaySessionKey,
  relaySubjectPattern,
  relayTtlSeconds,
  writeCachedSession,
} from '../../../../src/modules/m24-sign-in-relay/relay-cache';
import { fakeRelayRedis } from '../../../support/fakes';

/**
 * ADR-BE-22 §Session reuse: a cached product session is deleted on sign-out, on entitlement
 * revocation and on credential rotation. The mechanism is one `SCAN MATCH` walk per subject, and the
 * double here evaluates the pattern the way Redis does — the previous double answered "no keys" for
 * every pattern, which is how a pattern that matched nothing passed its tests.
 */

describe('relaySubjectPattern', () => {
  it('keeps the instance wildcard and escapes only the subject', () => {
    // `relay:*:<sub>` selects every instance for one subject. Escaping the whole string turned the
    // `*` into a literal, so the walk matched no key the relay ever writes.
    expect(relaySubjectPattern('subject-1')).toBe('relay:*:subject-1');
  });

  it('escapes glob metacharacters in the subject, which is IdP-controlled', () => {
    expect(relaySubjectPattern('a*')).toBe('relay:*:a\\*');
    expect(relaySubjectPattern('a?b')).toBe('relay:*:a\\?b');
    expect(relaySubjectPattern('a\\b')).toBe('relay:*:a\\\\b');
  });
});

describe('dropSubjectSessions', () => {
  it('deletes every cached instance for the subject on sign-out', async () => {
    const redis = fakeRelayRedis({
      [relaySessionKey('instance-1', 'subject-1')]: '{"cookies":["a=1"]}',
      [relaySessionKey('instance-2', 'subject-1')]: '{"cookies":["b=2"]}',
      [relaySessionKey('instance-1', 'subject-2')]: '{"cookies":["c=3"]}',
    });

    await dropSubjectSessions(redis as never, 'subject-1');

    expect([...redis.store.keys()]).toEqual([relaySessionKey('instance-1', 'subject-2')]);
  });

  it('removes a key the relay itself wrote, not only a hand-seeded one', async () => {
    const redis = fakeRelayRedis();
    await writeCachedSession(redis as never, 'instance-1', 'subject-1', ['p=1'], 300);

    await dropSubjectSessions(redis as never, 'subject-1');

    expect(redis.store.size).toBe(0);
  });

  it('does not let a wildcard in the subject delete another subject’s session', async () => {
    const redis = fakeRelayRedis({
      [relaySessionKey('instance-1', '*')]: '{"cookies":["x=1"]}',
      [relaySessionKey('instance-1', 'subject-1')]: '{"cookies":["y=2"]}',
    });

    await dropSubjectSessions(redis as never, '*');

    expect([...redis.store.keys()]).toEqual([relaySessionKey('instance-1', 'subject-1')]);
  });

  it('deletes one instance’s entry when the caller names the instance', async () => {
    const redis = fakeRelayRedis({
      [relaySessionKey('instance-1', 'subject-1')]: '{"cookies":["a=1"]}',
      [relaySessionKey('instance-2', 'subject-1')]: '{"cookies":["b=2"]}',
    });

    await dropSubjectSessions(redis as never, 'subject-1', 'instance-1');

    expect([...redis.store.keys()]).toEqual([relaySessionKey('instance-2', 'subject-1')]);
  });

  it('leaves the single-flight lock key alone', async () => {
    const redis = fakeRelayRedis({
      'relay-lock:instance-1:subject-1': 'token',
      [relaySessionKey('instance-1', 'subject-1')]: '{"cookies":["a=1"]}',
    });

    await dropSubjectSessions(redis as never, 'subject-1');

    // The subject pattern is `relay:*:<sub>`: a lock filed under that namespace would be collected
    // here and release a lock a live launch still holds.
    expect([...redis.store.keys()]).toEqual(['relay-lock:instance-1:subject-1']);
  });

  it('does not issue a delete when the subject has nothing cached', async () => {
    const redis = fakeRelayRedis({ [relaySessionKey('instance-1', 'someone-else')]: '{}' });

    await dropSubjectSessions(redis as never, 'subject-1');

    expect(redis.store.size).toBe(1);
  });

  it('stops walking and keeps what it has when the scan fails', async () => {
    const del = vi.fn(async () => 0);
    const redis = {
      scan: vi.fn(async () => {
        throw new Error('redis down');
      }),
      del,
    };

    // Sign-out is best effort: a revocation that could not complete must not throw at the caller
    // that is already ending the session.
    await expect(dropSubjectSessions(redis as never, 'subject-1')).resolves.toBeUndefined();
    expect(del).not.toHaveBeenCalled();
  });
});

describe('relayTtlSeconds', () => {
  it('assumes a conservative ceiling when the catalogue declares no session maximum', () => {
    // Not the 30-minute platform ceiling: the product's own TTL is unknown, and the ADR's
    // prerequisite is not enforced by code.
    expect(relayTtlSeconds(null, 1_800)).toBe(600);
  });

  it('subtracts the one-minute safety margin from a declared maximum', () => {
    expect(relayTtlSeconds(600, 1_800)).toBe(540);
    expect(relayTtlSeconds(120, 1_800)).toBe(60);
  });

  it('lets the platform ceiling win when it is the shorter bound', () => {
    expect(relayTtlSeconds(600, 300)).toBe(300);
  });

  it('answers 0 when no safe lifetime exists, rather than flooring at a minute', () => {
    // A floor would exceed a product session shorter than it — the bound it is computing.
    expect(relayTtlSeconds(60, 1_800)).toBe(0);
    expect(relayTtlSeconds(30, 1_800)).toBe(0);
    expect(relayTtlSeconds(600, 30)).toBe(0);
  });
});

describe('readCachedSession', () => {
  it('returns the cookies and the time they were cached', async () => {
    const redis = fakeRelayRedis({
      [relaySessionKey('instance-1', 'subject-1')]: JSON.stringify({
        cookies: ['a=1', 'b=2'],
        cachedAt: 1_700_000_000_000,
      }),
    });

    await expect(readCachedSession(redis as never, 'instance-1', 'subject-1')).resolves.toEqual({
      cookies: ['a=1', 'b=2'],
      cachedAt: 1_700_000_000_000,
    });
  });

  it('treats an unreadable cache as a miss instead of throwing out of the launch', async () => {
    const redis = fakeRelayRedis({
      [relaySessionKey('instance-1', 'subject-1')]: 'not json',
    });

    await expect(readCachedSession(redis as never, 'instance-1', 'subject-1')).resolves.toBeNull();
  });

  it('drops a value that carries no usable cookie', async () => {
    const redis = fakeRelayRedis({
      [relaySessionKey('instance-1', 'subject-1')]: JSON.stringify({ cookies: 'a=1' }),
    });

    await expect(readCachedSession(redis as never, 'instance-1', 'subject-1')).resolves.toBeNull();
  });

  it('drops entries that are not name=value strings', async () => {
    const redis = fakeRelayRedis({
      [relaySessionKey('instance-1', 'subject-1')]: JSON.stringify({
        cookies: [7, 'a=1'],
        cachedAt: 'yesterday',
      }),
    });

    // A value written by another version must not be able to poison the hop; the timestamp falls
    // back to 0 rather than to `NaN`.
    await expect(readCachedSession(redis as never, 'instance-1', 'subject-1')).resolves.toEqual({
      cookies: ['a=1'],
      cachedAt: 0,
    });
  });

  it('answers a miss when the cache cannot be read at all', async () => {
    const redis = {
      get: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };

    await expect(readCachedSession(redis as never, 'instance-1', 'subject-1')).resolves.toBeNull();
  });
});

describe('writeCachedSession', () => {
  it('writes with the computed lifetime', async () => {
    const redis = fakeRelayRedis();

    await writeCachedSession(redis as never, 'instance-1', 'subject-1', ['a=1'], 300);

    expect([...redis.store.keys()]).toEqual([relaySessionKey('instance-1', 'subject-1')]);
  });

  it('writes nothing when no safe lifetime exists or there is nothing to cache', async () => {
    const redis = fakeRelayRedis();

    await writeCachedSession(redis as never, 'instance-1', 'subject-1', ['a=1'], 0);
    await writeCachedSession(redis as never, 'instance-1', 'subject-1', [], 300);

    // `EX 0` is an error in Redis, and a session that outlives its product session is worse than a
    // cold launch.
    expect(redis.store.size).toBe(0);
  });

  it('does not fail the launch when the cache write fails', async () => {
    const redis = {
      set: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };

    await expect(
      writeCachedSession(redis as never, 'instance-1', 'subject-1', ['a=1'], 300),
    ).resolves.toBeUndefined();
  });
});

describe('dropCachedSession', () => {
  it('deletes exactly one instance and subject pair', async () => {
    const redis = fakeRelayRedis({
      [relaySessionKey('instance-1', 'subject-1')]: '{"cookies":["a=1"]}',
      [relaySessionKey('instance-1', 'subject-2')]: '{"cookies":["b=2"]}',
    });

    await dropCachedSession(redis as never, 'instance-1', 'subject-1');

    expect([...redis.store.keys()]).toEqual([relaySessionKey('instance-1', 'subject-2')]);
  });

  it('swallows a delete the cache refuses', async () => {
    const redis = {
      del: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };

    await expect(
      dropCachedSession(redis as never, 'instance-1', 'subject-1'),
    ).resolves.toBeUndefined();
  });
});

describe('acquireLoginLock', () => {
  it('takes the lock with the caller’s lifetime and releases only its own token', async () => {
    const redis = fakeRelayRedis();

    const release = await acquireLoginLock(redis as never, 'instance-1', 'subject-1', 30_000);

    expect(release).not.toBeNull();
    expect(redis.store.has(relayLockKey('instance-1', 'subject-1'))).toBe(true);
    await release?.();
    expect(redis.store.has(relayLockKey('instance-1', 'subject-1'))).toBe(false);
  });

  it('answers null when the lock is already held', async () => {
    const redis = fakeRelayRedis({ [relayLockKey('instance-1', 'subject-1')]: 'someone-else' });

    await expect(
      acquireLoginLock(redis as never, 'instance-1', 'subject-1', 30_000),
    ).resolves.toBeNull();
  });

  it('answers null when the cache cannot take the lock', async () => {
    const redis = {
      set: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };

    await expect(
      acquireLoginLock(redis as never, 'instance-1', 'subject-1', 30_000),
    ).resolves.toBeNull();
  });

  it('keeps a release failure out of the launch', async () => {
    const redis = {
      set: vi.fn(async () => 'OK'),
      eval: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };

    const release = await acquireLoginLock(redis as never, 'instance-1', 'subject-1', 30_000);

    await expect(release?.()).resolves.toBeUndefined();
  });
});
