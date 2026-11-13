import { Module } from '@nestjs/common';
import { RendererModule } from '../m03-renderer/renderer.module';
import { CapacityModule } from '../m19-capacity/capacity.module';
import { PLANNER_SERVICE } from './planner.contract';
import { PostgresPlannerService } from './planner.service';

/** M04 — deployment plans: diff, policy verdict and capacity verdict (4A.4, 4A.7). */
@Module({
  imports: [RendererModule, CapacityModule],
  providers: [{ provide: PLANNER_SERVICE, useClass: PostgresPlannerService }],
  exports: [PLANNER_SERVICE],
})
export class PlannerModule {}
