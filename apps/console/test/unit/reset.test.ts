import { describe, expect, it } from 'vitest';
import { getState, pendingTimerCount, resetState } from '@seamnex/mocks';

/**
 * A scenario reset replaces the whole store. If a simulator timer survives, it writes
 * progress into the new platform (or into a discarded object) — the leak that made
 * "switch scenario while a job runs" non-deterministic.
 */
describe('scenario reset', () => {
  it('cancels every in-flight simulator timer', async () => {
    const response = await fetch('/api/v1/instances/inst-people/restart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-seamnex-role': 'R1',
        'x-seamnex-scenario': 'degraded',
      },
    });
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { jobId: string };
    expect(pendingTimerCount()).toBeGreaterThan(0);

    resetState('healthy');

    expect(pendingTimerCount()).toBe(0);
    expect(getState().jobs.some((job) => job.id === accepted.jobId)).toBe(false);
  });

  it('rebuilds a fresh platform rather than layering damage', () => {
    resetState('policy-exception');
    const blocked = getState().instances.find((instance) => instance.id === 'inst-shop');
    expect(blocked?.state).toBe('failed');

    resetState('healthy');
    const repaired = getState().instances.find((instance) => instance.id === 'inst-shop');
    expect(repaired?.state).not.toBe('failed');
  });
});
