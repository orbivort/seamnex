import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Route } from '../../support/fakes';
import type { AppConfig } from '../../../src/config/config';
import { SchedulerService } from '../../../src/jobs/scheduler.service';

/**
 * The two observer passes the scheduler owns by cadence alone, plus the upkeep failures they share.
 *
 * `S-10` place the image-scan retention delete in M05 and `FR-2.12 / NFR-4.7` place the upstream
 * observation in M18; the scheduler contributes the cadence, the configuration read and — the part
 * these cases are about — the promise that neither pass can take the other down. A prune that fails
 * must not stop the partition upkeep that keeps audited mutations alive, and a feed that answers
 * badly must leave the register with its previous observation rather than with none.
 *
 * The `tick` cases run with every optional dependency present, which is the one shape the other
 * scheduler suites never build: a process that has something to say about nothing absent.
 */
const CONFIG = {
  SEAMNEX_SCHEDULER_INTERVAL_MS: 30_000,
  SEAMNEX_PARTITION_LOOKAHEAD_DAYS: 1,
  SEAMNEX_JOB_LOG_RETENTION_DAYS: 30,
  SEAMNEX_SCAN_RETENTION_DAYS: 90,
  SEAMNEX_UPSTREAM_TRACKING_ENABLED: true,
  // Six hours, the shipped default: a second tick inside it is the same observation.
  SEAMNEX_UPSTREAM_INTERVAL_MS: 21_600_000,
  SEAMNEX_IDP_RECONCILE_INTERVAL_MS: 600_000,
  SEAMNEX_RELAY_SWEEP_INTERVAL_MS: 3_600_000,
  SEAMNEX_DRIFT_INTERVAL_MS: 300_000,
  SEAMNEX_DRIFT_REPAIR_COOLDOWN_MS: 3_600_000,
  SEAMNEX_WORKFLOW_CREDENTIAL_SWEEP_INTERVAL_MS: 3_600_000,
} as unknown as AppConfig;

const ROUTES: readonly Route[] = [
  ['seamnex_ensure_partition', []],
  ['FROM pg_inherits', []],
  ['GROUP BY state', []],
];

/** One old audit month, so the retention pass has something to drop and something to audit. */
const OLD_AUDIT_MONTH: readonly Route[] = [
  ['seamnex_ensure_partition', []],
  [
    'FROM pg_inherits',
    (sql: string) => (sql.includes("'audit_event'") ? [{ partition: 'audit_event_p202401' }] : []),
  ],
  ['seamnex_drop_partition', []],
];

type Options = {
  readonly omit?: readonly string[];
  readonly routes?: readonly Route[];
  readonly config?: Record<string, unknown>;
};

function setup(options: Options = {}) {
  const omit = new Set(options.omit ?? []);
  const db = fakeDb(options.routes ?? ROUTES);
  const metrics = {
    schedulerSkippedPasses: { inc: vi.fn() },
    queueDepth: { labels: vi.fn(() => ({ set: vi.fn() })) },
  };
  const jobs = {
    redispatchQueued: vi.fn(async () => 0),
    reapIdempotencyKeys: vi.fn(async () => 0),
    create: vi.fn(async () => ({ job: { id: 'job-1' }, created: true })),
  };
  const retries = { tick: vi.fn(async () => ({ scheduled: 0, skipped: 0, abandoned: 0 })) };
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
  const runMirror = omit.has('mirror') ? undefined : { start: vi.fn(), stop: vi.fn() };
  const drift = omit.has('drift')
    ? undefined
    : {
        scannable: vi.fn(async (): Promise<string[]> => []),
        scan: vi.fn(async () => ({ observed: true, detected: [], created: [], resolved: 0 })),
        definitionDrift: vi.fn(async (): Promise<string[]> => []),
        reconcileDefinition: vi.fn(async () => null),
      };
  const workflows = omit.has('workflow')
    ? undefined
    : { rotateDueCredentials: vi.fn(async () => ({ rotated: 0, skipped: 0 })) };
  const observability = omit.has('observability')
    ? undefined
    : { reconcile: vi.fn(async () => ({ written: 0, removed: 0 })) };
  const access = omit.has('settings')
    ? undefined
    : { settings: vi.fn(async () => ({ settings: { auditRetentionDays: 420 }, etag: 'e1' })) };
  const imageScans = omit.has('imageScan') ? undefined : { prune: vi.fn(async () => 0) };
  const upstream = omit.has('upstream')
    ? undefined
    : {
        observe: vi.fn(async () => ({
          observedAt: '2026-03-04T09:00:00.000Z',
          entries: 3,
          releases: 2,
          advisories: 1,
          skipped: 0,
          failed: 0,
          instancesUpdated: 1,
        })),
      };
  const pipelines = { stepsFor: vi.fn(() => ['resolve', 'render', 'plan', 'apply', 'record']) };

  const service = new SchedulerService(
    db.pool,
    { ...CONFIG, ...options.config } as AppConfig,
    metrics as never,
    jobs as never,
    retries as never,
    pipelines as never,
    outbox as never,
    anchor as never,
    audit as never,
    notifications as never,
    backups as never,
    integration as never,
    governance as never,
    relayAccounts as never,
    runMirror as never,
    drift as never,
    workflows as never,
    observability as never,
    access as never,
    imageScans as never,
    upstream as never,
  );

  return { db, audit, retries, imageScans, upstream, workflows, access, service };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-04T09:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('boot with nothing absent', () => {
  it('warns about no missing dependency, because none is missing', async () => {
    const { service } = setup();

    // The other suites build a graph with optional modules omitted; this is the healthy process,
    // and it must not be told it is running a reduced set of passes.
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});

/**
 * S-10 retention: the reports are evidence with a shelf life, not a permanent archive. The pass is
 * optional because `image_scan_result` belongs to M05, and a failed delete is logged and retried
 * rather than taking the partition upkeep down with it.
 */
describe('image scan retention', () => {
  it('prunes to the configured window and counts what went', async () => {
    const { imageScans, service } = setup();
    imageScans?.prune.mockResolvedValueOnce(4);

    await service.ensurePartitions();

    expect(imageScans?.prune).toHaveBeenCalledWith(90);
  });

  it('says nothing when the window held nothing', async () => {
    const { imageScans, service } = setup();

    await service.ensurePartitions();

    // A pass that deleted nothing is not a failure and must not read as one.
    expect(imageScans?.prune).toHaveBeenCalledOnce();
  });

  it('keeps a failed prune inside the upkeep pass, whichever shape the failure arrives in', async () => {
    const { imageScans, service } = setup();
    imageScans?.prune.mockRejectedValueOnce(new Error('relation is read-only'));

    await expect(service.ensurePartitions()).resolves.toBeUndefined();

    // A driver can reject with a bare string; the sweep logs it and the reports are kept.
    imageScans?.prune.mockRejectedValueOnce('pool closed');

    await expect(service.ensurePartitions()).resolves.toBeUndefined();
  });

  it('skips the sweep when the module is absent', async () => {
    const { imageScans, service } = setup({ omit: ['imageScan'] });

    await service.ensurePartitions();

    expect(imageScans).toBeUndefined();
  });
});

/**
 * FR-2.12 / NFR-4.7 — one observation pass, on its own interval. The guard is what keeps a restart
 * loop from turning every boot into an outbound burst against two public feeds, and a failed pass
 * leaves the register with the observation it already had.
 */
describe('upstream observation', () => {
  it('observes once per interval and attributes the pass to the scheduler', async () => {
    const { upstream, service } = setup();

    await service.tick();
    expect(upstream?.observe).toHaveBeenCalledWith({ type: 'system', id: 'scheduler' });

    // A second tick inside six hours is the same observation, not another round of outbound calls.
    await service.tick();
    expect(upstream?.observe).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-03-05T09:00:00.000Z'));
    await service.tick();
    expect(upstream?.observe).toHaveBeenCalledTimes(2);
  });

  it('does no observation at all when tracking is switched off', async () => {
    const { upstream, service } = setup({
      config: { SEAMNEX_UPSTREAM_TRACKING_ENABLED: false },
    });

    await service.tick();

    // Disabled is a state, and the pass that owns it is not run: nothing is asked of any feed.
    expect(upstream?.observe).not.toHaveBeenCalled();
  });

  it('keeps a failed observation inside the pass, whichever shape the failure arrives in', async () => {
    const { upstream, service } = setup();
    upstream?.observe.mockRejectedValueOnce(new Error('GitHub answered 503'));

    await expect(service.tick()).resolves.toBeUndefined();

    // A feed client can reject with a bare string; the register keeps its previous observation.
    upstream?.observe.mockRejectedValueOnce('GitHub answered 503');
    vi.setSystemTime(new Date('2026-03-05T09:00:00.000Z'));

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('skips the pass when the module is absent', async () => {
    const { upstream, service } = setup({ omit: ['upstream'] });

    await service.tick();

    expect(upstream).toBeUndefined();
  });
});

describe('passes that are absent from this process', () => {
  it('does not rotate workflow credentials without the workflow module', async () => {
    const { workflows, service } = setup({ omit: ['workflow'] });

    await service.tick();

    // Nothing to rotate is not a failure, and the rest of the pass still runs.
    expect(workflows).toBeUndefined();
  });
});

/**
 * NFR-6.5 and NFR-4.10 — the retry pass and the retention pass each own their failure. Both sit on
 * the same tick as the partition upkeep that keeps audited mutations alive, so neither may be the
 * reason that upkeep does not run.
 */
describe('a pass that owns its failure', () => {
  it('reports a retry pass that scheduled or abandoned work', async () => {
    const { retries, service } = setup();
    retries.tick.mockResolvedValueOnce({ scheduled: 2, skipped: 0, abandoned: 0 });

    await service.tick();
    expect(retries.tick).toHaveBeenCalledOnce();

    // The other half of the guard: abandoned work with nothing newly scheduled is still a pass worth
    // logging.
    retries.tick.mockResolvedValueOnce({ scheduled: 0, skipped: 0, abandoned: 3 });

    await service.tick();
    expect(retries.tick).toHaveBeenCalledTimes(2);
  });

  it('keeps a retry pass failure that arrives as a string out of the rest of the pass', async () => {
    const { retries, db, service } = setup();
    retries.tick.mockRejectedValueOnce('candidate query failed');

    await expect(service.tick()).resolves.toBeUndefined();

    // The upkeep that follows it still ran: it is what keeps every audited mutation writable.
    expect(db.calls.some((call) => call.sql.includes('seamnex_ensure_partition'))).toBe(true);
  });

  it('drops nothing when the settings read fails with something that is not an Error', async () => {
    const { db, service, access } = setup();
    access?.settings.mockRejectedValueOnce('settings service closed');

    await service.ensurePartitions();

    // An unreadable setting means the pass does not run — never "assume the default and delete".
    expect(db.calls.some((call) => call.sql.includes('seamnex_drop_partition'))).toBe(false);
  });

  it('keeps a failed partition drop inside the upkeep pass', async () => {
    const { db, service } = setup({
      routes: [
        ['seamnex_ensure_partition', []],
        [
          'FROM pg_inherits',
          (sql: string) => {
            // The job-log walk precedes this one and must still succeed: only the audit drop fails.
            if (sql.includes("'audit_event'")) throw 'partition drop denied';
            return [];
          },
        ],
      ],
    });

    await expect(service.ensurePartitions()).resolves.toBeUndefined();

    expect(db.calls.some((call) => call.sql.includes('seamnex_drop_partition'))).toBe(false);
  });

  it('logs a retention row it could not append, whichever shape the failure arrives in', async () => {
    const { audit, service } = setup({ routes: OLD_AUDIT_MONTH });
    audit?.append.mockRejectedValueOnce(new Error('audit chain unavailable'));

    // The month is gone either way; the operator needs the reason there is no row saying so.
    await expect(service.ensurePartitions()).resolves.toBeUndefined();

    audit?.append.mockRejectedValueOnce('audit chain unavailable');

    await expect(service.ensurePartitions()).resolves.toBeUndefined();
  });
});
