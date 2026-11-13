import { describe, expect, it, vi } from 'vitest';

/**
 * `ioredis` is mocked: constructing the real client would open a socket from a unit test. What the
 * module owns is the option set (BullMQ requires `maxRetriesPerRequest: null`) and the two event
 * handlers that keep a transient reconnect from crashing the process.
 */
const clients: Array<{
  url: string;
  options: Record<string, unknown>;
  handlers: Record<string, (...args: unknown[]) => void>;
  quit: ReturnType<typeof vi.fn>;
}> = [];

class FakeRedis {
  readonly url: string;
  readonly options: Record<string, unknown>;
  readonly handlers: Record<string, (...args: unknown[]) => void> = {};
  readonly quit = vi.fn().mockResolvedValue('OK');

  constructor(url: string, options: Record<string, unknown>) {
    this.url = url;
    this.options = options;
    clients.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers[event] = handler;
    return this;
  }
}

vi.mock('ioredis', () => ({ Redis: FakeRedis, default: FakeRedis }));

const { RedisModule, REDIS } = await import('../../../src/redis/redis.module');

function factory(): (config: unknown) => { on: unknown; quit: unknown } {
  const providers = Reflect.getMetadata('providers', RedisModule) as Array<{
    provide: symbol;
    useFactory: (config: unknown) => { on: unknown; quit: unknown };
  }>;
  const provider = providers.find((candidate) => candidate.provide === REDIS);
  if (provider === undefined) throw new Error('REDIS provider is not registered');
  return provider.useFactory;
}

describe('RedisModule', () => {
  it('opens one multiplexed connection with the BullMQ-compatible option set', () => {
    factory()({ REDIS_URL: 'redis://cache:6379' });

    const client = clients.at(-1);
    expect(client?.url).toBe('redis://cache:6379');
    expect(client?.options).toMatchObject({
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  });

  it('caps the reconnect backoff at five seconds', () => {
    factory()({ REDIS_URL: 'redis://cache:6379' });
    const retryStrategy = clients.at(-1)?.options['retryStrategy'] as (attempt: number) => number;

    expect(retryStrategy(1)).toBe(200);
    expect(retryStrategy(10)).toBe(2_000);
    expect(retryStrategy(1_000)).toBe(5_000);
  });

  it('handles the error and reconnecting events without throwing', () => {
    factory()({ REDIS_URL: 'redis://cache:6379' });
    const client = clients.at(-1);

    expect(() => client?.handlers['error']?.(new Error('ECONNRESET'))).not.toThrow();
    expect(() => client?.handlers['reconnecting']?.()).not.toThrow();
  });

  it('quits on shutdown and ignores an already-closed connection', async () => {
    const module = new RedisModule({ quit: vi.fn().mockResolvedValue('OK') } as never);
    await module.onApplicationShutdown();
    expect(
      (module as unknown as { redis: { quit: ReturnType<typeof vi.fn> } }).redis.quit,
    ).toHaveBeenCalledOnce();

    const failing = new RedisModule({
      quit: vi.fn().mockRejectedValue(new Error('closed')),
    } as never);
    await expect(failing.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
