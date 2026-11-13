import { describe, expect, it, vi } from 'vitest';
import { PipelineRegistry, type PipelineStage } from '../../../src/jobs/pipeline-registry';

function stage(name: PipelineStage['name'], step = name): PipelineStage {
  return { name, step, run: vi.fn().mockResolvedValue(undefined) };
}

describe('PipelineRegistry', () => {
  it('registers a kind and reports its stages and steps in order', () => {
    const registry = new PipelineRegistry();
    const stages = [stage('resolve'), stage('apply'), stage('record')];

    registry.register('deploy', stages);

    expect(registry.stages('deploy')).toBe(stages);
    expect(registry.stepsFor('deploy')).toEqual(['resolve', 'apply', 'record']);
    expect(registry.registered()).toEqual(['deploy']);
  });

  it('refuses a second registration of the same kind, naming both stage lists', () => {
    const registry = new PipelineRegistry();
    registry.register('deploy', [stage('resolve')]);

    expect(() => registry.register('deploy', [stage('apply')])).toThrow(
      /job kind deploy is registered twice \(resolve \/ apply\)/,
    );
  });

  it('replaces a fallback registration deliberately', () => {
    const registry = new PipelineRegistry();
    registry.register('lifecycle', [stage('resolve')]);
    registry.replace('lifecycle', [stage('apply')]);

    expect(registry.stepsFor('lifecycle')).toEqual(['apply']);
  });

  it('reports undefined stages and no steps for a kind nobody registered', () => {
    const registry = new PipelineRegistry();
    expect(registry.stages('unknown')).toBeUndefined();
    expect(registry.stepsFor('unknown')).toEqual([]);
  });

  it('stores a failure handler per kind, which may be absent', () => {
    const registry = new PipelineRegistry();
    const handler = vi.fn().mockResolvedValue(undefined);

    expect(registry.failureHandler('deploy')).toBeUndefined();

    registry.registerFailure('deploy', handler);
    expect(registry.failureHandler('deploy')).toBe(handler);
  });

  it('sorts the registered kinds so a listing is stable', () => {
    const registry = new PipelineRegistry();
    registry.register('restore', [stage('restore')]);
    registry.register('backup', [stage('backup')]);
    registry.register('deploy', [stage('resolve')]);

    expect(registry.registered()).toEqual(['backup', 'deploy', 'restore']);
  });
});
