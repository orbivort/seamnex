import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../support/fakes';
import type { AppConfig } from '../../../src/config/config';
import { AppError } from '../../../src/common/problem/app-error';
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
  SEAMNEX_DRIFT_INTERVAL_MS: 300_000,
  SEAMNEX_DRIFT_REPAIR_COOLDOWN_MS: 3_600_000,
  SEAMNEX_WORKFLOW_CREDENTIAL_SWEEP_INTERVAL_MS: 3_600_000,
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
    create: vi.fn(async () => ({ job: { id: 'job-drift-1' }, created: true })),
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
  const drift = omit.has('drift')
    ? undefined
    : {
        scan: vi.fn(
          async (): Promise<{
            observed: boolean;
            detected: {
              instanceId: string;
              varName: string;
              kind: 'missing' | 'undeclared' | 'mismatch';
              direction: 'repo_ahead' | 'runtime_ahead' | 'unknown';
            }[];
            created: string[];
            resolved: number;
          }> => ({ observed: true, detected: [], created: [], resolved: 0 }),
        ),
        scannable: vi.fn(async (): Promise<string[]> => []),
        definitionDrift: vi.fn(async (): Promise<string[]> => []),
        openVarNames: vi.fn(async () => new Set<string>()),
        reconcileDefinition: vi.fn(
          async (): Promise<{ path: string; contentHash: string } | null> => null,
        ),
      };
  // The repair queues the same stage list an operator's reconfigure uses.
  const pipelines = { stepsFor: vi.fn(() => ['resolve', 'render', 'plan', 'apply', 'record']) };
  const workflows = omit.has('workflow')
    ? undefined
    : { rotateDueCredentials: vi.fn(async () => ({ rotated: 0, skipped: 0 })) };

  const service = new SchedulerService(
    db.pool,
    CONFIG,
    metrics as never,
    jobs as never,
    pipelines as never,
    outbox as never,
    anchor as never,
    audit as never,
    notifications as never,
    backups as never,
    integration as never,
    governance as never,
    relayAccounts as never,
    undefined,
    drift as never,
    workflows as never,
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
    drift,
    pipelines,
    workflows,
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

  /**
   * NFR-4.14 — the rotation is a mint, a credential, a push and a commit per workflow, so it runs on
   * its own interval rather than on every scheduler pass.
   */
  it('rotates workflow credentials on its own interval, not on every pass', async () => {
    const { workflows, service } = setup({ routes: FULL_ROUTES });

    await service.tick();
    expect(workflows?.rotateDueCredentials).toHaveBeenCalledOnce();

    await service.tick();
    expect(workflows?.rotateDueCredentials).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-03-04T10:00:01.000Z'));
    await service.tick();
    expect(workflows?.rotateDueCredentials).toHaveBeenCalledTimes(2);
  });

  it('keeps the pass going when a rotation fails', async () => {
    const { workflows, outbox, service } = setup({ routes: FULL_ROUTES });
    workflows?.rotateDueCredentials.mockRejectedValueOnce(new Error('broker down'));

    await expect(service.tick()).resolves.toBeUndefined();
    // The passes after it still ran: one product that cannot mint must not stop the platform.
    expect(outbox.dispatchBatch).toHaveBeenCalledOnce();
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

describe('drift pass', () => {
  const ROUTES: Parameters<typeof fakeDb>[0] = [
    ['seamnex_ensure_partition', []],
    ['FROM pg_inherits', []],
    ['GROUP BY state', []],
  ];

  const finding = (direction: 'repo_ahead' | 'runtime_ahead' | 'unknown') => ({
    instanceId: 'inst-1',
    varName: 'MAIL_HOST',
    kind: 'mismatch' as const,
    direction,
  });

  it('runs on its own cadence rather than on every pass', async () => {
    const { drift, service } = setup({ routes: ROUTES });

    await service.tick();
    await service.tick();
    expect(drift?.scannable).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-03-04T09:05:00.000Z'));
    await service.tick();
    expect(drift?.scannable).toHaveBeenCalledTimes(2);
  });

  it('audits a new finding and queues the reconfigure the repository can repair', async () => {
    const { audit, drift, jobs, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockResolvedValue({
      observed: true,
      detected: [finding('repo_ahead')],
      created: ['MAIL_HOST'],
      resolved: 0,
    });

    await service.tick();

    expect(audit?.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.drift.detected',
        targetId: 'inst-1',
        detail: { variables: ['MAIL_HOST'] },
      }),
    );
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'reconfigure',
        instanceId: 'inst-1',
        requestedBy: 'system',
        payload: { action: 'reconfigure', reason: 'environment-drift', variables: ['MAIL_HOST'] },
        steps: ['resolve', 'render', 'plan', 'apply', 'record'],
      }),
    );
    expect(audit?.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.drift.repair_requested',
        detail: { jobId: 'job-drift-1', variables: ['MAIL_HOST'] },
      }),
    );
  });

  it('records a runtime-side change without reverting it', async () => {
    const { audit, drift, jobs, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockResolvedValue({
      observed: true,
      detected: [finding('runtime_ahead')],
      created: ['MAIL_HOST'],
      resolved: 0,
    });

    await service.tick();

    expect(jobs.create).not.toHaveBeenCalled();
    expect(audit?.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.drift.detected' }),
    );
  });

  it('repairs one instance at most once per cooldown', async () => {
    const { drift, jobs, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockResolvedValue({
      observed: true,
      detected: [finding('repo_ahead')],
      created: [],
      resolved: 0,
    });

    await service.tick();
    vi.setSystemTime(new Date('2026-03-04T09:05:00.000Z'));
    await service.tick();

    expect(jobs.create).toHaveBeenCalledOnce();
  });

  it('treats a busy instance as expected and records no repair', async () => {
    const { audit, drift, jobs, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockResolvedValue({
      observed: true,
      detected: [finding('repo_ahead')],
      created: [],
      resolved: 0,
    });
    jobs.create.mockRejectedValueOnce(
      new AppError({ code: 'INSTANCE_BUSY', status: 409, detail: 'busy' }),
    );

    await expect(service.tick()).resolves.toBeUndefined();

    expect(audit?.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.drift.repair_requested' }),
    );
  });

  it('re-commits definition drift and audits the repair', async () => {
    const { audit, drift, service } = setup({ routes: ROUTES });
    drift?.definitionDrift.mockResolvedValue(['inst-2']);
    drift?.reconcileDefinition.mockResolvedValue({
      path: 'instances/shop/instance.yaml',
      contentHash: 'abc',
    });

    await service.tick();

    expect(drift?.reconcileDefinition).toHaveBeenCalledWith('inst-2', 'system');
    expect(audit?.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.definition.reconciled',
        targetId: 'inst-2',
        detail: { path: 'instances/shop/instance.yaml', contentHash: 'abc' },
      }),
    );
  });

  it('keeps the definition flag when the repair fails', async () => {
    const { audit, drift, service } = setup({ routes: ROUTES });
    drift?.definitionDrift.mockResolvedValue(['inst-2']);
    drift?.reconcileDefinition.mockRejectedValueOnce(new Error('read-only file system'));

    await expect(service.tick()).resolves.toBeUndefined();

    expect(audit?.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.definition.reconciled' }),
    );
  });

  it('skips an instance it could not observe', async () => {
    const { audit, drift, jobs, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockResolvedValue({ observed: false, detected: [], created: [], resolved: 0 });

    await service.tick();

    expect(jobs.create).not.toHaveBeenCalled();
    expect(audit?.append).not.toHaveBeenCalled();
  });

  it('keeps a failing scan out of the pass', async () => {
    const { drift, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockRejectedValueOnce(new Error('database down'));

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('keeps a scan failure that arrives as a string out of the pass', async () => {
    const { drift, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockRejectedValueOnce('driver closed the socket');

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('keeps a definition repair failure that arrives as a string out of the pass', async () => {
    const { drift, service } = setup({ routes: ROUTES });
    drift?.definitionDrift.mockResolvedValue(['inst-2']);
    drift?.reconcileDefinition.mockRejectedValueOnce('read-only file system');

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('keeps a queue failure that arrives as a string inside the pass', async () => {
    const { drift, jobs, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockResolvedValue({
      observed: true,
      detected: [finding('repo_ahead')],
      created: [],
      resolved: 0,
    });
    jobs.create.mockRejectedValueOnce('pool closed');

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('is skipped when the module is absent', async () => {
    const { drift, service } = setup({ omit: ['drift'], routes: ROUTES });

    await service.tick();

    expect(drift).toBeUndefined();
  });

  it('works without an audit chain to write to', async () => {
    const { drift, jobs, service } = setup({ omit: ['audit'], routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockResolvedValue({
      observed: true,
      detected: [finding('repo_ahead')],
      created: ['MAIL_HOST'],
      resolved: 0,
    });

    await service.tick();

    expect(jobs.create).toHaveBeenCalledOnce();
  });

  it('leaves the definition alone when the instance stopped carrying the flag', async () => {
    const { audit, drift, service } = setup({ routes: ROUTES });
    drift?.definitionDrift.mockResolvedValue(['inst-2']);
    drift?.reconcileDefinition.mockResolvedValue(null);

    await service.tick();

    expect(audit?.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.definition.reconciled' }),
    );
  });

  it('queues nothing when no pipeline registers the reconfigure stages', async () => {
    const { drift, jobs, pipelines, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockResolvedValue({
      observed: true,
      detected: [finding('repo_ahead')],
      created: [],
      resolved: 0,
    });
    pipelines.stepsFor.mockReturnValue([]);

    await service.tick();

    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('keeps an unexpected queue failure inside the pass', async () => {
    const { audit, drift, jobs, service } = setup({ routes: ROUTES });
    drift?.scannable.mockResolvedValue(['inst-1']);
    drift?.scan.mockResolvedValue({
      observed: true,
      detected: [finding('repo_ahead')],
      created: [],
      resolved: 0,
    });
    jobs.create.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(service.tick()).resolves.toBeUndefined();

    expect(audit?.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.drift.repair_requested' }),
    );
  });
});
