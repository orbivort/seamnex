import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { createMetrics, METRICS } from './metrics';

@Global()
@Module({
  providers: [
    {
      provide: METRICS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createMetrics(config.SEAMNEX_ROLE),
    },
  ],
  exports: [METRICS],
})
export class MetricsModule {}
