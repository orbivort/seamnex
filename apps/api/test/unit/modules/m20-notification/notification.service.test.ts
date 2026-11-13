import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { PostgresNotificationService } from '../../../../src/modules/m20-notification/notification.service';

/**
 * Notification delivery has three behaviours worth pinning, and all three are refusals to lose
 * information: a suppressed notification is still a row (so "was anyone told?" stays answerable),
 * one broken channel does not stop the others, and "no channel configured" is recorded as `failed`
 * rather than dropped. Delivery itself goes to a stubbed `fetch`, so the request bodies are asserted.
 */
const h = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
    fn(db.client),
  );
  const audit = { lockChain: vi.fn(async () => undefined), append: vi.fn(async () => undefined) };
  const config = {
    SEAMNEX_MAILPIT_URL: 'http://mailpit.test',
    SEAMNEX_NOTIFY_FROM: 'platform@example.test',
    SEAMNEX_NOTIFY_DEDUPE_MINUTES: 30,
  } as unknown as AppConfig;
  const service = new PostgresNotificationService(db.pool, config, audit as never);
  return { db, audit, service };
}

function stubFetch(response: () => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => response());
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  h.withTransaction.mockReset();
});

describe('channels', () => {
  it('maps rows and derives the last delivery from the notification table', async () => {
    const { service } = setup([
      [
        'FROM alert_channel c',
        [
          {
            id: 'c1',
            type: 'email',
            target: 'ops@example.test',
            enabled: true,
            last_sent: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'c2',
            type: 'webhook',
            target: 'https://hook.test',
            enabled: false,
            last_sent: null,
          },
        ],
      ],
    ]);

    const channels = await service.channels();

    expect(channels).toEqual([
      {
        id: 'c1',
        type: 'email',
        target: 'ops@example.test',
        enabled: true,
        severities: ['info', 'warning', 'critical'],
        lastDeliveryAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'c2',
        type: 'webhook',
        target: 'https://hook.test',
        enabled: false,
        severities: ['info', 'warning', 'critical'],
        lastDeliveryAt: null,
      },
    ]);
  });
});

describe('replaceChannels', () => {
  it('refuses to delete the last channel', async () => {
    const { service } = setup();
    await expect(service.replaceChannels([], 'admin')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
  });

  it('replaces the set inside one transaction and audits the new list', async () => {
    const { db, audit, service } = setup([
      ['FROM alert_channel c', []],
      ['DELETE FROM alert_channel', []],
      ['INSERT INTO alert_channel', []],
    ]);

    await service.replaceChannels(
      [
        { type: 'email', target: 'ops@example.test', enabled: true },
        { type: 'webhook', target: 'https://hook.test', enabled: false },
      ],
      'admin-1',
    );

    expect(audit.lockChain).toHaveBeenCalledOnce();
    const inserts = db.calls.filter((call) => call.sql.includes('INSERT INTO alert_channel'));
    expect(inserts.map((call) => call.params)).toEqual([
      ['email', 'ops@example.test', true],
      ['webhook', 'https://hook.test', false],
    ]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.alerts.replaced',
        actorId: 'admin-1',
        detail: {
          channels: [
            { type: 'email', enabled: true },
            { type: 'webhook', enabled: false },
          ],
        },
      }),
      expect.anything(),
    );
  });
});

describe('notify', () => {
  it('marks a notification suppressed inside a maintenance window and delivers nothing', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    const { db, service } = setup([
      ['FROM maintenance_window', [{ id: 'mw-1', scope: 'platform' }]],
      ['INSERT INTO notification', [{ id: 'n1' }]],
    ]);

    const result = await service.notify({ severity: 'warning', subject: 's', body: 'b' });

    expect(result).toEqual({ queued: false, suppressedBy: 'maintenance window mw-1 (platform)' });
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO notification'));
    expect(insert?.params).toEqual([
      'warning',
      's',
      'b',
      'suppressed',
      'maintenance window mw-1 (platform)',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queues and delivers when no window is active', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));
    const { service } = setup([
      ['FROM maintenance_window', []],
      ['INSERT INTO notification', [{ id: 'n1' }]],
      [
        'FROM alert_channel WHERE enabled',
        [{ id: 'c1', type: 'webhook', target: 'https://h.test', enabled: true }],
      ],
      ['UPDATE notification', []],
    ]);

    const result = await service.notify({ severity: 'critical', subject: 's', body: 'b' });

    expect(result).toEqual({ queued: true, suppressedBy: null });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://h.test');
  });

  it('fails when the row is not created', async () => {
    const { service } = setup([
      ['FROM maintenance_window', []],
      ['INSERT INTO notification', []],
    ]);
    await expect(
      service.notify({ severity: 'info', subject: 's', body: 'b' }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('records a failed delivery when no channel is enabled', async () => {
    const { db, service } = setup([
      ['FROM maintenance_window', []],
      ['INSERT INTO notification', [{ id: 'n1' }]],
      ['FROM alert_channel WHERE enabled', []],
      ['UPDATE notification', []],
    ]);

    await service.notify({ severity: 'info', subject: 's', body: 'b' });

    const update = db.calls.find((call) => call.sql.includes('UPDATE notification'));
    expect(update?.params).toEqual(['n1', 'no enabled alert channel']);
  });

  it('sends to one channel even when another fails', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 500 }));
    const { db, service } = setup([
      ['FROM maintenance_window', []],
      ['INSERT INTO notification', [{ id: 'n1' }]],
      [
        'FROM alert_channel WHERE enabled',
        [
          { id: 'c1', type: 'webhook', target: 'https://broken.test', enabled: true },
          { id: 'c2', type: 'email', target: 'ops@example.test', enabled: true },
        ],
      ],
      ['UPDATE notification', []],
    ]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await service.notify({ severity: 'info', subject: 's', body: 'b' });

    const update = db.calls.find((call) => call.sql.includes('UPDATE notification'));
    // The email succeeded, so the notification is `sent` through that channel.
    expect(update?.params).toEqual(['n1', 'sent', 'c2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks the notification failed when every channel fails', async () => {
    stubFetch(() => new Response(null, { status: 500 }));
    const { db, service } = setup([
      ['FROM maintenance_window', []],
      ['INSERT INTO notification', [{ id: 'n1' }]],
      [
        'FROM alert_channel WHERE enabled',
        [{ id: 'c1', type: 'webhook', target: 'https://h.test', enabled: true }],
      ],
      ['UPDATE notification', []],
    ]);

    await service.notify({ severity: 'info', subject: 's', body: 'b' });

    expect(db.calls.find((call) => call.sql.includes('UPDATE notification'))?.params).toEqual([
      'n1',
      'failed',
      null,
    ]);
  });
});

describe('testChannel', () => {
  it('reports the delivery through a webhook', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 202 }));
    const { service } = setup([
      [
        'FROM alert_channel WHERE id',
        [{ id: 'c1', type: 'webhook', target: 'https://h.test', enabled: true }],
      ],
    ]);

    const result = await service.testChannel('c1');

    expect(result.ok).toBe(true);
    expect(result.detail).toBe('https://h.test answered 202');
    expect(result.deliveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://h.test');
  });

  it('posts to the mail relay for an email channel', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));
    const { service } = setup([
      [
        'FROM alert_channel WHERE id',
        [{ id: 'c2', type: 'email', target: 'ops@example.test', enabled: true }],
      ],
    ]);

    const result = await service.testChannel('c2');

    expect(result).toMatchObject({ ok: true, detail: 'mail relay answered 200' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://mailpit.test/api/v1/send');
    expect(JSON.parse(String(init.body))).toMatchObject({
      From: { Email: 'platform@example.test' },
      To: [{ Email: 'ops@example.test' }],
    });
  });

  it('reports a transport failure as a failed delivery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const { service } = setup([
      [
        'FROM alert_channel WHERE id',
        [{ id: 'c1', type: 'webhook', target: 'https://h.test', enabled: true }],
      ],
    ]);

    await expect(service.testChannel('c1')).resolves.toMatchObject({
      ok: false,
      detail: 'connect ECONNREFUSED',
    });
  });

  it('stringifies a non-Error transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'EHOSTUNREACH';
      }),
    );
    const { service } = setup([
      [
        'FROM alert_channel WHERE id',
        [{ id: 'c1', type: 'webhook', target: 'https://h.test', enabled: true }],
      ],
    ]);

    await expect(service.testChannel('c1')).resolves.toMatchObject({ detail: 'EHOSTUNREACH' });
  });

  it('refuses an unknown channel', async () => {
    const { service } = setup([['FROM alert_channel WHERE id', []]]);
    await expect(service.testChannel('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('evaluate', () => {
  it('notifies unhealthy instances, honouring the dedupe window', async () => {
    const { db, service } = setup([
      [
        'FROM instance_status s',
        [
          { id: 'i1', slug: 'shop', state: 'failed', reason: 'oom' },
          { id: 'i2', slug: 'blog', state: 'degraded', reason: null },
        ],
      ],
      ['AS present', [{ present: true }]],
      ['FROM break_glass_session', []],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 0 });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO notification'))).toBe(false);
  });

  it('counts sent and suppressed outcomes separately', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    const { service } = setup([
      [
        'FROM instance_status s',
        [
          { id: 'i1', slug: 'shop', state: 'failed', reason: 'oom' },
          { id: 'i2', slug: 'blog', state: 'degraded', reason: null },
        ],
      ],
      ['SELECT EXISTS', [{ present: false }]],
      ['FROM maintenance_window', []],
      ['INSERT INTO notification', [{ id: 'n1' }]],
      [
        'FROM alert_channel WHERE enabled',
        [{ id: 'c1', type: 'webhook', target: 'https://h.test', enabled: true }],
      ],
      ['UPDATE notification', []],
      ['FROM break_glass_session', []],
    ]);

    const result = await service.evaluate();

    // Both instances were queued: neither has a window, and the dedupe read said "not sent".
    expect(result.sent).toBe(2);
  });

  it('notifies an active break-glass grant with its expiry', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    const { db, service } = setup([
      ['FROM instance_status s', []],
      ['SELECT EXISTS', [{ present: false }]],
      [
        'FROM break_glass_session',
        [
          {
            id: 'abcdef123456',
            state: 'active',
            instance_id: 'i1',
            expires_at: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: '999999999999',
            state: 'expired',
            instance_id: null,
            expires_at: null,
          },
        ],
      ],
      ['FROM maintenance_window', []],
      ['INSERT INTO notification', [{ id: 'n1' }]],
      [
        'FROM alert_channel WHERE enabled',
        [{ id: 'c1', type: 'webhook', target: 'https://h.test', enabled: true }],
      ],
      ['UPDATE notification', []],
    ]);

    const result = await service.evaluate();

    expect(result.sent).toBe(2);
    const inserts = db.calls.filter((call) => call.sql.includes('INSERT INTO notification'));
    expect(inserts.map((call) => call.params[1])).toEqual([
      'Break-glass access granted (abcdef12)',
      'Break-glass access expired (99999999)',
    ]);
    expect(String(inserts[0]?.params[2])).toContain('active until 2026-01-01T00:00:00.000Z');
    expect(String(inserts[1]?.params[2])).toContain(
      'has expired and its product account was revoked',
    );
  });

  it('describes an active grant with no recorded expiry', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    const { db, service } = setup([
      ['FROM instance_status s', []],
      ['SELECT EXISTS', [{ present: false }]],
      [
        'FROM break_glass_session',
        [{ id: 'abcdef123456', state: 'active', instance_id: null, expires_at: null }],
      ],
      ['FROM maintenance_window', []],
      ['INSERT INTO notification', [{ id: 'n1' }]],
      [
        'FROM alert_channel WHERE enabled',
        [{ id: 'c1', type: 'webhook', target: 'https://h.test', enabled: true }],
      ],
      ['UPDATE notification', []],
    ]);

    await service.evaluate();

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO notification'));
    expect(String(insert?.params[2])).toContain('an unrecorded time');
  });
});

describe('flush', () => {
  it('delivers every queued notification and counts the successes', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));
    const { service } = setup([
      [
        "WHERE state = 'queued'",
        [
          { id: 'n1', severity: 'info', subject: 'a', body: 'b' },
          { id: 'n2', severity: 'critical', subject: 'c', body: 'd' },
        ],
      ],
      [
        'FROM alert_channel WHERE enabled',
        [{ id: 'c1', type: 'webhook', target: 'https://h.test', enabled: true }],
      ],
      ['UPDATE notification', []],
    ]);

    const delivered = await service.flush(10);

    expect(delivered).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('counts nothing when a notification has no channel to go to', async () => {
    const { service } = setup([
      ["WHERE state = 'queued'", [{ id: 'n1', severity: 'info', subject: 'a', body: 'b' }]],
      ['FROM alert_channel WHERE enabled', []],
      ['UPDATE notification', []],
    ]);

    await expect(service.flush()).resolves.toBe(0);
  });
});
