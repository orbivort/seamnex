import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRole } from '../../../src/bootstrap/run-role';

/**
 * The lifecycle has one path the main suite never reaches: a boot that fails *after* the role unit
 * is already started. The closer exists by then, so it must still run — and if the closer itself
 * fails, that failure is swallowed, because the process is already leaving with code 1 and a second
 * error must not turn a failed boot into a failed drain (code 2).
 *
 * The container, the config loader and `process.exit` are replaced exactly as in the main suite;
 * only the ordering of the failure is different.
 */
const h = vi.hoisted(() => {
  const codes: number[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };

  return {
    codes,
    logger,
    loadRootEnv: vi.fn(),
    createApplication: vi.fn(),
    loadConfig: vi.fn(),
    describeConfig: vi.fn(),
    createLogger: vi.fn(),
    roleDefinition: vi.fn(),
    startRoleWork: vi.fn(),
    setLoadedConfig: vi.fn(),
  };
});

vi.mock('@seamnex/db/env', () => ({ loadRootEnv: h.loadRootEnv }));
vi.mock('../../../src/bootstrap/create-app', () => ({ createApplication: h.createApplication }));
vi.mock('../../../src/config/config', () => ({
  ConfigError: class ConfigError extends Error {},
  ROLE_IDS: ['api', 'deploy-worker'],
  loadConfig: h.loadConfig,
  describeConfig: h.describeConfig,
}));
vi.mock('../../../src/common/logging/logger', () => ({ createLogger: h.createLogger }));
vi.mock('../../../src/roles/registry', () => ({ roleDefinition: h.roleDefinition }));
vi.mock('../../../src/roles/start-role-work', () => ({ startRoleWork: h.startRoleWork }));
vi.mock('../../../src/config/config.module', () => ({ setLoadedConfig: h.setLoadedConfig }));

const CONFIG = {
  PORT: 3000,
  HOST: '0.0.0.0',
  LOG_LEVEL: 'info',
  SEAMNEX_ROLE: 'deploy-worker',
};

/** A worker that boots for topology parity only: it starts, then the idle warning is emitted. */
const IDLE_WORKER = {
  id: 'deploy-worker',
  kind: 'worker' as const,
  implemented: false,
  phase: '5',
  description: 'deploy worker',
};

beforeEach(() => {
  // `resetAllMocks` would also drop the return values the module factories rely on, so the
  // implementations are re-stated here rather than relying on hoisted defaults.
  vi.resetAllMocks();
  h.codes.length = 0;
  h.loadConfig.mockImplementation(() => CONFIG);
  h.describeConfig.mockImplementation(() => ({ role: 'deploy-worker' }));
  h.createLogger.mockImplementation(() => h.logger);
  h.roleDefinition.mockImplementation(() => IDLE_WORKER);

  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    h.codes.push(code ?? 0);
    return undefined as never;
  }) as never);
  // Registering a real handler would leak it into the Vitest worker for the rest of the run.
  vi.spyOn(process, 'on').mockImplementation((() => process) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runRole: a failure after the unit started', () => {
  it('closes the role work it already started before exiting 1', async () => {
    const close = vi.fn(async () => undefined);
    h.startRoleWork.mockImplementation(async () => ({ close }));
    h.logger.warn.mockImplementation(() => {
      throw new Error('log sink closed');
    });

    await runRole('deploy-worker');

    expect(close).toHaveBeenCalledOnce();
    expect(h.codes).toEqual([1]);
    expect(h.logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('log sink closed') }),
      'role failed to start',
    );
  });

  it('swallows a closer that fails, so a failed boot still exits 1 rather than 2', async () => {
    const close = vi.fn(async () => {
      throw new Error('queue would not close');
    });
    h.startRoleWork.mockImplementation(async () => ({ close }));
    h.logger.warn.mockImplementation(() => {
      throw new Error('log sink closed');
    });

    await runRole('deploy-worker');

    expect(close).toHaveBeenCalledOnce();
    // One exit, code 1: the swallowed closer produced neither a second exit nor a timeout code.
    expect(h.codes).toEqual([1]);
    expect(h.logger.error).not.toHaveBeenCalled();
  });
});
