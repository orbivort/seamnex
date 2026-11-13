import { Module } from '@nestjs/common';
import { CAPACITY_SERVICE } from './capacity.contract';
import { PostgresCapacityService } from './capacity.service';

/** M19 — capacity read model and the four-axis admission guard (4A.7). */
@Module({
  providers: [{ provide: CAPACITY_SERVICE, useClass: PostgresCapacityService }],
  exports: [CAPACITY_SERVICE],
})
export class CapacityModule {}
