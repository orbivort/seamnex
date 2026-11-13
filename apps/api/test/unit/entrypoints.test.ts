import { describe, expect, it, vi } from 'vitest';

/**
 * Every entrypoint and `start:role` are one line each, and that line is the only place the role
 * string appears. A typo there boots the wrong role — the failure is a process that looks healthy
 * and answers nothing — so each module is imported and the call it makes is asserted.
 */
const runRole = vi.fn().mockResolvedValue(undefined);
const runRoleFromEnvironment = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/bootstrap/run-role', () => ({ runRole, runRoleFromEnvironment }));

const ENTRYPOINTS: ReadonlyArray<[module: string, role: string]> = [
  ['../../src/main-api', 'api'],
  ['../../src/main-auth-gateway', 'auth-gateway'],
  ['../../src/main-backup-runner', 'backup-runner'],
  ['../../src/main-broker-proxy', 'broker-proxy'],
  ['../../src/main-deploy-worker', 'deploy-worker'],
  ['../../src/main-relay', 'relay'],
  ['../../src/main-scheduler', 'scheduler'],
  ['../../src/main-status-sampler', 'status-sampler'],
  ['../../src/main-sync-worker', 'sync-worker'],
  ['../../src/main-trigger-ingress', 'trigger-ingress'],
];

describe('role entrypoints', () => {
  it.each(ENTRYPOINTS)('%s hosts the %s role', async (modulePath, role) => {
    runRole.mockClear();
    await import(/* @vite-ignore */ modulePath);
    expect(runRole).toHaveBeenCalledWith(role);
  });

  it('starts the role named by SEAMNEX_ROLE through start:role', async () => {
    runRoleFromEnvironment.mockClear();
    await import('../../src/roles/start');
    expect(runRoleFromEnvironment).toHaveBeenCalledOnce();
  });

  it('covers every main-*.ts file on disk', async () => {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync('src')
      .filter((name) => name.startsWith('main-') && name.endsWith('.ts'))
      .map((name) => `../../src/${name.replace(/\.ts$/, '')}`);
    expect(files.sort()).toEqual(ENTRYPOINTS.map(([module]) => module).sort());
  });
});
