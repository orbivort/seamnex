import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';

export const REDIS = Symbol('seamnex.redis');

/**
 * One connection for commands, pub/sub and the decision cache — Redis 7 multiplexes them.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ (a retried command must not be abandoned
 * mid-flight) and is therefore the process-wide setting.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis => {
        const logger = new Logger('redis');
        const client = new Redis(config.REDIS_URL, {
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          lazyConnect: false,
          retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
        });

        // An unhandled 'error' event would crash the process on a transient reconnect.
        client.on('error', (error: Error) => logger.warn(`redis: ${error.message}`));
        client.on('reconnecting', () => logger.warn('redis: reconnecting'));
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
