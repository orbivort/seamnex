import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PipelineRegistry, type PipelineContext, type PipelineStage } from './pipeline-registry';
import { SYNTHETIC_STEPS } from './synthetic-job';

/**
 * The `synthetic` kind, kept as a diagnostic.
 *
 * It exists so an operator can prove the queue, the worker, the step table and the SSE stream work
 * on a host before a real deployment — and so the Phase 1 job tests keep exercising the worker
 * through the same registry a real pipeline uses. It performs no side effects and never touches
 * Docker; a synthetic job that could deploy would be a foot-gun with a reassuring name.
 */
@Injectable()
export class SyntheticPipeline implements OnModuleInit {
  // Explicit token: the runtime has no `emitDecoratorMetadata`, so a bare class parameter would
  // resolve to `undefined` and `register` would throw during `onModuleInit`.
  constructor(@Inject(PipelineRegistry) private readonly pipelines: PipelineRegistry) {}

  onModuleInit(): void {
    this.pipelines.register('synthetic', stages());
  }
}

function stages(): PipelineStage[] {
  return SYNTHETIC_STEPS.map((name, index) => ({
    name: index === 0 ? 'resolve' : index === SYNTHETIC_STEPS.length - 1 ? 'record' : 'apply',
    step: name,
    run: async (context: PipelineContext) => {
      await context.log('stdout', `${name}: synthetic stage, no side effects`);
      await sleep(name === 'apply' ? 600 : 300);
    },
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
