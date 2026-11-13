import { describe, expect, it } from 'vitest';
import {
  isPlatformLane,
  JOB_QUEUE_NAME,
  laneForInstance,
  PLATFORM_LANE,
  queueJobId,
} from '../../../src/jobs/job-lane';

describe('job lanes', () => {
  it('names the queue the worker consumes', () => {
    expect(JOB_QUEUE_NAME).toBe('seamnex-jobs');
    expect(PLATFORM_LANE).toBe('platform');
  });

  it('puts an instance job in its own lane and a platform job in the shared one', () => {
    expect(laneForInstance('i-1')).toBe('instance:i-1');
    expect(laneForInstance(null)).toBe(PLATFORM_LANE);
    expect(laneForInstance(undefined)).toBe(PLATFORM_LANE);
  });

  it('builds a BullMQ job id that contains no colon', () => {
    const id = queueJobId('instance:018f-abc', 'job-1');

    expect(id).toBe('instance-018f-abc--job-1');
    expect(id).not.toContain(':');
  });

  it('normalises every illegal character in a lane', () => {
    expect(queueJobId('weird lane/with:chars', 'job-2')).toBe('weird-lane-with-chars--job-2');
    expect(queueJobId(PLATFORM_LANE, 'job-3')).toBe('platform--job-3');
  });

  it('recognises the platform lane', () => {
    expect(isPlatformLane('platform')).toBe(true);
    expect(isPlatformLane('instance:i-1')).toBe(false);
  });
});
