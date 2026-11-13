import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { SessionCreateInput } from '../../../../src/modules/m10-portal-bff/session.contract';
import { RedisSessionService } from '../../../../src/modules/m10-portal-bff/session.service';

/**
 * Opaque server-side sessions. The assertions follow the three properties the design leans on: the
 * cookie value is 256 bits of randomness, the absolute deadline lives in the record (a Redis TTL
 * cannot extend it), and a sign-in or sign-out is only complete once it is audited — with the one
 * deliberate exception that a failing audit never keeps a user signed in after a sign-out.
 */
vi.mock('@seamnex/db', () => ({
  Repository: class {
    constructor(protected readonly pool: unknown) {}
    protected async many(sql: string, params: readonly unknown[] = []): Promise<unknown[]> {
      const result = (await (
        this.pool as { query: (s: string, p: unknown[]) => Promise<{ rows: unknown[] }> }
      ).query(sql, [...params])) as { rows: unknown[] };
      return result.rows;
    }
  },
}));

function setup(
  options: {
    routes?: Parameters<typeof fakeDb>[0];
    settings?: () => Promise<{ settings: Record<string, number> }>;
    relay?: { invalidate: ReturnType<typeof vi.fn> };
  } = {},
) {
  const db = fakeDb(options.routes ?? []);
  const store = {
    get: vi.fn(),
    save: vi.fn(async () => undefined),
    touch: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    subjectSessionIds: vi.fn(async () => [] as string[]),
    clearSubject: vi.fn(async () => undefined),
  };
  const access = {
    settings:
      options.settings ??
      (async () => ({ settings: { sessionIdleMinutes: 30, sessionAbsoluteHours: 12 } })),
  };
  const audit = { append: vi.fn(async () => ({ seq: '1', hash: 'h' })) };
  const relay = options.relay ?? { invalidate: vi.fn(async () => undefined) };
  const service = new RedisSessionService(
    db.pool,
    store as never,
    access as never,
    audit as never,
    relay as never,
  );
  return { db, store, access, audit, relay, service };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    sid: 'sid-1',
    sub: 'uuid-1',
    username: 'alice',
    displayName: 'Alice',
    email: 'alice@example.test',
    groups: ['/core'],
    roles: ['R3'],
    mfaSatisfied: true,
    mfaMethod: 'otp',
    mfaAsserted: true,
    csrfToken: 'csrf',
    instanceId: null,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    absoluteExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

const INPUT: SessionCreateInput = {
  sub: 'uuid-1',
  username: 'alice',
  displayName: 'Alice',
  email: 'alice@example.test',
  groups: ['/core'],
  roles: ['R3'],
  mfaSatisfied: true,
  mfaMethod: 'totp',
  mfaAsserted: true,
  instanceId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('create', () => {
  it('stores an opaque session with the idle TTL from settings and audits it', async () => {
    const { store, audit, service } = setup();

    const created = await service.create(INPUT);

    expect(created.sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.sid).not.toBe(created.csrfToken);
    expect(created.groups).toEqual(['/core']);
    expect(created.roles).toEqual(['R3']);
    expect(created.absoluteExpiresAt - created.createdAt).toBe(12 * 3_600_000);
    expect(store.save).toHaveBeenCalledWith(created, 30 * 60);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.session.created',
        actorId: 'uuid-1',
        targetId: created.sid,
        detail: { mfaSatisfied: true, mfaAsserted: true, roles: ['R3'] },
      }),
    );
  });

  it('copies the caller arrays so a later mutation cannot change the session', async () => {
    const { service } = setup();
    const input = { ...INPUT, groups: ['/core'], roles: ['R3'] };

    const created = await service.create(input as never);
    (input as { groups: string[] }).groups.push('/other');

    expect(created.groups).toEqual(['/core']);
  });

  it('fails closed when the session cannot be audited', async () => {
    const { audit, service } = setup();
    audit.append.mockRejectedValue(new Error('audit down'));

    await expect(service.create(INPUT)).rejects.toThrow('audit down');
  });
});

describe('read', () => {
  it('returns null for an unknown session', async () => {
    const { store, service } = setup();
    store.get.mockResolvedValue(null);

    await expect(service.read('missing')).resolves.toBeNull();
  });

  it('deletes a session past its absolute deadline', async () => {
    const { store, service } = setup();
    store.get.mockResolvedValue(record({ absoluteExpiresAt: Date.now() - 1 }));

    await expect(service.read('sid-1')).resolves.toBeNull();
    expect(store.delete).toHaveBeenCalledWith('sid-1', 'uuid-1');
  });

  it('touches a session that has been idle past the refresh interval', async () => {
    const { store, service } = setup();
    store.get.mockResolvedValue(record({ lastSeen: Date.now() - 61_000 }));

    const read = await service.read('sid-1');

    expect(read?.lastSeen).toBeGreaterThan(Date.now() - 1_000);
    expect(store.touch).toHaveBeenCalledWith(read, 30 * 60);
  });

  it('does not touch a session that was seen recently', async () => {
    const { store, service } = setup();
    const stored = record({ lastSeen: Date.now() - 1_000 });
    store.get.mockResolvedValue(stored);

    await expect(service.read('sid-1')).resolves.toBe(stored);
    expect(store.touch).not.toHaveBeenCalled();
  });
});

describe('kill', () => {
  it('deletes the session and audits the revocation', async () => {
    const { store, audit, service } = setup();
    store.get.mockResolvedValue(record());

    await service.kill('sid-1', 'sign-out');

    expect(store.delete).toHaveBeenCalledWith('sid-1', 'uuid-1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.session.revoked',
        actorType: 'user',
        actorId: 'uuid-1',
        detail: { reason: 'sign-out' },
      }),
    );
  });

  it('revokes a session it cannot read, attributing it to the system', async () => {
    const { store, audit, service } = setup();
    store.get.mockResolvedValue(null);

    await service.kill('sid-1', 'expired');

    expect(store.delete).toHaveBeenCalledWith('sid-1', undefined);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'system', actorId: 'unknown' }),
    );
  });

  it('drops the subject’s cached product sessions when a session is killed', async () => {
    const relay = { invalidate: vi.fn(async () => undefined) };
    const { store, service } = setup({ relay });
    store.get.mockResolvedValue(record());

    await service.kill('sid-1', 'sign-out');

    expect(relay.invalidate).toHaveBeenCalledWith({ subjectIdpId: 'uuid-1' });
  });

  it('does not guess a subject it never read', async () => {
    const relay = { invalidate: vi.fn(async () => undefined) };
    const { store, service } = setup({ relay });
    store.get.mockResolvedValue(null);

    await service.kill('sid-1', 'expired');

    // With no record there is no subject, and dropping every subject's cache would be worse.
    expect(relay.invalidate).not.toHaveBeenCalled();
  });

  it('still signs the user out when the audit log is down', async () => {
    const { audit, service } = setup();
    audit.append.mockRejectedValue(new Error('audit down'));

    await expect(service.kill('sid-1', 'sign-out')).resolves.toBeUndefined();
  });

  it('records a non-Error audit failure without throwing', async () => {
    const { audit, service } = setup();
    audit.append.mockRejectedValue('audit down');

    await expect(service.kill('sid-1', 'sign-out')).resolves.toBeUndefined();
  });
});

describe('killSubject', () => {
  it('revokes every session of a subject and audits once', async () => {
    const { store, audit, service } = setup();
    store.subjectSessionIds.mockResolvedValue(['sid-1', 'sid-2']);

    await expect(service.killSubject('uuid-1', 'disabled')).resolves.toBe(2);

    expect(store.delete).toHaveBeenCalledTimes(2);
    expect(store.clearSubject).toHaveBeenCalledWith('uuid-1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.session.revoked',
        targetType: 'subject',
        detail: { reason: 'disabled', sessions: 2 },
      }),
    );
  });

  it('drops the cached product sessions on sign-out (ADR-BE-22)', async () => {
    const relay = { invalidate: vi.fn(async () => undefined) };
    const { store, service } = setup({ relay });
    store.subjectSessionIds.mockResolvedValue(['sid-1']);

    await service.killSubject('uuid-1', 'disabled');

    // A cached product cookie must not outlive the platform session that justified it.
    expect(relay.invalidate).toHaveBeenCalledWith({ subjectIdpId: 'uuid-1' });
  });

  it('writes nothing when the subject has no sessions', async () => {
    const { audit, service } = setup();

    await expect(service.killSubject('uuid-1', 'none')).resolves.toBe(0);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('swallows an audit failure and a non-Error reason', async () => {
    const { audit, store, service } = setup();
    store.subjectSessionIds.mockResolvedValue(['sid-1']);
    audit.append.mockRejectedValue('down');

    await expect(service.killSubject('uuid-1', 'disabled')).resolves.toBe(1);
  });
});

describe('residualSessions', () => {
  it('lists products with a verified lifetime, skipping one whose sign-in check failed', async () => {
    const { service } = setup({
      routes: [
        [
          'FROM entitlement e',
          [
            {
              instance_id: 'inst-1',
              product: 'EspoCRM',
              session_max_minutes: 480,
              slo_supported: true,
              verified_at: new Date('2026-01-01T00:00:00Z'),
              idp_client_id: 'client-1',
              sso_ok: true,
            },
            {
              instance_id: 'inst-2',
              product: 'Mautic',
              session_max_minutes: 60,
              slo_supported: null,
              verified_at: null,
              idp_client_id: 'client-2',
              sso_ok: null,
            },
            {
              // Identity client registered but the latest end-to-end check failed: not listed.
              instance_id: 'inst-3',
              product: 'Broken',
              session_max_minutes: 30,
              slo_supported: false,
              verified_at: null,
              idp_client_id: 'client-3',
              sso_ok: false,
            },
          ],
        ],
      ],
    });

    await expect(service.residualSessions('uuid-1')).resolves.toEqual([
      {
        instanceId: 'inst-1',
        product: 'EspoCRM',
        maxRemainingMinutes: 480,
        singleLogout: true,
        verifiedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        instanceId: 'inst-2',
        product: 'Mautic',
        maxRemainingMinutes: null,
        singleLogout: false,
        verifiedAt: null,
      },
    ]);
  });

  it('keeps a product whose sso check passed but which declares no logout support', async () => {
    const { service } = setup({
      routes: [
        [
          'FROM entitlement e',
          [
            {
              instance_id: 'inst-1',
              product: 'EspoCRM',
              session_max_minutes: 480,
              slo_supported: false,
              verified_at: new Date('2026-01-01T00:00:00Z'),
              idp_client_id: null,
              sso_ok: false,
            },
          ],
        ],
      ],
    });

    await expect(service.residualSessions('uuid-1')).resolves.toEqual([
      expect.objectContaining({ maxRemainingMinutes: 480, singleLogout: false }),
    ]);
  });
});

describe('session lifetimes', () => {
  it('reads both lifetimes from settings', async () => {
    const { service } = setup({
      settings: async () => ({ settings: { sessionIdleMinutes: 15, sessionAbsoluteHours: 2 } }),
    });

    await expect(service.idleSeconds()).resolves.toBe(900);
    await expect(service.absoluteSeconds()).resolves.toBe(7_200);
  });

  it('caches the settings read for a minute', async () => {
    const settings = vi.fn(async () => ({
      settings: { sessionIdleMinutes: 20, sessionAbsoluteHours: 4 },
    }));
    const { service } = setup({ settings });

    await service.idleSeconds();
    await service.absoluteSeconds();

    expect(settings).toHaveBeenCalledOnce();
  });

  it('falls back to the documented defaults when settings cannot be read', async () => {
    const { service } = setup({
      settings: async () => {
        throw new Error('settings down');
      },
    });

    await expect(service.idleSeconds()).resolves.toBe(30 * 60);
    await expect(service.absoluteSeconds()).resolves.toBe(12 * 3_600);
  });

  it('retries the settings read once the cache has aged out', async () => {
    vi.useFakeTimers();
    const settings = vi.fn(async () => ({
      settings: { sessionIdleMinutes: 10, sessionAbsoluteHours: 1 },
    }));
    const { service } = setup({ settings });

    await service.idleSeconds();
    vi.advanceTimersByTime(61_000);
    await service.idleSeconds();

    expect(settings).toHaveBeenCalledTimes(2);
  });
});
