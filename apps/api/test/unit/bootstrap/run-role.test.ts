import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRole, runRoleFromEnvironment } from '../../../src/bootstrap/run-role';

/**
 * One lifecycle for all nine roles, and the only place the exit-code contract is written down:
 * `0` clean drain, `1` boot failure, `2` a drain that did not finish inside 20 s.
 *
 * The lifecycle is driven here with the container, the config loader and `process.exit` replaced.
 * `process.exit` is the interesting one: it throws a sentinel in the tests that expect execution to
 * stop, because a mocked exit that merely returns would let the function carry on into the next
 * phase with the very config it just rejected.
 */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: never[]) => void>();
  const codes: number[] = [];
  const state = { throwOnExit: false };

  class TestConfigError extends Error {
    constructor(readonly issues: unknown) {
      super('invalid configuration');
    }
  }

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };

  return {
    handlers,
    codes,
    state,
    TestConfigError,
    logger,
    loadRootEnv: vi.fn(),
    createApplication: vi.fn(),
    loadConfig: vi.fn(),
    describeConfig: vi.fn(() => ({ role: 'api' })),
    createLogger: vi.fn(() => logger),
    roleDefinition: vi.fn(),
    startRoleWork: vi.fn(),
    setLoadedConfig: vi.fn(),
  };
});

vi.mock('@seamnex/db/env', () => ({ loadRootEnv: h.loadRootEnv }));
vi.mock('../../../src/bootstrap/create-app', () => ({ createApplication: h.createApplication }));
vi.mock('../../../src/config/config', () => ({
  ConfigError: h.TestConfigError,
  ROLE_IDS: ['api', 'scheduler', 'deploy-worker'],
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
  SEAMNEX_ROLE: 'api',
  // The relay roles publish their configuration warnings at boot, and a parsed `AppConfig` always
  // carries this key (the schema default); a stub without it reads as a broken configuration.
  SEAMNEX_RELAY_ENTRY_KEYS: 'D09-01',
};

type Definition = {
  id: string;
  kind: 'http' | 'worker' | 'scheduler' | 'stateless';
  implemented: boolean;
  phase: string;
  description: string;
};

function httpDefinition(overrides: Partial<Definition> = {}): Definition {
  return {
    id: 'api',
    kind: 'http',
    implemented: true,
    phase: '1',
    description: 'api',
    ...overrides,
  };
}

/** Let the async shutdown that the signal handler fires finish. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  h.handlers.clear();
  h.codes.length = 0;
  h.state.throwOnExit = false;
  h.loadConfig.mockImplementation(() => CONFIG);
  h.roleDefinition.mockImplementation(() => httpDefinition());
  h.createApplication.mockImplementation(async () => ({
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }));

  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    const value = code ?? 0;
    h.codes.push(value);
    if (h.state.throwOnExit) throw new ExitSignal(value);
    return undefined as never;
  }) as never);

  // Registering a real handler would leak it into the Vitest worker for the rest of the run.
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: never) => {
    h.handlers.set(event, handler);
    return process;
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runRole: boot', () => {
  it('loads the root env, parses config for this role and publishes it before the container', async () => {
    await runRole('api');

    expect(h.loadRootEnv).toHaveBeenCalledOnce();
    expect(h.loadConfig).toHaveBeenCalledWith(expect.objectContaining({ SEAMNEX_ROLE: 'api' }));
    expect(h.setLoadedConfig).toHaveBeenCalledWith(CONFIG);
    // The container factory would otherwise re-parse `process.env`, where SEAMNEX_ROLE is unset.
    expect(h.setLoadedConfig.mock.invocationCallOrder[0]).toBeLessThan(
      h.createApplication.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('logs the effective configuration at start', async () => {
    await runRole('api');
    expect(h.describeConfig).toHaveBeenCalledWith(CONFIG);
    expect(h.logger.info).toHaveBeenCalledWith({ role: 'api' }, 'role api starting');
  });

  it('listens on the configured host and port for an http role', async () => {
    const listen = vi.fn(async () => undefined);
    h.createApplication.mockImplementation(async () => ({ listen, close: vi.fn() }));

    await runRole('api');

    expect(listen).toHaveBeenCalledWith({ port: 3000, host: '0.0.0.0' });
  });

  it('starts the role work for a worker role and keeps its closer', async () => {
    const close = vi.fn(async () => undefined);
    h.roleDefinition.mockImplementation(() =>
      httpDefinition({ id: 'deploy-worker', kind: 'worker' }),
    );
    h.startRoleWork.mockImplementation(async () => ({ close }));

    await runRole('deploy-worker');
    expect(h.startRoleWork).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({ kind: 'worker' }),
      h.logger,
    );
    expect(h.createApplication).not.toHaveBeenCalled();

    h.handlers.get('SIGTERM')?.();
    await flush();
    expect(close).toHaveBeenCalledOnce();
  });

  it('says out loud that an unimplemented role is idle', async () => {
    h.roleDefinition.mockImplementation(() =>
      httpDefinition({ kind: 'worker', implemented: false, phase: '5' }),
    );
    h.startRoleWork.mockImplementation(async () => ({ close: vi.fn() }));

    await runRole('api');

    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'api', phase: '5' }),
      expect.stringContaining('role.idle'),
    );
  });

  it('exits 1 and logs fatally when the app fails to start', async () => {
    h.createApplication.mockRejectedValue(new Error('port in use'));

    await runRole('api');

    expect(h.codes).toEqual([1]);
    expect(h.logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('port in use') }),
      'role failed to start',
    );
  });

  it('stringifies a boot failure that is not an Error', async () => {
    h.createApplication.mockRejectedValue('port in use');

    await runRole('api');

    expect(h.codes).toEqual([1]);
    expect(h.logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'port in use' }),
      'role failed to start',
    );
  });
});

describe('runRole: configuration failure', () => {
  it('logs the issues — never the values — and exits 1', async () => {
    h.state.throwOnExit = true;
    const issues = [{ path: ['DATABASE_URL'], message: 'Required' }];
    h.loadConfig.mockImplementation(() => {
      throw new h.TestConfigError(issues);
    });

    await expect(runRole('api')).rejects.toThrow('exit:1');

    expect(h.codes).toEqual([1]);
    expect(h.logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ issues }),
      'invalid configuration; refusing to start',
    );
    expect(h.createApplication).not.toHaveBeenCalled();
  });

  it('still exits 1 for a failure that is not a ConfigError', async () => {
    h.state.throwOnExit = true;
    h.loadConfig.mockImplementation(() => {
      throw 'not even an Error';
    });

    await expect(runRole('api')).rejects.toThrow('exit:1');

    expect(h.logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ issues: undefined, err: 'not even an Error' }),
      'invalid configuration; refusing to start',
    );
  });

  it('falls back to the info level when LOG_LEVEL is not a pino level', async () => {
    h.state.throwOnExit = true;
    process.env.LOG_LEVEL = 'loud';
    h.loadConfig.mockImplementation(() => {
      throw new Error('nope');
    });

    await expect(runRole('api')).rejects.toThrow();

    expect(h.createLogger).toHaveBeenCalledWith({ level: 'info', role: 'api' });
    delete process.env.LOG_LEVEL;
  });

  it('uses LOG_LEVEL when it is a valid pino level', async () => {
    h.state.throwOnExit = true;
    process.env.LOG_LEVEL = 'debug';
    h.loadConfig.mockImplementation(() => {
      throw new Error('nope');
    });

    await expect(runRole('api')).rejects.toThrow();

    expect(h.createLogger).toHaveBeenCalledWith({ level: 'debug', role: 'api' });
    delete process.env.LOG_LEVEL;
  });
});

describe('runRole: shutdown', () => {
  it('closes the app on SIGTERM and exits 0', async () => {
    const close = vi.fn(async () => undefined);
    h.createApplication.mockImplementation(async () => ({ listen: vi.fn(), close }));

    await runRole('api');
    h.handlers.get('SIGTERM')?.();
    await flush();

    expect(close).toHaveBeenCalledOnce();
    expect(h.codes).toEqual([0]);
    expect(h.logger.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'shutdown requested');
    expect(h.logger.info).toHaveBeenCalledWith('shutdown complete');
  });

  it('honours SIGINT the same way', async () => {
    await runRole('api');
    h.handlers.get('SIGINT')?.();
    await flush();
    expect(h.codes).toEqual([0]);
  });

  it('drains only once, however many signals arrive', async () => {
    const close = vi.fn(async () => undefined);
    h.createApplication.mockImplementation(async () => ({ listen: vi.fn(), close }));

    await runRole('api');
    h.handlers.get('SIGTERM')?.();
    h.handlers.get('SIGINT')?.();
    await flush();

    expect(close).toHaveBeenCalledOnce();
    expect(h.codes).toEqual([0]);
  });

  it('exits 1 when the drain throws', async () => {
    h.createApplication.mockImplementation(async () => ({
      listen: vi.fn(),
      close: vi.fn(async () => {
        throw new Error('pool would not close');
      }),
    }));

    await runRole('api');
    h.handlers.get('SIGTERM')?.();
    await flush();

    expect(h.codes).toEqual([1]);
    expect(h.logger.error).toHaveBeenCalledWith({ err: 'pool would not close' }, 'shutdown failed');
  });

  it('stringifies a non-Error drain failure', async () => {
    h.createApplication.mockImplementation(async () => ({
      listen: vi.fn(),
      close: vi.fn(async () => {
        throw 'drain aborted';
      }),
    }));

    await runRole('api');
    h.handlers.get('SIGTERM')?.();
    await flush();

    expect(h.codes).toEqual([1]);
    expect(h.logger.error).toHaveBeenCalledWith({ err: 'drain aborted' }, 'shutdown failed');
  });

  it('exits 2 when the drain does not finish inside the guard window', async () => {
    vi.useFakeTimers();
    h.createApplication.mockImplementation(async () => ({
      listen: vi.fn(),
      close: vi.fn(() => new Promise<void>(() => undefined)),
    }));

    await runRole('api');
    h.handlers.get('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(h.codes).toEqual([2]);
    expect(h.logger.error).toHaveBeenCalledWith('shutdown timed out; exiting with code 2');
  });
});

describe('runRole: process-level failures', () => {
  it('logs an unhandled rejection and exits 1', async () => {
    await runRole('api');
    h.handlers.get('unhandledRejection')?.(new Error('floating promise') as never);

    expect(h.codes).toEqual([1]);
    expect(h.logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('floating promise') }),
      'unhandled promise rejection',
    );
  });

  it('stringifies a non-Error rejection reason', async () => {
    await runRole('api');
    h.handlers.get('unhandledRejection')?.('plain string' as never);

    expect(h.logger.fatal).toHaveBeenCalledWith(
      { err: 'plain string' },
      'unhandled promise rejection',
    );
  });

  it('logs an uncaught exception and exits 1', async () => {
    await runRole('api');
    h.handlers.get('uncaughtException')?.(new Error('segfault-ish') as never);

    expect(h.codes).toEqual([1]);
    expect(h.logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('segfault-ish') }),
      'uncaught exception',
    );
  });

  it('falls back to the message for an exception that carries no stack', async () => {
    await runRole('api');
    h.handlers.get('uncaughtException')?.({ message: 'stack-less' } as never);

    expect(h.logger.fatal).toHaveBeenCalledWith({ err: 'stack-less' }, 'uncaught exception');
  });
});

describe('runRoleFromEnvironment', () => {
  it('refuses an unknown role before parsing configuration', async () => {
    h.state.throwOnExit = true;
    process.env.SEAMNEX_ROLE = 'not-a-role';

    await expect(runRoleFromEnvironment()).rejects.toThrow('exit:1');

    expect(h.codes).toEqual([1]);
    expect(h.logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ requestedRole: 'not-a-role' }),
      'unknown SEAMNEX_ROLE; refusing to start',
    );
    expect(h.loadConfig).not.toHaveBeenCalled();
    delete process.env.SEAMNEX_ROLE;
  });

  it('defaults to the api role when SEAMNEX_ROLE is unset', async () => {
    delete process.env.SEAMNEX_ROLE;
    h.roleDefinition.mockImplementation(() => httpDefinition());

    await runRoleFromEnvironment();

    expect(h.loadConfig).toHaveBeenCalledWith(expect.objectContaining({ SEAMNEX_ROLE: 'api' }));
  });

  it('runs the role named by SEAMNEX_ROLE', async () => {
    process.env.SEAMNEX_ROLE = 'scheduler';
    h.roleDefinition.mockImplementation(() =>
      httpDefinition({ id: 'scheduler', kind: 'scheduler' }),
    );
    h.startRoleWork.mockImplementation(async () => ({ close: vi.fn() }));

    await runRoleFromEnvironment();

    expect(h.loadConfig).toHaveBeenCalledWith(
      expect.objectContaining({ SEAMNEX_ROLE: 'scheduler' }),
    );
    expect(h.startRoleWork).toHaveBeenCalledOnce();
    delete process.env.SEAMNEX_ROLE;
  });
});
