import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../support/fakes';
import type { AppConfig } from '../../../src/config/config';
import { SchedulerService } from '../../../src/jobs/scheduler.service';

/**
 * The scheduler's three failure lines, each of which is kept inside the pass that owns it. The main
 * suite covers the string form; an `Error` is what a driver, a Docker client or the audit chain
 * actually throws, and partition upkeep failing at boot is exactly the moment a process must still
 * start and serve rather than exit.
 */
const CONFIG = {
  SEAMNEX_SCHEDULER_INTERVAL_MS: 30_000,
  SEAMNEX_PARTITION_LOOKAHEAD_DAYS: 1,
  SEAMNEX_IDP_RECONCILE_INTERVAL_MS: 600_000,
  SEAMNEX_JOB_LOG_RETENTION_DAYS: 30,
} as unknown as AppConfig;

const ROUTES: Parameters<typeof fakeDb>[0] = [
  ['seamnex_ensure_partition', []],
  ['FROM pg_inherits', []],
  ['GROUP BY state', []],
];

function setup(routes: Parameters<typeof fakeDb>[0] = ROUTES) {
  const db = fakeDb(routes);
  const metrics = {
    schedulerSkippedPasses: { inc: vi.fn() },
    queueDepth: { labels: vi.fn(() => ({ set: vi.fn() })) },
  };
  const jobs = {
    redispatchQueued: vi.fn(async () => 0),
    reapIdempotencyKeys: vi.fn(async () => 0),
  };
  const outbox = { dispatchBatch: vi.fn(async (): Promise<void> => undefined) };
  const anchor = { run: vi.fn(async () => undefined) };
  const audit = { append: vi.fn(async () => undefined) };
  const notifications = {
    evaluate: vi.fn(async () => ({ sent: 0, suppressed: 0 })),
    flush: vi.fn(async () => undefined),
  };
  const backups = { tickSchedules: vi.fn(async () => undefined) };
  const integration = { reconcileIdentityNetworks: vi.fn(async () => undefined) };
  const governance = { expireOverdueBreakGlass: vi.fn(async () => [] as { id: string }[]) };

  const service = new SchedulerService(
    db.pool,
    CONFIG,
    metrics as never,
    jobs as never,
    outbox as never,
    anchor as never,
    audit as never,
    notifications as never,
    backups as never,
    integration as never,
    governance as never,
  );
  return { db, jobs, notifications, backups, integration, service };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-04T09:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('partition upkeep that fails with an Error', () => {
  it('still boots, because this role is serving audited mutations regardless', async () => {
    const { db, service } = setup([
      [
        'seamnex_ensure_partition',
        () => {
          // A missing DDL grant arrives as an Error from the driver, not as a string.
          throw new Error('must be owner of table job_log');
        },
      ],
    ]);

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    // It tried, it failed, and the process is still up: no throw, no exit.
    expect(db.calls.some((call) => call.sql.includes('seamnex_ensure_partition'))).toBe(true);
  });

  it('swallows the same Error inside a pass so the remaining passes still run', async () => {
    const { db, service } = setup([
      [
        'seamnex_ensure_partition',
        () => {
          throw new Error('must be owner of table job_log');
        },
      ],
    ]);

    await expect(service.tick()).resolves.toBeUndefined();

    expect(db.calls.some((call) => call.sql.includes('GROUP BY state'))).toBe(false);
  });
});

describe('a pass that owns its failure', () => {
  it('keeps an Error from the identity reconciliation inside that pass', async () => {
    const { backups, integration, notifications, service } = setup();
    integration.reconcileIdentityNetworks.mockRejectedValueOnce(new Error('docker socket gone'));

    await expect(service.tick()).resolves.toBeUndefined();

    // The backup pass and the notification flush had already run: the tick was not aborted.
    expect(backups.tickSchedules).toHaveBeenCalledOnce();
    expect(notifications.flush).toHaveBeenCalledOnce();
  });

  it('keeps a non-Error backup failure inside that pass', async () => {
    const { jobs, backups, service } = setup();
    backups.tickSchedules.mockRejectedValueOnce('runner down');

    await expect(service.tick()).resolves.toBeUndefined();

    expect(jobs.reapIdempotencyKeys).toHaveBeenCalledOnce();
  });
});
