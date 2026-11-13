import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyntheticPipeline } from '../../../src/jobs/synthetic-pipeline';
import type { PipelineRegistry, PipelineStage } from '../../../src/jobs/pipeline-registry';
import { SYNTHETIC_STEPS } from '../../../src/jobs/synthetic-job';

/**
 * The synthetic pipeline is the diagnostic that proves queue, worker, step table and stream work
 * before a real deployment. Two properties matter: it registers under `synthetic` only, and it
 * performs no side effects.
 */
function capture() {
  let registered: { kind: string; stages: PipelineStage[] } | undefined;
  const registry = {
    register: (kind: string, stages: PipelineStage[]) => {
      registered = { kind, stages };
    },
  };
  const pipeline = new SyntheticPipeline(registry as unknown as PipelineRegistry);
  return { pipeline, registered: () => registered };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SyntheticPipeline', () => {
  it('registers the synthetic kind on module init', () => {
    const { pipeline, registered } = capture();
    pipeline.onModuleInit();

    expect(registered()?.kind).toBe('synthetic');
    expect(registered()?.stages).toHaveLength(SYNTHETIC_STEPS.length);
  });

  it('names the first stage resolve and the last record, with apply in between', () => {
    const { pipeline, registered } = capture();
    pipeline.onModuleInit();
    const stages = registered()?.stages ?? [];

    expect(stages[0]?.name).toBe('resolve');
    expect(stages.at(-1)?.name).toBe('record');
    for (const stage of stages.slice(1, -1)) expect(stage.name).toBe('apply');
    expect(stages.map((stage) => stage.step)).toEqual([...SYNTHETIC_STEPS]);
  });

  it('logs each stage and completes without side effects', async () => {
    vi.useFakeTimers();
    const { pipeline, registered } = capture();
    pipeline.onModuleInit();
    const stages = registered()?.stages ?? [];
    const log = vi.fn().mockResolvedValue(undefined);

    const runs = stages.map((stage) => stage.run({ log } as never));
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(runs);

    for (const stage of stages) {
      expect(log).toHaveBeenCalledWith('stdout', `${stage.step}: synthetic stage, no side effects`);
    }
  });

  it('propagates a log failure so a broken worker is visible', async () => {
    vi.useFakeTimers();
    const { pipeline, registered } = capture();
    pipeline.onModuleInit();
    const stage = registered()?.stages[0];
    const run = stage?.run({ log: vi.fn().mockRejectedValue(new Error('log sink down')) } as never);

    await expect(run).rejects.toThrow('log sink down');
  });
});
