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
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a break-glass notice that was already sent inside the dedupe window', async () => {
    const { db, service } = setup([
      ['FROM instance_status s', []],
      // `already sent`: the dedupe read is what makes a restarted scheduler idempotent.
      ['SELECT EXISTS', [{ present: true }]],
      [
        'FROM break_glass_session',
        [{ id: 'abcdef123456', state: 'expired', instance_id: null, expires_at: null }],
      ],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 0 });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO notification'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts a break-glass notice held back by a maintenance window as suppressed', async () => {
    const { service } = setup([
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
        ],
      ],
      ['FROM maintenance_window', [{ id: 'mw-2', scope: 'instance' }]],
      ['INSERT INTO notification', [{ id: 'n2' }]],
    ]);

    const result = await service.evaluate();

    expect(result).toEqual({ sent: 0, suppressed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
