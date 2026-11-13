import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase4AHandlers } from '../../../../src/contract/handlers/phase4a.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { callHandler, operationInput } from '../../../support/operation-input';

let s: ReturnType<typeof services>;
let handlers: ReadonlyMap<string, OperationHandler>;
let withBackups: (backups?: unknown) => ReadonlyMap<string, OperationHandler>;

function services() {
  return {
    executor: {
      deploy: vi.fn().mockResolvedValue({ instanceId: 'i1', jobId: 'job-deploy' }),
      preview: vi.fn().mockResolvedValue({ plan: [] }),
      lifecycle: vi.fn().mockResolvedValue({ jobId: 'job-life' }),
      prefetch: vi.fn().mockResolvedValue({ jobId: 'job-prefetch' }),
      abandonDeployment: vi.fn().mockResolvedValue(undefined),
    },
    sources: {
      scaffold: vi.fn().mockResolvedValue({ draftId: 'd1' }),
      confirmScaffold: vi.fn().mockResolvedValue({ key: 'D01-01' }),
    },
    params: {
      assertWritable: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
    },
    jobs: { cancel: vi.fn().mockResolvedValue(undefined) },
    portal: { grantInstanceOwner: vi.fn().mockResolvedValue(true) },
    backups: {
      createInstanceBackup: vi.fn().mockResolvedValue({ jobId: 'job-backup' }),
    },
  };
}

beforeEach(() => {
  s = services();
  withBackups = (backups?: unknown) =>
    new Phase4AHandlers(
      s.executor as never,
      s.sources as never,
      s.params as never,
      s.jobs as never,
      s.portal as never,
      backups as never,
    ).handlers();
  handlers = withBackups(s.backups);
});

const call = (key: string, overrides = {}) =>
  callHandler(handlers, key, operationInput(key, overrides));

describe('POST /instances', () => {
  const body = { entryKey: 'D01-01', slug: 'mail' };

  it('commits the definition and answers 202', async () => {
    const result = await call('POST /instances', { body });

    expect(s.params.assertWritable).toHaveBeenCalledOnce();
    expect(s.executor.deploy).toHaveBeenCalledWith({
      entryKey: 'D01-01',
      slug: 'mail',
      actorId: 'sub-1',
    });
    expect(s.params.write).toHaveBeenCalledWith('i1', 'sub-1');
    expect(result).toEqual({ kind: 'accepted', jobId: 'job-deploy' });
  });

  it('grants the deploying operator portal access to the new instance', async () => {
    await call('POST /instances', { body });

    // The portal lists entitlements, not instances: without this row the deployment is published
    // at the edge and absent from the launcher.
    expect(s.portal.grantInstanceOwner).toHaveBeenCalledWith('i1', 'sub-1');
  });

  it('rolls the deployment back when the owner grant cannot be written', async () => {
    s.portal.grantInstanceOwner.mockRejectedValue(new Error('entitlement insert failed'));

    await expect(call('POST /instances', { body })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: expect.stringContaining('entitlement insert failed'),
    });

    expect(s.jobs.cancel).toHaveBeenCalledWith('job-deploy', 'sub-1');
    expect(s.params.write).not.toHaveBeenCalled();
    expect(s.executor.abandonDeployment).toHaveBeenCalledWith(
      'i1',
      'sub-1',
      expect.stringContaining('portal access'),
    );
  });

  it('rolls the deployment back when the instance the grant targets is gone', async () => {
    s.portal.grantInstanceOwner.mockResolvedValue(false);

    await expect(call('POST /instances', { body })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });

    expect(s.params.write).not.toHaveBeenCalled();
    expect(s.executor.abandonDeployment).toHaveBeenCalledWith(
      'i1',
      'sub-1',
      expect.stringContaining('portal access'),
    );
  });

  it('forwards every optional deployment input that is present', async () => {
    await call('POST /instances', {
      body: {
        entryKey: 'D01-01',
        slug: 'mail',
        profile: 'prod',
        resources: { cpu: 1, memoryMb: 512, diskMb: 1024 },
        envOverrides: { MAIL_HOST: 'smtp' },
      },
    });

    expect(s.executor.deploy).toHaveBeenCalledWith({
      entryKey: 'D01-01',
      slug: 'mail',
      profileKey: 'prod',
      resources: { cpu: 1, memoryMb: 512, diskMb: 1024 },
      envOverrides: { MAIL_HOST: 'smtp' },
      actorId: 'sub-1',
    });
  });

  it('rolls the deployment back when the definition cannot be committed', async () => {
    s.params.write.mockRejectedValue(new Error('read-only'));

    await expect(call('POST /instances', { body })).rejects.toMatchObject({
      code: 'REPOSITORY_UNAVAILABLE',
      detail: expect.stringContaining('read-only'),
    });

    expect(s.jobs.cancel).toHaveBeenCalledWith('job-deploy', 'sub-1');
    expect(s.executor.abandonDeployment).toHaveBeenCalledWith(
      'i1',
      'sub-1',
      expect.stringContaining('instance.yaml'),
    );
  });

  it('stringifies a non-Error commit failure', async () => {
    s.params.write.mockRejectedValue('nope');
    await expect(call('POST /instances', { body })).rejects.toMatchObject({
      code: 'REPOSITORY_UNAVAILABLE',
      detail: expect.stringContaining('nope'),
    });
  });

  it('still reports the repository failure when cancelling the job also fails', async () => {
    s.params.write.mockRejectedValue(new Error('read-only'));
    s.jobs.cancel.mockRejectedValue(new Error('already finished'));

    await expect(call('POST /instances', { body })).rejects.toMatchObject({
      code: 'REPOSITORY_UNAVAILABLE',
    });
  });
});

describe('POST /instances/preview', () => {
  it('previews without writing anything', async () => {
    const result = await call('POST /instances/preview', {
      body: { entryKey: 'D01-01', slug: 'mail', profile: 'prod' },
    });

    expect(s.executor.preview).toHaveBeenCalledWith({
      entryKey: 'D01-01',
      slug: 'mail',
      profileKey: 'prod',
    });
    expect(s.params.write).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'body', body: { plan: [] } });
  });

  it('previews with no optional input', async () => {
    await call('POST /instances/preview', { body: { entryKey: 'D01-01', slug: 'mail' } });
    expect(s.executor.preview).toHaveBeenCalledWith({ entryKey: 'D01-01', slug: 'mail' });
  });

  it('previews with resource and environment overrides', async () => {
    await call('POST /instances/preview', {
      body: {
        entryKey: 'D01-01',
        slug: 'mail',
        resources: { cpu: 2, memoryMb: 1024, diskMb: 2048 },
        envOverrides: { MAIL_HOST: 'smtp' },
      },
    });

    expect(s.executor.preview).toHaveBeenCalledWith({
      entryKey: 'D01-01',
      slug: 'mail',
      resources: { cpu: 2, memoryMb: 1024, diskMb: 2048 },
      envOverrides: { MAIL_HOST: 'smtp' },
    });
  });
});

describe('POST /instances/:id/:action', () => {
  it('runs a non-upgrade action without a pre-upgrade backup', async () => {
    const result = await call('POST /instances/:id/:action', {
      params: { id: 'i1', action: 'restart' },
      body: { justification: 'maintenance' },
    });

    expect(s.backups.createInstanceBackup).not.toHaveBeenCalled();
    expect(s.executor.lifecycle).toHaveBeenCalledWith({
      instanceId: 'i1',
      action: 'restart',
      actorId: 'sub-1',
      justification: 'maintenance',
    });
    expect(result).toEqual({ kind: 'accepted', jobId: 'job-life' });
  });

  it('creates the pre-upgrade backup before the upgrade job exists', async () => {
    await call('POST /instances/:id/:action', {
      params: { id: 'i1', action: 'upgrade' },
      body: { version: '2.0.0', dataRetention: 'keep' },
    });

    expect(s.backups.createInstanceBackup).toHaveBeenCalledWith('i1', 'sub-1');
    expect(s.executor.lifecycle).toHaveBeenCalledWith({
      instanceId: 'i1',
      action: 'upgrade',
      actorId: 'sub-1',
      backupJobId: 'job-backup',
      dataRetention: 'keep',
      renderSetId: '2.0.0',
    });
  });

  it('refuses an upgrade honestly when the backup module is not in this build', async () => {
    handlers = withBackups(undefined);

    await expect(
      call('POST /instances/:id/:action', { params: { id: 'i1', action: 'upgrade' } }),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    expect(s.executor.lifecycle).not.toHaveBeenCalled();
  });

  it('refuses a missing action parameter', async () => {
    await expect(
      call('POST /instances/:id/:action', { params: { id: 'i1' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('catalog actions', () => {
  it('POST /catalog/:key/prefetch answers 202', async () => {
    const result = await call('POST /catalog/:key/prefetch', { params: { key: 'D01-01' } });
    expect(s.executor.prefetch).toHaveBeenCalledWith('D01-01', 'sub-1');
    expect(result).toEqual({ kind: 'accepted', jobId: 'job-prefetch' });
  });

  it('GET /catalog/:key/scaffold returns the draft', async () => {
    const result = await call('GET /catalog/:key/scaffold', { params: { key: 'D01-01' } });
    expect(s.sources.scaffold).toHaveBeenCalledWith('D01-01');
    expect(result).toEqual({ kind: 'body', body: { draftId: 'd1' } });
  });

  it('POST /catalog/:key/scaffold/:draftId/confirm commits as the caller', async () => {
    const result = await call('POST /catalog/:key/scaffold/:draftId/confirm', {
      params: { key: 'D01-01', draftId: 'd1' },
    });
    expect(s.sources.confirmScaffold).toHaveBeenCalledWith('D01-01', 'd1', 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { key: 'D01-01' } });
  });

  it('refuses a scaffold confirmation without a draft id', async () => {
    await expect(
      call('POST /catalog/:key/scaffold/:draftId/confirm', { params: { key: 'D01-01' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('phase 4a registry', () => {
  it('implements the six 4A operations', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'GET /catalog/:key/scaffold',
      'POST /catalog/:key/prefetch',
      'POST /catalog/:key/scaffold/:draftId/confirm',
      'POST /instances',
      'POST /instances/:id/:action',
      'POST /instances/preview',
    ]);
  });
});
