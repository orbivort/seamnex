import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase4CHandlers } from '../../../../src/contract/handlers/phase4c.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { callHandler, operationInput } from '../../../support/operation-input';

type Double = ReturnType<typeof vi.fn>;

/**
 * The backup service as the handlers see it. Named keys rather than `Record<string, …>` so a
 * missing double is a compile error and every member is callable without a null check.
 */
type BackupService = Record<
  | 'backups'
  | 'recoveryOverview'
  | 'createInstanceBackup'
  | 'schedule'
  | 'verify'
  | 'restore'
  | 'platformBackup'
  | 'platformRestore'
  | 'restoreDrill'
  | 'openGateAfterLogin'
  | 'platformRestoreStatus',
  Double
>;

let backups: BackupService;
let handlers: ReadonlyMap<string, OperationHandler>;

beforeEach(() => {
  backups = {
    backups: vi.fn().mockResolvedValue([]),
    recoveryOverview: vi.fn().mockResolvedValue({}),
    createInstanceBackup: vi.fn().mockResolvedValue({ jobId: 'job-backup' }),
    schedule: vi.fn().mockResolvedValue({ enabled: true }),
    verify: vi.fn().mockResolvedValue({ jobId: 'job-verify' }),
    restore: vi.fn().mockResolvedValue({ jobId: 'job-restore' }),
    platformBackup: vi.fn().mockResolvedValue({ jobId: 'job-platform' }),
    platformRestore: vi.fn().mockResolvedValue({ jobId: 'job-platform-restore' }),
    restoreDrill: vi.fn().mockResolvedValue({ id: 'drill-1' }),
    openGateAfterLogin: vi.fn().mockResolvedValue({ opened: true }),
    platformRestoreStatus: vi.fn().mockResolvedValue({ gated: false }),
  };
  handlers = new Phase4CHandlers(backups as never).handlers();
});

const call = (key: string, overrides = {}) =>
  callHandler(handlers, key, operationInput(key, overrides));

describe('backup reads and writes', () => {
  it('GET /instances/:id/backups lists the instance backups', async () => {
    const result = await call('GET /instances/:id/backups', { params: { id: 'i1' } });
    expect(backups.backups).toHaveBeenCalledWith('i1');
    expect(result).toEqual({ kind: 'body', body: [] });
  });

  it('GET /recovery returns the overview', async () => {
    const result = await call('GET /recovery');
    expect(backups.recoveryOverview).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: 'body', body: {} });
  });

  it('POST /instances/:id/backups answers 202', async () => {
    const result = await call('POST /instances/:id/backups', { params: { id: 'i1' } });
    expect(backups.createInstanceBackup).toHaveBeenCalledWith('i1', 'sub-1');
    expect(result).toEqual({ kind: 'accepted', jobId: 'job-backup' });
  });

  it('PUT /instances/:id/backup-schedule passes only the declared fields', async () => {
    await call('PUT /instances/:id/backup-schedule', {
      params: { id: 'i1' },
      body: { schedule: '0 2 * * *', timezone: 'UTC', enabled: true, ignored: 'x' },
    });

    expect(backups.schedule).toHaveBeenCalledWith(
      'i1',
      { schedule: '0 2 * * *', timezone: 'UTC', enabled: true },
      'sub-1',
    );
  });

  it('POST /backups/:id/verify answers 202', async () => {
    const result = await call('POST /backups/:id/verify', { params: { id: 'b1' } });
    expect(backups.verify).toHaveBeenCalledWith('b1', 'sub-1');
    expect(result).toEqual({ kind: 'accepted', jobId: 'job-verify' });
  });

  it('POST /backups/:id/restore uses the supplied justification', async () => {
    const result = await call('POST /backups/:id/restore', {
      params: { id: 'b1' },
      body: { justification: 'disk corruption' },
    });

    expect(backups.restore).toHaveBeenCalledWith('b1', 'disk corruption', 'sub-1');
    expect(result).toEqual({ kind: 'accepted', jobId: 'job-restore' });
  });

  it('POST /backups/:id/restore defaults the justification when the body is absent', async () => {
    await call('POST /backups/:id/restore', { params: { id: 'b1' } });
    expect(backups.restore).toHaveBeenCalledWith(
      'b1',
      'restore requested from the console',
      'sub-1',
    );
  });

  it('refuses a backup action without its id', async () => {
    await expect(call('POST /backups/:id/verify', { params: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('platform recovery', () => {
  it('POST /recovery/backups answers 202', async () => {
    const result = await call('POST /recovery/backups');
    expect(backups.platformBackup).toHaveBeenCalledWith('sub-1');
    expect(result).toEqual({ kind: 'accepted', jobId: 'job-platform' });
  });

  it('POST /recovery/restores requires a backup id', async () => {
    await expect(call('POST /recovery/restores', { body: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      remediation: expect.stringContaining('platform backup'),
    });
    expect(backups.platformRestore).not.toHaveBeenCalled();
  });

  it('POST /recovery/restores forwards the chosen backup and justification', async () => {
    const result = await call('POST /recovery/restores', {
      body: { backupId: 'pb1', justification: 'total loss' },
    });

    expect(backups.platformRestore).toHaveBeenCalledWith('pb1', 'total loss', 'sub-1');
    expect(result).toEqual({ kind: 'accepted', jobId: 'job-platform-restore' });
  });

  it('POST /recovery/restores defaults the justification', async () => {
    await call('POST /recovery/restores', { body: { backupId: 'pb1' } });
    expect(backups.platformRestore).toHaveBeenCalledWith(
      'pb1',
      'platform restore requested from the console',
      'sub-1',
    );
  });

  it('POST /recovery/restores refuses an absent body rather than guessing a backup', async () => {
    await expect(call('POST /recovery/restores')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('POST /restore-drills requires an instance', async () => {
    await expect(call('POST /restore-drills', { body: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(call('POST /restore-drills')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('POST /restore-drills returns the evidence row', async () => {
    const result = await call('POST /restore-drills', { body: { instanceId: 'i1' } });
    expect(backups.restoreDrill).toHaveBeenCalledWith('i1', 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: 'drill-1' } });
  });

  it('GET /platform/restore-status releases the gate after a login and reports the state', async () => {
    const result = await call('GET /platform/restore-status');

    expect(backups.openGateAfterLogin).toHaveBeenCalledWith('sub-1', 'platform-admin');
    expect(result).toEqual({ kind: 'body', body: { gated: false } });
  });

  it('GET /platform/restore-status still answers when the gate release fails', async () => {
    backups.openGateAfterLogin.mockRejectedValue(new Error('gate locked'));

    const result = await call('GET /platform/restore-status');

    expect(result).toEqual({ kind: 'body', body: { gated: false } });
  });
});

describe('phase 4c registry', () => {
  it('implements the ten 4C operations', () => {
    expect(handlers.size).toBe(10);
  });
});
