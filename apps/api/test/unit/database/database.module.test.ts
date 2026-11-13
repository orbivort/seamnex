import { describe, expect, it, vi } from 'vitest';

/**
 * The pool factory and the shutdown drain. `@seamnex/db` is mocked so the test asserts the arguments the
 * module passes — pool size and application name are the difference between ninety connections on a
 * cluster sized for a hundred and the per-role budget this module is responsible for.
 */
const createPool = vi.fn((_config: unknown) => ({
  end: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@seamnex/db', () => ({ createPool }));

const { DatabaseModule, PG_POOL } = await import('../../../src/database/database.module');

function factory(): (config: unknown) => { end: () => Promise<void> } {
  const providers = Reflect.getMetadata('providers', DatabaseModule) as Array<{
    provide: symbol;
    useFactory: (config: unknown) => { end: () => Promise<void> };
  }>;
  const provider = providers.find((candidate) => candidate.provide === PG_POOL);
  if (provider === undefined) throw new Error('PG_POOL provider is not registered');
  return provider.useFactory;
}

describe('DatabaseModule', () => {
  it('creates one pool per process, sized by the role and named after it', () => {
    const config = {
      DATABASE_URL: 'postgres://seamnex@db:5432/seamnex',
      poolMax: 6,
      SEAMNEX_ROLE: 'deploy-worker',
      DATABASE_POOL_MAX: '10',
      DATABASE_CONNECTION_BUDGET: '100',
    };

    factory()(config);

    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://seamnex@db:5432/seamnex',
        max: 6,
        applicationName: 'seamnex-deploy-worker',
      }),
    );
  });

  it('warns through the pool error hook instead of letting an idle error crash the process', () => {
    factory()({ DATABASE_URL: 'postgres://x', poolMax: 2, SEAMNEX_ROLE: 'api' } as never);

    const options = createPool.mock.calls.at(-1)?.[0] as unknown as {
      onError: (error: Error) => void;
    };
    expect(() => options.onError(new Error('terminating connection'))).not.toThrow();
  });

  it('drains the pool on shutdown and ignores an already-closed pool', async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const module = new DatabaseModule({ end } as never);

    await module.onApplicationShutdown();
    expect(end).toHaveBeenCalledOnce();

    const failing = new DatabaseModule({
      end: vi.fn().mockRejectedValue(new Error('already ended')),
    } as never);
    await expect(failing.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
