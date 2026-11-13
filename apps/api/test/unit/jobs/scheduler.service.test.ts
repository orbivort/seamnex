import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../support/fakes';
import type { AppConfig } from '../../../src/config/config';
import { SchedulerService } from '../../../src/jobs/scheduler.service';

/**
 * The scheduler is the only place repeatable platform work runs, so two properties matter: a pass
 * that overlaps its predecessor is skipped (two schedulers would double every anchor and every
 * partition), and the optional passes are skipped *visibly* — an absent module used to be
 * indistinguishable from a healthy one. Partition upkeep runs at boot of every role, because a
 * missing partition refuses every audited mutation in a process that is still serving.
 */
const CONFIG = {
  SEAMNEX_SCHEDULER_INTERVAL_MS: 30_000,
  SEAMNEX_PARTITION_LOOKAHEAD_DAYS: 2,
  SEAMNEX_IDP_RECONCILE_INTERVAL_MS: 600_000,
  SEAMNEX_RELAY_SWEEP_INTERVAL_MS: 3_600_000,
  SEAMNEX_JOB_LOG_RETENTION_DAYS: 30,
} as unknown as AppConfig;

function setup(options: { omit?: readonly string[]; routes?: Parameters<typeof fakeDb>[0] } = {}) {
  const db = fakeDb(options.routes ?? []);
  const omit = new Set(options.omit ?? []);
  const unsent = vi.fn();
  const set = vi.fn();
  const metrics = {
    schedulerSkippedPasses: { inc: unsent },
    queueDepth: { labels: vi.fn(() => ({ set })) },
  };
  const jobs = {
    redispatchQueued: vi.fn(async () => 0),
    reapIdempotencyKeys: vi.fn(async () => 0),
  };
  const outbox = { dispatchBatch: vi.fn(async (): Promise<void> => undefined) };
  const anchor = { run: vi.fn(async () => undefined) };
  const audit = omit.has('audit') ? undefined : { append: vi.fn(async () => undefined) };
  const notifications = omit.has('notification')
    ? undefined
    : {
        evaluate: vi.fn(async () => ({ sent: 0, suppressed: 0 })),
        flush: vi.fn(async () => undefined),
      };
  const backups = omit.has('backup') ? undefined : { tickSchedules: vi.fn(async () => undefined) };
  const integration = omit.has('integration')
    ? undefined
    : { reconcileIdentityNetworks: vi.fn(async () => undefined) };
  const governance = omit.has('governance')
    ? undefined
    : { expireOverdueBreakGlass: vi.fn(async () => [] as { id: string }[]) };
  const relayAccounts = omit.has('relay') ? undefined : { sweep: vi.fn(async () => undefined) };

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
    relayAccounts as never,
  );
  return {
    db,
    jobs,
    outbox,
    anchor,
    audit,
    notifications,
    backups,
    integration,
    governance,
    relayAccounts,
    metrics,
    set,
    unsent,
    service,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-04T09:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('boot', () => {
  it('names the passes this process will not run', async () => {
    const { service } = setup({
      omit: ['audit', 'notification', 'backup', 'integration'],
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
      ],
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    // The partitions are still created: this role serves audited mutations too.
    expect(service).toBeDefined();
  });

  it('keeps going when partition upkeep fails at boot, and says what it means', async () => {
    const { service } = setup({
      routes: [
        [
          'seamnex_ensure_partition',
          () => {
            throw 'permission denied';
          },
        ],
      ],
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('the pass', () => {
  const FULL_ROUTES: Parameters<typeof fakeDb>[0] = [
    ['seamnex_ensure_partition', []],
    ['FROM pg_inherits', []],
    [
      'GROUP BY state',
      [
        { state: 'queued', count: '3' },
        { state: 'running', count: '1' },
      ],
    ],
  ];

  it('runs every pass in order', async () => {
    const {
      db,
      jobs,
      outbox,
      anchor,
      notifications,
      backups,
      integration,
      governance,
      set,
      service,
    } = setup({ routes: FULL_ROUTES });

    await service.tick();

    expect(outbox.dispatchBatch).toHaveBeenCalledOnce();
    expect(jobs.redispatchQueued).toHaveBeenCalledOnce();
    expect(jobs.reapIdempotencyKeys).toHaveBeenCalledOnce();
    expect(anchor.run).toHaveBeenCalledOnce();
    expect(governance?.expireOverdueBreakGlass).toHaveBeenCalledOnce();
    expect(notifications?.evaluate).toHaveBeenCalledOnce();
    expect(notifications?.flush).toHaveBeenCalledOnce();
    expect(backups?.tickSchedules).toHaveBeenCalledOnce();
    expect(integration?.reconcileIdentityNetworks).toHaveBeenCalledOnce();
    // The queue of record is the database: its depth is what an operator sees.
    expect(set).toHaveBeenCalledTimes(2);
    // Three job-log days (0..lookahead) and three audit months.
    expect(db.calls.filter((call) => call.sql.includes('seamnex_ensure_partition'))).toHaveLength(
      6,
    );
  });

  it('skips a pass whose predecessor is still running, and counts the skip', async () => {
    const { unsent, outbox, service } = setup({ routes: FULL_ROUTES });
    let release: (() => void) | undefined;
    outbox.dispatchBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );

    const first = service.tick();
    await service.tick();
    expect(unsent).toHaveBeenCalledOnce();

    release?.();
    await first;
  });

  it('resets the guard after a failed pass', async () => {
    const { outbox, service } = setup({ routes: FULL_ROUTES });
    outbox.dispatchBatch.mockRejectedValueOnce(new Error('outbox down'));

    await expect(service.tick()).resolves.toBeUndefined();
    await expect(service.tick()).resolves.toBeUndefined();
    expect(outbox.dispatchBatch).toHaveBeenCalledTimes(2);
  });

  it('records a non-Error pass failure without throwing', async () => {
    const { outbox, service } = setup({ routes: FULL_ROUTES });
    outbox.dispatchBatch.mockRejectedValueOnce('outbox down');

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('anchors once per day, not once per pass', async () => {
    const { anchor, service } = setup({ routes: FULL_ROUTES });

    await service.tick();
    await service.tick();
    expect(anchor.run).toHaveBeenCalledOnce();

    // The anchor covers a day; the next day needs its own.
    vi.setSystemTime(new Date('2026-03-05T09:00:00.000Z'));
    await service.tick();
    expect(anchor.run).toHaveBeenCalledTimes(2);
    expect(anchor.run).toHaveBeenLastCalledWith(new Date('2026-03-05T00:00:00.000Z'));
  });
});

describe('optional passes', () => {
  it('does nothing when the modules are absent', async () => {
    const { notifications, backups, integration, governance, service } = setup({
      omit: ['audit', 'notification', 'backup', 'integration', 'governance'],
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
        ['GROUP BY state', []],
      ],
    });

    await service.tick();

    expect(notifications).toBeUndefined();
    expect(backups).toBeUndefined();
    expect(integration).toBeUndefined();
    expect(governance).toBeUndefined();
  });

  it('writes the evidence for every grant it closed', async () => {
    const { audit, governance, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
        ['GROUP BY state', []],
      ],
    });
    governance?.expireOverdueBreakGlass.mockResolvedValueOnce([
      { id: 'grant-1' },
      { id: 'grant-2' },
    ]);

    await service.tick();

    expect(audit?.append).toHaveBeenCalledTimes(2);
    expect(audit?.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'breakglass.expired',
        targetType: 'break_glass_session',
        targetId: 'grant-1',
      }),
    );
  });

  it('never closes a grant without an audit chain to record why', async () => {
    const { governance, service } = setup({
      omit: ['audit'],
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
        ['GROUP BY state', []],
      ],
    });

    await service.tick();

    expect(governance?.expireOverdueBreakGlass).not.toHaveBeenCalled();
  });

  it('evaluates notifications at most every five minutes', async () => {
    const { notifications, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
        ['GROUP BY state', []],
      ],
    });
    notifications?.evaluate.mockResolvedValue({ sent: 2, suppressed: 1 });

    await service.tick();
    await service.tick();
    expect(notifications?.evaluate).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-03-04T09:06:00.000Z'));
    await service.tick();
    expect(notifications?.evaluate).toHaveBeenCalledTimes(2);
  });

  it('keeps a backup failure and a reconciliation failure inside their own passes', async () => {
    const { backups, integration, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
        ['GROUP BY state', []],
      ],
    });
    backups?.tickSchedules.mockRejectedValueOnce(new Error('runner down'));
    integration?.reconcileIdentityNetworks.mockRejectedValueOnce('docker gone');

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('reconciles the identity networks on its own cadence', async () => {
    const { integration, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
        ['GROUP BY state', []],
      ],
    });

    await service.tick();
    await service.tick();
    expect(integration?.reconcileIdentityNetworks).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-03-04T09:11:00.000Z'));
    await service.tick();
    expect(integration?.reconcileIdentityNetworks).toHaveBeenCalledTimes(2);
  });
});

describe('partition upkeep', () => {
  it('creates the daily job-log and monthly audit partitions ahead of the window', async () => {
    const { db, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
      ],
    });

    await service.ensurePartitions();

    const calls = db.calls.filter((call) => call.sql.includes('seamnex_ensure_partition'));
    // Three job-log days (0..2) and three audit months (0..2).
    expect(calls).toHaveLength(6);
    expect(calls[0]?.params).toEqual([
      'job_log',
      'job_log_p20260304',
      new Date('2026-03-04T00:00:00.000Z'),
      new Date('2026-03-05T00:00:00.000Z'),
    ]);
    expect(calls[3]?.params.slice(0, 2)).toEqual(['audit_event', 'audit_event_p202603']);
  });

  it('drops only the job-log partitions past retention', async () => {
    const { db, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        [
          'FROM pg_inherits',
          [
            { partition: 'job_log_p20260101' },
            { partition: 'job_log_p20260301' },
            { partition: 'job_log_other' },
          ],
        ],
        ['seamnex_drop_partition', []],
      ],
    });

    await service.ensurePartitions();

    const drops = db.calls.filter((call) => call.sql.includes('seamnex_drop_partition'));
    // 2026-01-01 is past the 30-day window; 2026-03-01 is not; the unparseable name is left alone.
    expect(drops).toHaveLength(1);
    expect(drops[0]?.params).toEqual(['job_log', 'job_log_p20260101']);
  });
});

describe('the interval', () => {
  it('ticks immediately and then on the configured interval', async () => {
    const { outbox, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
        ['GROUP BY state', []],
      ],
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.dispatchBatch).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(outbox.dispatchBatch).toHaveBeenCalledTimes(2);
  });

  it('starts once however often it is asked, and stops twice safely', async () => {
    const { outbox, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
        ['GROUP BY state', []],
      ],
    });

    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.stop();
    service.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(outbox.dispatchBatch).toHaveBeenCalledOnce();
  });

  it('stops on application shutdown', async () => {
    const { outbox, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        ['FROM pg_inherits', []],
        ['GROUP BY state', []],
      ],
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(outbox.dispatchBatch).toHaveBeenCalledOnce();
  });
});

/**
 * ADR-BE-22's provisioning and rotation pass is optional (a build without M24 still schedules work)
 * and has its own interval: it talks to a product API over the instance network, so running it on
 * every 30-second tick would put a network round trip per entitlement on the busiest timer.
 */
describe('the relay account sweep', () => {
  const ROUTES: Parameters<typeof fakeDb>[0] = [
    ['seamnex_ensure_partition', []],
    ['FROM pg_inherits', []],
    ['GROUP BY state', []],
  ];

  it('runs on its own cadence rather than on every pass', async () => {
    const { relayAccounts, service } = setup({ routes: ROUTES });

    await service.tick();
    await service.tick();

    expect(relayAccounts?.sweep).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-03-04T10:00:00.000Z'));
    await service.tick();

    expect(relayAccounts?.sweep).toHaveBeenCalledTimes(2);
  });

  it('keeps a failing sweep out of the pass', async () => {
    const { relayAccounts, service } = setup({ routes: ROUTES });
    relayAccounts?.sweep.mockRejectedValueOnce(new Error('product unavailable'));

    await expect(service.tick()).resolves.toBeUndefined();

    relayAccounts?.sweep.mockRejectedValueOnce('product unavailable');
    vi.setSystemTime(new Date('2026-03-04T11:00:00.000Z'));

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('is skipped without comment when the module is absent', async () => {
    const { relayAccounts, service } = setup({ omit: ['relay'], routes: ROUTES });

    await service.tick();

    expect(relayAccounts).toBeUndefined();
  });
});
