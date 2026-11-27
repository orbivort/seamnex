import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../modules/m21-observability/observability.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  // The per-instance exposition lives here rather than in the contract: Prometheus is not a
  // session-bearing client, and the declared API is the authenticated product surface.
  imports: [ObservabilityModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
