import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { fakeDb, type Route } from '../../../support/fakes';
import { PostgresBackupRestoreService } from '../../../../src/modules/m16-backup-restore/backup-restore.service';

/**
 * The 4C facade: every mutation records a row, closes or opens the restore gate and hands the work to
 * a job. Nothing here blocks on a dump, so what the tests own is the *refusal* paths — a restore of a
 * capture that never finished, a second platform restore while one is running, a gate left down
 * because the job could not be created — plus the projections the screen reads.
 */

type JobInput = Record<string, unknown>;

function setup(routes: readonly Route[] = []) {
  const db = fakeDb(routes);
  const audit = {
    lockChain: vi.fn(async () => undefined),
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
  };
  const integration = { setAllRoutesGated: vi.fn(async () => undefined) };
  const outbox = { emit: vi.fn(async () => undefined) };
  const jobs = {
    create: vi.fn<(input: JobInput) => Promise<{ job: { id: string }; created: boolean }>>(
      async () => ({ job: { id: 'job-1' }, created: true }),
    ),
  };
  const pipelines = { stepsFor: vi.fn(() => ['Dump databases', 'Encrypt and upload']) };
  const docker = { start: vi.fn(async (_containerId: string) => undefined) };
  const service = new PostgresBackupRestoreService(
    db.pool,
    audit as never,
    integration as never,
    outbox as never,
    jobs as never,
    pipelines as never,
    docker as never,
  );
  return { db, audit, integration, outbox, jobs, pipelines, docker, service };
}

function backupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bkp-1',
    kind: 'instance',
    instance_id: 'inst-1',
    render_set_id: 'rs-1',
    state: 'succeeded',
    started_at: new Date('2026-01-01T00:00:00.000Z'),
    finished_at: new Date('2026-01-01T00:05:00.000Z'),
    size_bytes: '1024',
    object_key: 'bkp-1/manifest.json',
    manifest: { includes: ['database', 'volumes'] },
    verified_at: null,
    verify_method: null,
    error_code: null,
    ...overrides,
  };
}

function restoreRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    backup_id: 'bkp-p',
    phase: 'complete',
    state: 'succeeded',
    started_at: new Date('2026-01-01T00:00:00.000Z'),
    finished_at: new Date('2026-01-01T01:00:00.000Z'),
    login_verified_at: new Date('2026-01-01T00:30:00.000Z'),
    concurrency: 6,
    justification: 'restoring after the storage incident',
    detail: {},
    requested_by_name: 'Ada Lovelace',
    ...overrides,
  };
}

const INSTANCE: Route = [
  'SELECT id, slug FROM instance WHERE id = $1 AND deleted_at IS NULL',
  [{ id: 'inst-1', slug: 'crm' }],
];
const RENDER_SET: Route = ['FROM instance i WHERE i.id = $1', [{ id: 'rs-1' }]];
const POSTURE_SCHEDULE: Route = [
  'SELECT cadence, timezone, next_run_at FROM backup_schedule',
  [{ cadence: 'daily', timezone: 'UTC', next_run_at: null }],
];
const POSTURE_LATEST: Route = ['SELECT finished_at, verified_at FROM backup', []];
const GATE_COUNT_OPEN: Route = ['count(*)::text AS count FROM instance_route', [{ count: '0' }]];

function scheduleRoutes(overrides: readonly Route[] = []): Route[] {
  return [
    INSTANCE,
    ['INSERT INTO backup_schedule', []],
    POSTURE_SCHEDULE,
    POSTURE_LATEST,
    ...overrides,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('backup register', () => {
  it('projects a stored backup into the shape the screen renders', async () => {
    const { db, service } = setup([
      ['SELECT * FROM backup WHERE instance_id = $1', [backupRow()]],
      ['SELECT slug FROM instance', [{ slug: 'crm' }]],
    ]);

    const [backup] = await service.backups('inst-1');

    expect(backup).toEqual({
      id: 'bkp-1',
      kind: 'instance',
      instanceId: 'inst-1',
      instanceLabel: 'crm',
      state: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:05:00.000Z',
      sizeBytes: 1024,
      objectKey: 'bkp-1/manifest.json',
      includes: ['database', 'volumes'],
      verifiedAt: null,
      verifyMethod: null,
      renderSetId: 'rs-1',
    });
    expect(db.calls[0]?.params).toEqual(['inst-1']);
  });

  it('carries the verification evidence when the backup was verified', async () => {
    const { service } = setup([
      [
        'SELECT * FROM backup WHERE instance_id = $1',
        [
          backupRow({
            verified_at: new Date('2026-01-02T00:00:00.000Z'),
            verify_method: 'scratch-stack smoke test',
          }),
        ],
      ],
      ['SELECT slug FROM instance', [{ slug: 'crm' }]],
    ]);

    const [backup] = await service.backups('inst-1');

    expect(backup).toMatchObject({
      verifiedAt: '2026-01-02T00:00:00.000Z',
      verifyMethod: 'scratch-stack smoke test',
    });
  });

  it('labels a platform backup as platform when no instance row answers the lookup', async () => {
    const { service } = setup([
      [
        'SELECT * FROM backup WHERE instance_id = $1',
        [backupRow({ kind: 'platform', instance_id: null })],
      ],
      ['SELECT slug FROM instance', []],
    ]);

    const [backup] = await service.backups('inst-1');

    expect(backup?.instanceLabel).toBe('platform');
  });

  it('defaults every optional column instead of emitting undefined', async () => {
    const { service } = setup([
      [
        'SELECT * FROM backup WHERE instance_id = $1',
        [
          backupRow({
            instance_id: 'inst-gone',
            manifest: {},
            size_bytes: null,
            object_key: null,
            render_set_id: null,
            finished_at: null,
          }),
        ],
      ],
      ['SELECT slug FROM instance', []],
    ]);

    const [backup] = await service.backups('inst-gone');

    expect(backup).toMatchObject({
      // Not "unknown" for a platform tier, and not "" for a missing label.
      instanceLabel: 'unknown',
      sizeBytes: 0,
      objectKey: '',
      includes: [],
      finishedAt: null,
      renderSetId: '',
    });
  });

  it('returns an empty register when the instance has never been captured', async () => {
    const { service } = setup([['SELECT * FROM backup WHERE instance_id = $1', []]]);

    await expect(service.backups('inst-1')).resolves.toEqual([]);
  });
});

describe('backup schedule', () => {
  it('refuses to schedule an instance that no longer exists', async () => {
    const { service } = setup([['deleted_at IS NULL', []]]);

    await expect(
      service.schedule('inst-gone', { schedule: 'daily', timezone: 'UTC', enabled: true }, 'u-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', detail: 'No instance inst-gone.' });
  });

  it('records the cadence, chains the audit row and answers with the stored posture', async () => {
    const { db, audit, service } = setup(scheduleRoutes());

    const posture = await service.schedule(
      'inst-1',
      { schedule: 'weekly', timezone: 'Europe/Berlin', enabled: true },
      'user-1',
    );

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO backup_schedule'));
    // A weekly cadence pins a weekday; every other cadence leaves it null.
    expect(insert?.params[3]).toBe(0);
    expect(insert?.params[4]).toBe('Europe/Berlin');
    expect(insert?.params[6]).toBe('user-1');
    expect(audit.lockChain).toHaveBeenCalledWith(db.client);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.backup.schedule.updated',
        actorId: 'user-1',
        detail: { cadence: 'weekly', timezone: 'Europe/Berlin', enabled: true },
      }),
      db.client,
    );
    expect(posture).toMatchObject({ schedule: 'daily', scheduleEnabled: true });
  });

  it('leaves the weekday empty for a daily cadence', async () => {
    const { db, service } = setup(scheduleRoutes());

    await service.schedule(
      'inst-1',
      { schedule: 'daily', timezone: 'UTC', enabled: true },
      'user-1',
    );

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO backup_schedule'));
    expect(insert?.params[3]).toBeNull();
  });

  it('stores a disabled schedule with no next run at all', async () => {
    const { db, service } = setup(scheduleRoutes());

    await service.schedule('inst-1', { schedule: 'daily', timezone: 'UTC', enabled: false }, 'u-1');

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO backup_schedule'));
    expect(insert?.params[5]).toBeNull();
  });

  describe('cadence arithmetic', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      [
        'daily, before the 02:00 window',
        '2026-01-01T01:00:00Z',
        'daily',
        '2026-01-01T02:00:00.000Z',
      ],
      [
        'daily, after the 02:00 window',
        '2026-01-01T03:00:00Z',
        'daily',
        '2026-01-02T02:00:00.000Z',
      ],
      ['weekly, mid-week', '2026-01-07T00:00:00Z', 'weekly', '2026-01-11T02:00:00.000Z'],
      ['weekly, on a Sunday', '2026-01-11T00:00:00Z', 'weekly', '2026-01-18T02:00:00.000Z'],
      [
        'monthly, the first of the next month',
        '2026-01-15T00:00:00Z',
        'monthly',
        '2026-02-01T02:00:00.000Z',
      ],
      ['off, which has no next run', '2026-01-15T00:00:00Z', 'off', null],
      [
        'an unknown cadence, which falls back to daily',
        '2026-01-15T00:00:00Z',
        'hourly',
        '2026-01-15T02:00:00.000Z',
      ],
    ])('schedules %s', async (_label, now, schedule, expected) => {
      vi.setSystemTime(new Date(now));
      const { db, service } = setup(scheduleRoutes());

      await service.schedule('inst-1', { schedule, timezone: 'UTC', enabled: true }, 'u-1');

      const insert = db.calls.find((call) => call.sql.includes('INSERT INTO backup_schedule'));
      expect(insert?.params[5]).toEqual(expected === null ? null : new Date(expected));
    });
  });

  it('reports the last capture and its verification in the posture', async () => {
    const { service } = setup([
      INSTANCE,
      ['INSERT INTO backup_schedule', []],
      POSTURE_SCHEDULE,
      [
        'SELECT finished_at, verified_at FROM backup',
        [
          {
            finished_at: new Date('2026-01-03T00:00:00.000Z'),
            verified_at: new Date('2026-01-04T00:00:00.000Z'),
          },
        ],
      ],
    ]);

    const posture = await service.schedule(
      'inst-1',
      { schedule: 'daily', timezone: 'UTC', enabled: true },
      'u-1',
    );

    expect(posture).toEqual({
      lastSuccessAt: '2026-01-03T00:00:00.000Z',
      lastVerifiedRestoreAt: '2026-01-04T00:00:00.000Z',
      schedule: 'daily',
      scheduleTimezone: 'UTC',
      scheduleEnabled: true,
      verified: true,
    });
  });

  it('reports an unverified posture when the last capture was never checked', async () => {
    const { service } = setup([
      INSTANCE,
      ['INSERT INTO backup_schedule', []],
      POSTURE_SCHEDULE,
      [
        'SELECT finished_at, verified_at FROM backup',
        [{ finished_at: new Date('2026-01-03T00:00:00.000Z'), verified_at: null }],
      ],
    ]);

    const posture = await service.schedule(
      'inst-1',
      { schedule: 'daily', timezone: 'UTC', enabled: true },
      'u-1',
    );

    expect(posture).toMatchObject({
      lastVerifiedRestoreAt: null,
      verified: false,
      scheduleEnabled: true,
    });
  });

  it('defaults the posture to off and UTC when no schedule row is stored', async () => {
    const { service } = setup([
      INSTANCE,
      ['INSERT INTO backup_schedule', []],
      ['SELECT cadence, timezone, next_run_at FROM backup_schedule', []],
      POSTURE_LATEST,
    ]);

    const posture = await service.schedule(
      'inst-1',
      { schedule: 'daily', timezone: 'UTC', enabled: true },
      'u-1',
    );

    expect(posture).toMatchObject({
      schedule: 'off',
      scheduleTimezone: 'UTC',
      scheduleEnabled: false,
      lastSuccessAt: null,
    });
  });
});

describe('instance backup', () => {
  it('records a running backup and queues the dump with the render set it captured', async () => {
    const { db, jobs, service } = setup([
      INSTANCE,
      RENDER_SET,
      ['INSERT INTO backup (kind, instance_id, render_set_id, state)', [{ id: 'bkp-9' }]],
    ]);

    const result = await service.createInstanceBackup('inst-1', 'user-1');

    expect(result).toEqual({ backupId: 'bkp-9', jobId: 'job-1' });
    const insert = db.calls.find((call) =>
      call.sql.includes('INSERT INTO backup (kind, instance_id'),
    );
    expect(insert?.params).toEqual(['inst-1', 'rs-1']);
    expect(jobs.create).toHaveBeenCalledWith({
      kind: 'backup',
      instanceId: 'inst-1',
      requestedBy: 'user-1',
      payload: { backupId: 'bkp-9', slug: 'crm' },
      steps: ['Dump databases', 'Encrypt and upload'],
    });
  });

  it('records a backup with no render set when the instance never applied one', async () => {
    const { db, service } = setup([
      INSTANCE,
      ['FROM instance i WHERE i.id = $1', []],
      ['INSERT INTO backup (kind, instance_id, render_set_id, state)', [{ id: 'bkp-9' }]],
    ]);

    await service.createInstanceBackup('inst-1', 'user-1');

    const insert = db.calls.find((call) =>
      call.sql.includes('INSERT INTO backup (kind, instance_id'),
    );
    expect(insert?.params).toEqual(['inst-1', null]);
  });

  it('refuses to back up an instance that no longer exists', async () => {
    const { service } = setup([['deleted_at IS NULL', []]]);

    await expect(service.createInstanceBackup('inst-gone', 'user-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No instance inst-gone.',
    });
  });

  it('refuses when the backup row was not created', async () => {
    const { service } = setup([
      INSTANCE,
      RENDER_SET,
      ['INSERT INTO backup (kind, instance_id, render_set_id, state)', []],
    ]);

    await expect(service.createInstanceBackup('inst-1', 'user-1')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The backup row was not created.',
    });
  });

  it('refuses a job kind nobody registered instead of finishing a job that did nothing', async () => {
    const { pipelines, service } = setup([
      INSTANCE,
      RENDER_SET,
      ['INSERT INTO backup (kind, instance_id, render_set_id, state)', [{ id: 'bkp-9' }]],
    ]);
    pipelines.stepsFor.mockReturnValueOnce([]);

    await expect(service.createInstanceBackup('inst-1', 'user-1')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'Job kind "backup" has no registered pipeline.',
    });
  });
});

describe('verify', () => {
  it('queues a verification of an existing backup', async () => {
    const { jobs, service } = setup([['SELECT * FROM backup WHERE id = $1', [backupRow()]]]);

    await expect(service.verify('bkp-1', 'user-1')).resolves.toEqual({
      backupId: 'bkp-1',
      jobId: 'job-1',
    });
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'verify',
        instanceId: 'inst-1',
        payload: { backupId: 'bkp-1', mode: 'backup' },
      }),
    );
  });

  it('refuses to verify a backup that is not in the register', async () => {
    const { service } = setup([['SELECT * FROM backup WHERE id = $1', []]]);

    await expect(service.verify('nope', 'user-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No backup nope.',
    });
  });
});

describe('instance restore', () => {
  it.each([
    ['a platform backup', backupRow({ kind: 'platform', instance_id: null })],
    ['an instance backup with no instance', backupRow({ instance_id: null })],
  ])('refuses %s rather than restoring into nothing', async (_label, row) => {
    const { service } = setup([['SELECT * FROM backup WHERE id = $1', [row]]]);

    await expect(
      service.restore('bkp-1', 'restore after the incident', 'user-1'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'An instance restore needs an instance backup.',
    });
  });

  it('records the restore run and queues it at the configured concurrency', async () => {
    const { db, jobs, service } = setup([
      ['SELECT * FROM backup WHERE id = $1', [backupRow()]],
      [
        'INSERT INTO restore_run (backup_id, phase, state, justification, concurrency)',
        [{ id: 'run-1' }],
      ],
    ]);

    const result = await service.restore('bkp-1', 'restore after the incident', 'user-1');

    expect(result).toEqual({ restoreId: 'run-1', jobId: 'job-1' });
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO restore_run'));
    expect(insert?.params).toEqual(['bkp-1', 'restore after the incident', 4]);
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'restore',
        instanceId: 'inst-1',
        payload: { backupId: 'bkp-1', restoreId: 'run-1' },
      }),
    );
  });

  it('refuses when the restore run was not created', async () => {
    const { service } = setup([
      ['SELECT * FROM backup WHERE id = $1', [backupRow()]],
      ['INSERT INTO restore_run (backup_id, phase, state, justification, concurrency)', []],
    ]);

    await expect(
      service.restore('bkp-1', 'restore after the incident', 'user-1'),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', detail: 'The restore run was not created.' });
  });
});

describe('restore drill', () => {
  it('drills the latest successful capture and reports the queued evidence', async () => {
    const { jobs, service } = setup([
      INSTANCE,
      ['SELECT id FROM backup WHERE instance_id = $1 AND state', [{ id: 'bkp-1' }]],
      [
        'INSERT INTO restore_drill',
        [{ id: 'drill-1', performed_at: new Date('2026-01-05T00:00:00.000Z') }],
      ],
    ]);

    const drill = await service.restoreDrill('inst-1', 'user-1');

    expect(drill).toEqual({
      id: 'drill-1',
      instanceId: 'inst-1',
      instanceLabel: 'crm',
      performedAt: '2026-01-05T00:00:00.000Z',
      smokeTest: 'queued',
      passed: false,
      evidenceUrl: 'job:drill-1',
    });
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'verify',
        payload: { backupId: 'bkp-1', mode: 'drill', drillId: 'drill-1' },
      }),
    );
  });

  it('refuses a drill on an instance that no longer exists', async () => {
    const { service } = setup([['deleted_at IS NULL', []]]);

    await expect(service.restoreDrill('inst-gone', 'user-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses to fabricate a source when there is no successful backup', async () => {
    const { service } = setup([
      INSTANCE,
      ['SELECT id FROM backup WHERE instance_id = $1 AND state', []],
    ]);

    await expect(service.restoreDrill('inst-1', 'user-1')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'A drill needs a successful backup to restore.',
    });
  });

  it('refuses when the drill row was not created', async () => {
    const { service } = setup([
      INSTANCE,
      ['SELECT id FROM backup WHERE instance_id = $1 AND state', [{ id: 'bkp-1' }]],
      ['INSERT INTO restore_drill', []],
    ]);

    await expect(service.restoreDrill('inst-1', 'user-1')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The drill row was not created.',
    });
  });
});

describe('platform backup', () => {
  it('records a platform capture and queues it without an instance', async () => {
    const { db, jobs, service } = setup([['INSERT INTO backup (kind, state)', [{ id: 'bkp-p' }]]]);

    await expect(service.platformBackup('user-1')).resolves.toEqual({
      backupId: 'bkp-p',
      jobId: 'job-1',
    });
    expect(db.calls[0]?.params).toEqual([]);
    const input = jobs.create.mock.calls[0]?.[0];
    expect(input).toMatchObject({ kind: 'platform-backup', requestedBy: 'user-1' });
    // A platform job is not tied to one instance, so the key is absent rather than null.
    expect(input).not.toHaveProperty('instanceId');
  });

  it('refuses when the capture row was not created', async () => {
    const { service } = setup([['INSERT INTO backup (kind, state)', []]]);

    await expect(service.platformBackup('user-1')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The backup row was not created.',
    });
  });
});

describe('platform restore', () => {
  const JUSTIFICATION = 'restore the platform after the storage incident';

  function restoreRoutes(overrides: readonly Route[] = []): Route[] {
    return [
      // Overrides answer first: the first matching route wins.
      ...overrides,
      ['SELECT * FROM backup WHERE id = $1', [backupRow({ kind: 'platform', instance_id: null })]],
      ["r.state = 'running'", []],
      [
        'INSERT INTO restore_run (backup_id, phase, state, justification, concurrency)',
        [{ id: 'run-9' }],
      ],
    ];
  }

  it('refuses an instance backup', async () => {
    const { service } = setup([['SELECT * FROM backup WHERE id = $1', [backupRow()]]]);

    await expect(service.platformRestore('bkp-1', JUSTIFICATION, 'u-1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'A platform restore needs a platform backup.',
    });
  });

  it.each([
    ['empty', ''],
    ['white space only', '                       '],
    ['one character short of the minimum', '1234567890123456789'],
  ])('refuses a justification that is %s', async (_label, justification) => {
    const { service } = setup([
      ['SELECT * FROM backup WHERE id = $1', [backupRow({ kind: 'platform', instance_id: null })]],
    ]);

    await expect(service.platformRestore('bkp-1', justification, 'u-1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'A platform restore needs a written justification of at least 20 characters.',
    });
  });

  it('refuses a capture that never finished', async () => {
    const { service } = setup([
      [
        'SELECT * FROM backup WHERE id = $1',
        [backupRow({ kind: 'platform', instance_id: null, state: 'running' })],
      ],
    ]);

    await expect(service.platformRestore('bkp-1', JUSTIFICATION, 'u-1')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
      detail: 'Backup bkp-1 is running; a restore needs a finished capture.',
    });
  });

  it('refuses a second platform restore while one is running', async () => {
    const { service } = setup([
      ['SELECT * FROM backup WHERE id = $1', [backupRow({ kind: 'platform', instance_id: null })]],
      ["r.state = 'running'", [{ id: 'run-active' }]],
    ]);

    await expect(service.platformRestore('bkp-1', JUSTIFICATION, 'u-1')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
      detail: 'Platform restore run-active is still running.',
    });
  });

  it('closes the gate, emits the event and queues the restore in one transaction', async () => {
    const { db, audit, integration, outbox, jobs, service } = setup(restoreRoutes());

    const result = await service.platformRestore('bkp-1', JUSTIFICATION, 'u-1');

    expect(result).toEqual({ restoreId: 'run-9', jobId: 'job-1' });
    expect(audit.lockChain).toHaveBeenCalledWith(db.client);
    // The gate closes before the first row is written: no product is reachable during the restore.
    expect(integration.setAllRoutesGated).toHaveBeenCalledWith(db.client, true);
    expect(outbox.emit).toHaveBeenCalledWith(
      db.client,
      expect.objectContaining({
        aggregateType: 'instance_route',
        payload: { reason: 'platform-restore', gated: true },
      }),
    );
    const input = jobs.create.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      kind: 'platform-restore',
      payload: { backupId: 'bkp-1', restoreId: 'run-9' },
    });
    expect(input).not.toHaveProperty('instanceId');
  });

  it('reports an unusable transaction without compensating for a run that was never created', async () => {
    const { integration, service } = setup(
      restoreRoutes([
        ['INSERT INTO restore_run (backup_id, phase, state, justification, concurrency)', []],
      ]),
    );

    await expect(service.platformRestore('bkp-1', JUSTIFICATION, 'u-1')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The restore run was not created.',
    });
    // Nothing to abandon, but the gate is still down: the caller sees the failure.
    expect(integration.setAllRoutesGated).toHaveBeenCalledTimes(1);
  });

  it('reopens the gate when the restore job cannot be created', async () => {
    const { integration, outbox, jobs, service } = setup([
      ['DELETE FROM restore_run', []],
      ...restoreRoutes(),
    ]);
    jobs.create.mockRejectedValueOnce(new Error('job lane is closed'));

    await expect(service.platformRestore('bkp-1', JUSTIFICATION, 'u-1')).rejects.toThrow(
      'job lane is closed',
    );
    expect(integration.setAllRoutesGated).toHaveBeenNthCalledWith(1, expect.anything(), true);
    expect(integration.setAllRoutesGated).toHaveBeenNthCalledWith(2, expect.anything(), false);
    expect(outbox.emit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ payload: { reason: 'platform-restore-refused', gated: false } }),
    );
  });

  it('still reports the job failure when the compensating transaction fails too', async () => {
    const { jobs, service } = setup([
      [
        'DELETE FROM restore_run',
        () => {
          throw new Error('audit chain unavailable');
        },
      ],
      ...restoreRoutes(),
    ]);
    jobs.create.mockRejectedValueOnce(new Error('job lane is closed'));

    await expect(service.platformRestore('bkp-1', JUSTIFICATION, 'u-1')).rejects.toThrow(
      'job lane is closed',
    );
  });
});

describe('platform restore status', () => {
  const RUNS: Route = ['ORDER BY r.started_at DESC', []];

  it('reports an open gate and no run when nothing has been restored', async () => {
    const { service } = setup([RUNS, GATE_COUNT_OPEN]);

    const status = await service.platformRestoreStatus();

    expect(status.run).toBeNull();
    expect(status.gate).toEqual({
      routesPublished: true,
      loginVerifiedAt: null,
      detail: 'Product routes are published.',
    });
    expect(status.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('holds the gate while any route is gated', async () => {
    const { service } = setup([
      ['ORDER BY r.started_at DESC', [restoreRow({ state: 'running', login_verified_at: null })]],
      ['count(*)::text AS count FROM instance_route', [{ count: '3' }]],
    ]);

    const status = await service.platformRestoreStatus();

    expect(status.run).toMatchObject({
      id: 'run-1',
      loginVerifiedAt: null,
      routesUnpublishedUntilLogin: true,
    });
    expect(status.gate).toEqual({
      routesPublished: false,
      loginVerifiedAt: null,
      detail: 'Product routes are held until an administrative login is verified.',
    });
  });

  it('treats a missing gate count as an open gate', async () => {
    const { service } = setup([
      ['ORDER BY r.started_at DESC', [restoreRow()]],
      ['count(*)::text AS count FROM instance_route', []],
    ]);

    const status = await service.platformRestoreStatus();

    expect(status.gate.routesPublished).toBe(true);
    expect(status.gate.loginVerifiedAt).toBe('2026-01-01T00:30:00.000Z');
  });
});

describe('recovery overview', () => {
  function overviewRoutes(
    backups: readonly Record<string, unknown>[],
    drills: readonly Record<string, unknown>[],
    runs: readonly Record<string, unknown>[],
    overrides: readonly Route[] = [],
  ): Route[] {
    return [
      ['SELECT * FROM backup ORDER BY started_at DESC LIMIT 25', backups],
      ['FROM restore_drill ORDER BY performed_at DESC LIMIT 25', drills],
      ['ORDER BY r.started_at DESC', runs],
      GATE_COUNT_OPEN,
      ['SELECT slug FROM instance', [{ slug: 'crm' }]],
      ...overrides,
    ];
  }

  it('reports the register, the drill history, the gate and the last verified restore', async () => {
    const { service } = setup(
      overviewRoutes(
        [backupRow({ state: 'running', finished_at: null }), backupRow({ id: 'bkp-2' })],
        [
          {
            id: 'drill-1',
            instance_id: 'inst-1',
            performed_at: new Date('2026-01-05T00:00:00.000Z'),
            smoke_test: 'scratch stack started',
            passed: true,
            evidence_url: 'job:drill-1',
          },
        ],
        [
          restoreRow({ id: 'run-early', state: 'failed', finished_at: null }),
          restoreRow({ id: 'run-verified' }),
        ],
      ),
    );

    const overview = await service.recoveryOverview();

    expect(overview.backups).toHaveLength(2);
    // The last successful capture, not the first row.
    expect(overview.lastBackupAt).toBe('2026-01-01T00:05:00.000Z');
    // A restore whose administrative login was proven, not merely a successful backup.
    expect(overview.lastVerifiedRestoreAt).toBe('2026-01-01T01:00:00.000Z');
    expect(overview.runs.map((run) => run.id)).toEqual(['run-early', 'run-verified']);
    expect(overview.drills).toEqual([
      {
        id: 'drill-1',
        instanceId: 'inst-1',
        instanceLabel: 'inst-1',
        performedAt: '2026-01-05T00:00:00.000Z',
        smokeTest: 'scratch stack started',
        passed: true,
        evidenceUrl: 'job:drill-1',
      },
    ]);
    expect(overview.contents.map((entry) => entry.label)).toEqual([
      'Platform database',
      'Identity provider',
      'Edge configuration',
      'Audit anchor',
      'Catalogue repository',
    ]);
    expect(overview.gate.routesPublished).toBe(true);
  });

  it('reports nothing captured, nothing verified and no audit trail', async () => {
    const { service } = setup(overviewRoutes([], [], []));

    const overview = await service.recoveryOverview();

    expect(overview).toMatchObject({
      backups: [],
      runs: [],
      drills: [],
      lastBackupAt: null,
      lastVerifiedRestoreAt: null,
    });
  });

  it('labels a platform drill as platform and defaults its missing evidence', async () => {
    const { service } = setup(
      overviewRoutes(
        [],
        [
          {
            id: 'drill-2',
            instance_id: null,
            performed_at: new Date('2026-01-05T00:00:00.000Z'),
            smoke_test: null,
            passed: false,
            evidence_url: null,
          },
        ],
        [],
      ),
    );

    const [drill] = (await service.recoveryOverview()).drills;

    expect(drill).toMatchObject({
      instanceLabel: 'platform',
      smokeTest: 'unknown',
      evidenceUrl: '',
    });
  });

  it('does not report a restore that succeeded without a verified login', async () => {
    const { service } = setup(overviewRoutes([], [], [restoreRow({ login_verified_at: null })]));

    expect((await service.recoveryOverview()).lastVerifiedRestoreAt).toBeNull();
  });
});

describe('platform timeline', () => {
  type Cell = {
    readonly phase: string;
    readonly state: string;
    readonly detail: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
  };
  type ProjectedRun = {
    readonly id: string;
    readonly phases: Cell[];
    readonly concurrency: number;
    readonly justification: string;
    readonly requestedBy: string;
    readonly failedReason: string | null;
  };

  function runsOf(row: Record<string, unknown>): Promise<ProjectedRun> {
    const { service } = setup([
      ['SELECT * FROM backup ORDER BY started_at DESC LIMIT 25', []],
      ['FROM restore_drill ORDER BY performed_at DESC LIMIT 25', []],
      ['ORDER BY r.started_at DESC', [row]],
      GATE_COUNT_OPEN,
    ]);
    return service
      .recoveryOverview()
      .then((overview) => overview.runs[0] as unknown as ProjectedRun);
  }

  it('marks the phases before the current one as done and the rest as pending', async () => {
    const run = await runsOf(
      restoreRow({ phase: 'idp', state: 'running', login_verified_at: null }),
    );

    expect(run.phases.map((phase) => `${phase.phase}:${phase.state}`)).toEqual([
      'preparing:succeeded',
      'idp:running',
      'control_plane:pending',
      'login_verified:pending',
      'products:pending',
      'verify:pending',
      'complete:pending',
    ]);
  });

  it('marks every phase succeeded and dates the completion of a finished restore', async () => {
    const run = await runsOf(restoreRow());

    expect(run.phases.every((phase) => phase.state === 'succeeded')).toBe(true);
    const complete = run.phases.at(-1);
    expect(complete).toMatchObject({ finishedAt: '2026-01-01T01:00:00.000Z' });
  });

  it('leaves the completion date null when a completed restore has no finish time', async () => {
    const run = await runsOf(restoreRow({ finished_at: null }));

    expect(run.phases.at(-1)).toMatchObject({ state: 'succeeded', finishedAt: null });
  });

  it('fails the phase the run stopped in and appends the recorded reason', async () => {
    const run = await runsOf(
      restoreRow({
        state: 'failed',
        phase: 'products',
        finished_at: null,
        detail: { failedPhase: 'control_plane', failedReason: 'entitlement restore rejected' },
      }),
    );

    expect(run.phases.map((phase) => phase.state)).toEqual([
      'succeeded',
      'succeeded',
      'failed',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(run.phases[2]?.detail).toMatch(/entitlement restore rejected$/);
    // The reason is not a label on every cell.
    expect(run.phases[0]?.detail).not.toMatch(/entitlement restore rejected/);
    expect(run.failedReason).toBe('entitlement restore rejected');
  });

  it('assumes the verification phase when a failed run recorded no phase', async () => {
    const run = await runsOf(restoreRow({ state: 'failed', phase: 'products', detail: {} }));

    expect(run.phases.map((phase) => phase.state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
      'failed',
      'pending',
    ]);
    expect(run.phases[5]?.detail).not.toMatch(/undefined/);
  });

  it('stops at the first phase when the recorded phase is not one of the seven', async () => {
    const run = await runsOf(
      restoreRow({ state: 'failed', phase: 'products', detail: { failedPhase: 'nonsense' } }),
    );

    expect(run.phases[0]?.state).toBe('failed');
    expect(run.phases.slice(1).every((phase) => phase.state === 'pending')).toBe(true);
  });

  it('starts at the preparing phase when a running restore has no current phase', async () => {
    const run = await runsOf(
      restoreRow({ phase: null, state: 'running', login_verified_at: null }),
    );

    expect(run.phases[0]?.state).toBe('running');
    expect(run.phases[0]?.startedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it.each([
    [1, 4],
    [6, 6],
    [20, 12],
  ])('clamps a stored concurrency of %i to %i', async (stored, expected) => {
    const run = await runsOf(restoreRow({ concurrency: stored }));
    expect(run).toMatchObject({ concurrency: expected });
  });

  it('defaults an empty justification and an unresolved requester', async () => {
    const run = await runsOf(restoreRow({ justification: '   ', requested_by_name: null }));

    expect(run).toMatchObject({ justification: 'not recorded', requestedBy: 'platform' });
  });
});

describe('open the gate after an administrative login', () => {
  const PENDING: Route = ['login_verified_at IS NULL', [{ id: 'run-1' }]];
  const GATE_UPDATE: Route = [
    'SET login_verified_at = now()',
    [{ detail: { stoppedContainers: ['c1', 'c2'] } }],
  ];

  it('refuses a caller who cannot manage recovery', async () => {
    const { db, service } = setup([]);

    await expect(service.openGateAfterLogin('u-1', 'R2')).resolves.toEqual({
      opened: false,
      reason: 'the caller cannot manage recovery',
    });
    expect(db.calls).toEqual([]);
  });

  it('does nothing when no restore is waiting for a login', async () => {
    const { integration, service } = setup([['login_verified_at IS NULL', []]]);

    await expect(service.openGateAfterLogin('u-1', 'R1')).resolves.toEqual({
      opened: false,
      reason: 'no restore is waiting for a login',
    });
    expect(integration.setAllRoutesGated).not.toHaveBeenCalled();
  });

  it('opens the gate, restarts the stopped products and records both facts', async () => {
    const { audit, integration, outbox, docker, service } = setup([PENDING, GATE_UPDATE]);

    const result = await service.openGateAfterLogin('u-1', 'R1');

    expect(result.opened).toBe(true);
    expect(result.reason).toContain('restore run-1 verified by an administrative login; 2/2');
    expect(integration.setAllRoutesGated).toHaveBeenCalledWith(expect.anything(), false);
    expect(outbox.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payload: { reason: 'restore-login-verified', gated: false } }),
    );
    expect(docker.start.mock.calls).toEqual([['c1'], ['c2']]);
    expect(audit.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'platform.restore.gate_opened', detail: { role: 'R1' } }),
      expect.anything(),
    );
    expect(audit.append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'platform.restore.products_started',
        outcome: 'success',
        detail: { restarted: 2, stopped: 2 },
      }),
    );
  });

  it('reports a partial restart as a failure rather than a completed restore', async () => {
    const { audit, docker, service } = setup([PENDING, GATE_UPDATE]);
    docker.start.mockRejectedValueOnce(new Error('no such container'));

    const result = await service.openGateAfterLogin('u-1', 'R1');

    expect(result.reason).toContain('1/2 product container(s) restarted');
    expect(audit.append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'platform.restore.products_started',
        outcome: 'failure',
        detail: { restarted: 1, stopped: 2 },
      }),
    );
  });

  it('ignores a stopped-container list that is not a list of ids', async () => {
    const { audit, docker, service } = setup([
      PENDING,
      ['SET login_verified_at = now()', [{ detail: { stoppedContainers: 'c1,c2' } }]],
    ]);

    const result = await service.openGateAfterLogin('u-1', 'R1');

    expect(docker.start).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(result.reason).toContain('0/0 product container(s) restarted');
  });

  it('keeps only string container ids', async () => {
    const { docker, service } = setup([
      PENDING,
      ['SET login_verified_at = now()', [{ detail: { stoppedContainers: ['c1', 42, 'c2'] } }]],
    ]);

    await service.openGateAfterLogin('u-1', 'R1');

    expect(docker.start.mock.calls).toEqual([['c1'], ['c2']]);
  });

  it('treats an update that returns no row as having stopped nothing', async () => {
    const { docker, service } = setup([PENDING, ['SET login_verified_at = now()', []]]);

    const result = await service.openGateAfterLogin('u-1', 'R1');

    expect(docker.start).not.toHaveBeenCalled();
    expect(result.opened).toBe(true);
  });

  it('still opens the gate when the restart audit row cannot be written', async () => {
    const { audit, service } = setup([PENDING, GATE_UPDATE]);
    audit.append
      .mockResolvedValueOnce({ seq: '1', hash: 'h' })
      .mockRejectedValueOnce(new Error('audit chain unavailable'));

    await expect(service.openGateAfterLogin('u-1', 'R1')).resolves.toMatchObject({ opened: true });
  });
});

describe('scheduled backups', () => {
  const dueRoutes: Route = [
    "cadence <> 'off' AND next_run_at",
    [{ instance_id: 'inst-1', cadence: 'weekly', timezone: 'UTC' }],
  ];
  const advance: Route = ['UPDATE backup_schedule SET next_run_at = $2', []];
  const retry: Route = ["now() + interval '15 minutes'", []];

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts nothing when no schedule is due', async () => {
    const { db, service } = setup([["cadence <> 'off' AND next_run_at", []]]);

    await expect(service.tickSchedules()).resolves.toBe(0);
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO backup'))).toBe(false);
  });

  it('starts a due backup and advances its next run by one cadence', async () => {
    const { db, service } = setup([
      dueRoutes,
      INSTANCE,
      RENDER_SET,
      ['INSERT INTO backup (kind, instance_id, render_set_id, state)', [{ id: 'bkp-9' }]],
      advance,
    ]);

    await expect(service.tickSchedules()).resolves.toBe(1);

    const update = db.calls.find((call) =>
      call.sql.includes('UPDATE backup_schedule SET next_run_at = $2'),
    );
    expect(update?.params[0]).toBe('inst-1');
    expect(update?.params[1]).toBeInstanceOf(Date);
  });

  it('leaves the backup owed and retries in fifteen minutes when it cannot start', async () => {
    const { db, service } = setup([dueRoutes, ['deleted_at IS NULL', []], retry]);

    await expect(service.tickSchedules()).resolves.toBe(0);

    // The cadence is not consumed: the failure is deferred, not swallowed.
    expect(
      db.calls.some((call) => call.sql.includes('UPDATE backup_schedule SET next_run_at = $2')),
    ).toBe(false);
    expect(db.calls.some((call) => call.sql.includes("interval '15 minutes'"))).toBe(true);
  });

  it('reports a retry that cannot be scheduled without abandoning the pass', async () => {
    const { service } = setup([
      dueRoutes,
      ['deleted_at IS NULL', []],
      [
        "interval '15 minutes'",
        () => {
          throw new Error('schedule table is locked');
        },
      ],
    ]);

    await expect(service.tickSchedules()).resolves.toBe(0);
  });

  it('describes a non-Error failure and a non-Error retry failure', async () => {
    const { service } = setup([
      dueRoutes,
      [
        'deleted_at IS NULL',
        () => {
          throw 'instance lookup exploded';
        },
      ],
      [
        "interval '15 minutes'",
        () => {
          throw 'retry write exploded';
        },
      ],
    ]);

    await expect(service.tickSchedules()).resolves.toBe(0);
  });
});
