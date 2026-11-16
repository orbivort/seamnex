import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { PostgresNotificationService } from '../../../../src/modules/m20-notification/notification.service';

/**
 * Suppression inside `evaluate`. The threshold pass counts two outcomes and they are not the same
 * fact: `sent` means a channel accepted the message, `suppressed` means a maintenance window held it
 * back. Folding the second into the first would report an alert during a window that nobody
 * received, which is the number an operator checks afterwards.
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
    SEAMNEX_CAPACITY_SAMPLE_INTERVAL_MS: 60_000,
  } as unknown as AppConfig;
  return { db, service: new PostgresNotificationService(db.pool, config, audit as never) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.withTransaction.mockReset();
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evaluate', () => {
  it('counts an unhealthy instance held back by a maintenance window as suppressed', async () => {
    const { db, service } = setup([
      ['FROM instance_status s', [{ id: 'i1', slug: 'shop', state: 'failed', reason: 'oom' }]],
      ['SELECT EXISTS', [{ present: false }]],
      ['FROM settings', []],
      ['instance_usage_sample', []],
      ['FROM maintenance_window', [{ id: 'mw-1', scope: 'platform' }]],
      ['INSERT INTO notification', [{ id: 'n1' }]],
      ['FROM break_glass_session', []],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 1 });
    // The row is still written, with the window as its reason — suppression is data, not a drop.
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO notification'));
    expect(insert?.params).toEqual([
      'critical',
      'Instance shop is failed',
      'shop reported failed: oom.',
      'suppressed',
      'maintenance window mw-1 (platform)',
      null,
      null,
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a break-glass notice that was already sent inside the dedupe window', async () => {
    const { db, service } = setup([
      ['FROM instance_status s', []],
      // `already sent`: the dedupe read is what makes a restarted scheduler idempotent.
      ['SELECT EXISTS', [{ present: true }]],
      ['FROM settings', []],
      ['instance_usage_sample', []],
      [
        'FROM break_glass_session',
        [
          {
            id: 'abcdef123456',
            state: 'expired',
            instance_id: null,
            expires_at: null,
            product: null,
            owner_name: null,
            owner_email: null,
          },
        ],
      ],
      ['UPDATE break_glass_session', []],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 0 });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO notification'))).toBe(false);
    // Deduped is still announced: the marker is written so the next pass stops asking.
    expect(db.calls.some((call) => call.sql.includes('SET expiry_notified_at = now()'))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts a break-glass notice held back by a maintenance window as suppressed', async () => {
    const { service } = setup([
      ['FROM instance_status s', []],
      ['SELECT EXISTS', [{ present: false }]],
      ['FROM settings', []],
      ['instance_usage_sample', []],
      [
        'FROM break_glass_session',
        [
          {
            id: 'abcdef123456',
            state: 'active',
            instance_id: 'i1',
            expires_at: new Date('2026-01-01T00:00:00Z'),
            product: 'Seamnex CRM',
            owner_name: 'Helena Brandt',
            owner_email: null,
          },
        ],
      ],
      ['FROM maintenance_window', [{ id: 'mw-2', scope: 'instance' }]],
      ['INSERT INTO notification', [{ id: 'n2' }]],
      ['UPDATE break_glass_session', []],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a usage row with no sample and one with no containers', async () => {
    const { db, service } = setup([
      ['FROM instance_status s', []],
      ['SELECT EXISTS', [{ present: false }]],
      ['FROM settings', []],
      [
        'instance_usage_sample',
        [
          {
            // No sample has been taken for this instance yet, so there is nothing to compare.
            id: 'i1',
            slug: 'crm',
            resources: { cpu: 1, memoryMb: 1_000, diskMb: 10_000 },
            sampled_at: null,
            cpu_milli: 999,
            memory_mb: 999,
            disk_mb: 999,
            containers: 2,
          },
          {
            // Idle is not the same as unmeasured, but an instance with no containers has no usage.
            id: 'i2',
            slug: 'blog',
            resources: { cpu: 1, memoryMb: 1_000, diskMb: 10_000 },
            sampled_at: new Date(),
            cpu_milli: 999,
            memory_mb: 999,
            disk_mb: 999,
            containers: null,
          },
        ],
      ],
      ['FROM break_glass_session', []],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 0 });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO notification'))).toBe(false);
  });

  it('treats missing counters as zero and skips an axis that declares no limit', async () => {
    const { db, service } = setup([
      ['FROM instance_status s', []],
      ['SELECT EXISTS', [{ present: false }]],
      ['FROM settings', []],
      [
        'instance_usage_sample',
        [
          {
            // An entry with no `resources` block has no denominator: a ratio against zero is not 100 %.
            id: 'i1',
            slug: 'crm',
            resources: null,
            sampled_at: new Date(),
            cpu_milli: null,
            memory_mb: null,
            disk_mb: null,
            containers: 1,
          },
        ],
      ],
      ['FROM break_glass_session', []],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 0 });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO notification'))).toBe(false);
  });

  it('skips a capacity alert already sent inside the dedupe window', async () => {
    const { db, service } = setup([
      ['FROM instance_status s', []],
      // The dedupe read answers "already sent" for the quantised capacity subject.
      ['SELECT EXISTS', [{ present: true }]],
      ['FROM settings', []],
      [
        'instance_usage_sample',
        [
          {
            id: 'i1',
            slug: 'crm',
            resources: { cpu: 1, memoryMb: 1_000, diskMb: 10_000 },
            sampled_at: new Date(),
            cpu_milli: 800,
            memory_mb: 100,
            disk_mb: 100,
            containers: 2,
          },
        ],
      ],
      ['FROM break_glass_session', []],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 0 });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO notification'))).toBe(false);
  });

  it('counts a capacity alert held back by a maintenance window as suppressed', async () => {
    const { service } = setup([
      ['FROM instance_status s', []],
      ['SELECT EXISTS', [{ present: false }]],
      ['FROM settings', []],
      [
        'instance_usage_sample',
        [
          {
            id: 'i1',
            slug: 'crm',
            resources: { cpu: 1, memoryMb: 1_000, diskMb: 10_000 },
            sampled_at: new Date(),
            cpu_milli: 900,
            memory_mb: 100,
            disk_mb: 100,
            containers: 2,
          },
        ],
      ],
      ['FROM maintenance_window', [{ id: 'mw-3', scope: 'platform' }]],
      ['INSERT INTO notification', [{ id: 'n3' }]],
      ['FROM break_glass_session', []],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flush', () => {
  it('keeps addressing the recipient stored on the notice', async () => {
    const { service } = setup([
      [
        "WHERE state = 'queued'",
        [
          {
            id: 'n1',
            severity: 'critical',
            subject: 'Break-glass access granted',
            body: 'b',
            recipient_name: 'Helena Brandt',
            recipient_address: 'helena@seamnex.local',
          },
        ],
      ],
      [
        'FROM alert_channel WHERE enabled',
        [
          { id: 'c1', type: 'email', target: 'ops@example.test', enabled: true },
          { id: 'c2', type: 'email', target: 'helena@seamnex.local', enabled: true },
        ],
      ],
      ['UPDATE notification', []],
    ]);

    await expect(service.flush()).resolves.toBe(1);

    // A retry must not fall back to the platform mailbox: the addressee is part of the record.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      To: [{ Email: 'helena@seamnex.local' }],
    });
  });
});
