import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createPool } from '@seamnex/db';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';

export const PG_POOL = Symbol('seamnex.pg.pool');

/**
 * The pool is created once per process. Workers take a smaller one than the API, because a worker
 * holds a connection for the duration of a step, not for a request. The size comes from
 * `config.poolMax`, which derives it from the role — reading `DATABASE_POOL_MAX` here applied the
 * API ceiling to all nine roles and put ninety connections on a cluster sized for a hundred.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Pool => {
        const logger = new Logger('postgres');
        const pool = createPool({
          connectionString: config.DATABASE_URL,
          max: config.poolMax,
          applicationName: `seamnex-${config.SEAMNEX_ROLE}`,
          // The pool drops the client either way; a warning is what tells an operator that the
          // database is bouncing instead of leaving it to be inferred from latency graphs.
          onError: (error) => logger.warn(`idle client error: ${error.message}`),
        });
        logger.log(
          `pool seamnex-${config.SEAMNEX_ROLE}: max=${config.poolMax} ` +
            `(DATABASE_POOL_MAX=${config.DATABASE_POOL_MAX}, budget=${config.DATABASE_CONNECTION_BUDGET})`,
        );
        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    // Draining the pool is part of graceful shutdown: a job that is mid-transaction gets its
    // COMMIT or its ROLLBACK before the connection disappears.
    await this.pool.end().catch(() => undefined);
  }
}
