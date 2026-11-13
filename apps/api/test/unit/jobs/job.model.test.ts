import { describe, expect, it } from 'vitest';
import { laneForInstance, queueJobId, PLATFORM_LANE } from '../../../src/jobs/job-lane';
import { canTransitionJob, cancellableAt, isTerminalJobState } from '../../../src/jobs/job-state';
import { SYNTHETIC_STEPS } from '../../../src/jobs/synthetic-job';

describe('job lanes', () => {
  it('uses one exclusive lane for platform work and one per instance otherwise', () => {
    expect(laneForInstance(null)).toBe(PLATFORM_LANE);
    expect(laneForInstance(undefined)).toBe(PLATFORM_LANE);
    expect(laneForInstance('abc')).toBe('instance:abc');
  });

  it('never puts a colon in a BullMQ job id', () => {
    // BullMQ uses ':' as its key delimiter and rejects a custom id containing one.
    expect(queueJobId('instance:abc', 'job-1')).toBe('instance-abc--job-1');
    expect(queueJobId('platform', 'job-1')).not.toContain(':');
  });
});

describe('job state machine', () => {
  it('permits the documented transitions and refuses the rest', () => {
    expect(canTransitionJob('queued', 'running')).toBe(true);
    expect(canTransitionJob('running', 'succeeded')).toBe(true);
    expect(canTransitionJob('running', 'cancelled')).toBe(true);
    expect(canTransitionJob('succeeded', 'running')).toBe(false);
    expect(canTransitionJob('failed', 'succeeded')).toBe(false);
  });

  it('treats succeeded, failed and cancelled as terminal', () => {
    expect(isTerminalJobState('succeeded')).toBe(true);
    expect(isTerminalJobState('failed')).toBe(true);
    expect(isTerminalJobState('cancelled')).toBe(true);
    expect(isTerminalJobState('running')).toBe(false);
  });

  it('allows cancellation only before apply (design §6.3)', () => {
    expect(
      cancellableAt([
        { name: 'preflight', state: 'succeeded' },
        { name: 'apply', state: 'pending' },
      ]),
    ).toBe(true);
    expect(cancellableAt([{ name: 'apply', state: 'running' }])).toBe(false);
    expect(cancellableAt([{ name: 'apply', state: 'succeeded' }])).toBe(false);
  });

  it('defines a synthetic pipeline with an apply boundary', () => {
    expect(SYNTHETIC_STEPS).toContain('apply');
    expect(SYNTHETIC_STEPS.indexOf('apply')).toBeLessThan(SYNTHETIC_STEPS.indexOf('done'));
  });
});
