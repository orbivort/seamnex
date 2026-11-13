import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { SessionRecord } from '../../../../src/modules/m10-portal-bff/session.contract';
import { SessionStore } from '../../../../src/modules/m10-portal-bff/session.store';

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: 'sid-1',
    sub: 'sub-1',
    username: 'alice',
    displayName: 'Alice',
    email: 'alice@example.test',
    groups: [],
    roles: ['R1'],
    mfaSatisfied: true,
    mfaMethod: 'totp',
    csrfToken: 'csrf',
    instanceId: null,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    absoluteExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

type Call = readonly [command: string, ...args: unknown[]];

function redisFake(options: { raw?: string | null; ids?: string[] } = {}) {
  const calls: Call[] = [];
  const chain = {
    multi: () => {
      calls.push(['multi']);
      return chain;
    },
    set: (...args: unknown[]) => {
      calls.push(['set', ...args]);
      return chain;
    },
    sadd: (...args: unknown[]) => {
      calls.push(['sadd', ...args]);
      return chain;
    },
    expire: (...args: unknown[]) => {
      calls.push(['expire', ...args]);
      return chain;
    },
    del: (...args: unknown[]) => {
      calls.push(['del', ...args]);
      return chain;
    },
    srem: (...args: unknown[]) => {
      calls.push(['srem', ...args]);
      return chain;
    },
    exec: () => {
      calls.push(['exec']);
      return Promise.resolve([]);
    },
    get: (key: string) => {
      calls.push(['get', key]);
      return Promise.resolve(options.raw === undefined ? null : options.raw);
    },
    smembers: (key: string) => {
      calls.push(['smembers', key]);
      return Promise.resolve(options.ids ?? []);
    },
  };
  return { chain, calls };
}

describe('SessionStore', () => {
  let calls: Call[];
  let store: SessionStore;

  beforeEach(() => {
    const fake = redisFake();
    calls = fake.calls;
    store = new SessionStore(fake.chain as unknown as Redis);
  });

  it('writes the record with the idle TTL and indexes it under the subject', async () => {
    const session = record();
    await store.save(session, 1_800);

    expect(calls[0]).toEqual(['multi']);
    expect(calls[1]?.[0]).toBe('set');
    expect(calls[1]?.[1]).toBe('seamnex:sess:sid-1');
    expect(calls[1]?.[2]).toBe(JSON.stringify(session));
    expect(calls[1]?.slice(3)).toEqual(['EX', 1_800]);
    expect(calls[2]?.[0]).toBe('sadd');
    expect(calls[2]?.slice(1)).toEqual(['seamnex:sess:sub:sub-1', 'sid-1']);
    expect(calls[3]?.[0]).toBe('expire');
  });

  it('never writes a TTL of zero and extends the subject index to the absolute lifetime', async () => {
    const session = record({ absoluteExpiresAt: Date.now() + 7_200_000 });
    await store.save(session, 0.4);

    expect(calls[1]?.slice(3)).toEqual(['EX', 1]);
    const subjectTtl = calls[3]?.[2] as number;
    expect(subjectTtl).toBeGreaterThanOrEqual(7_190);
  });

  it('reads a stored record', async () => {
    const fake = redisFake({ raw: JSON.stringify(record()) });
    store = new SessionStore(fake.chain as unknown as Redis);

    const found = await store.get('sid-1');
    expect(found?.sid).toBe('sid-1');
    expect(fake.calls[0]).toEqual(['get', 'seamnex:sess:sid-1']);
  });

  it('returns null for a missing record', async () => {
    const fake = redisFake({ raw: null });
    store = new SessionStore(fake.chain as unknown as Redis);
    expect(await store.get('sid-1')).toBeNull();
  });

  it('drops an unreadable record instead of failing every request that carries it', async () => {
    const fake = redisFake({ raw: '{not json' });
    store = new SessionStore(fake.chain as unknown as Redis);

    expect(await store.get('sid-1')).toBeNull();
    expect(fake.calls.some((call) => call[0] === 'del')).toBe(true);
  });

  it('touches the record with a positive TTL', async () => {
    await store.touch(record(), 900);
    expect(calls[0]?.[0]).toBe('set');
    expect(calls[0]?.slice(3)).toEqual(['EX', 900]);

    calls.length = 0;
    await store.touch(record(), -5);
    expect(calls[0]?.slice(3)).toEqual(['EX', 1]);
  });

  it('deletes the record and, when the subject is known, its index entry', async () => {
    await store.delete('sid-1');
    expect(calls.map((call) => call[0])).toEqual(['multi', 'del', 'exec']);

    calls.length = 0;
    await store.delete('sid-1', 'sub-1');
    expect(calls.map((call) => call[0])).toEqual(['multi', 'del', 'srem', 'exec']);
    expect(calls[2]?.slice(1)).toEqual(['seamnex:sess:sub:sub-1', 'sid-1']);
  });

  it('lists the session ids of a subject', async () => {
    const fake = redisFake({ ids: ['a', 'b'] });
    store = new SessionStore(fake.chain as unknown as Redis);

    expect(await store.subjectSessionIds('sub-1')).toEqual(['a', 'b']);
  });

  it('clears the subject index', async () => {
    await store.clearSubject('sub-1');
    expect(calls[0]).toEqual(['del', 'seamnex:sess:sub:sub-1']);
  });

  it('propagates a Redis failure so the caller can fail closed', async () => {
    const failing = {
      get: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as Redis;

    await expect(new SessionStore(failing).get('sid-1')).rejects.toThrow('redis down');
  });
});
