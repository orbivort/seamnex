import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { SamplerService } from '../../../../src/modules/m06-status-health/sampler.service';

/**
 * The sampler is a loop with three rules, and each exists because of a failure it prevents: a tick
 * that overlaps the previous one is skipped rather than queued (a slow daemon must not build a
 * backlog describing the past), a failed cycle resets the guard so the next one still runs, and a
 * capacity sample that fails is only logged — otherwise an unmeasurable host would stop the status
 * sampler, which is what makes readiness observable at all.
 */
function setup(overrides: Record<string, unknown> = {}) {
  const config = {
    SEAMNEX_SAMPLE_INTERVAL_MS: 30_000,
    SEAMNEX_CAPACITY_SAMPLE_INTERVAL_MS: 300_000,
    ...overrides,
  } as unknown as AppConfig;
  const status = { sample: vi.fn(async () => ({ instances: 2, ready: 1, degraded: 1 })) };
  const executor = { recordCapacitySample: vi.fn(async () => undefined) };
  const service = new SamplerService(config, status as never, executor as never);
  return { status, executor, service };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('start and stop', () => {
  it('samples immediately and then on every interval', async () => {
    const { status, service } = setup();

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(status.sample).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(status.sample).toHaveBeenCalledTimes(2);
  });

  it('starts only once, however often it is asked', async () => {
    const { status, service } = setup();

    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(status.sample).toHaveBeenCalledTimes(2);
  });

  it('stops the interval and does nothing when stopped twice', async () => {
    const { status, service } = setup();

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.stop();
    service.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(status.sample).toHaveBeenCalledOnce();
  });

  it('stops on application shutdown', async () => {
    const { status, service } = setup();

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(status.sample).toHaveBeenCalledOnce();
  });
});

describe('tick', () => {
  it('records the capacity sample on the same cycle', async () => {
    const { executor, service } = setup();

    await service.tick();

    expect(executor.recordCapacitySample).toHaveBeenCalledOnce();
  });

  it('skips a tick whose predecessor is still running', async () => {
    const { status, service } = setup();
    let release: (() => void) | undefined;
    status.sample.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ instances: 1, ready: 1, degraded: 0 });
        }) as never,
    );

    const first = service.tick();
    const second = service.tick();
    await second;
    // The second tick returned without sampling again.
    expect(status.sample).toHaveBeenCalledOnce();

    release?.();
    await first;
  });

  it('resets the guard after a failed cycle so the next tick still runs', async () => {
    const { status, service } = setup();
    status.sample.mockRejectedValueOnce(new Error('daemon down'));

    await expect(service.tick()).resolves.toBeUndefined();
    status.sample.mockResolvedValueOnce({ instances: 0, ready: 0, degraded: 0 });
    await service.tick();

    expect(status.sample).toHaveBeenCalledTimes(2);
  });

  it('records a non-Error sample failure without throwing', async () => {
    const { status, service } = setup();
    status.sample.mockRejectedValueOnce('daemon down');

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('throttles the capacity sample independently of the status cadence', async () => {
    const { executor, service } = setup();

    await service.tick();
    await service.tick();

    expect(executor.recordCapacitySample).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(300_000);
    await service.tick();
    expect(executor.recordCapacitySample).toHaveBeenCalledTimes(2);
  });

  it('keeps sampling status when the capacity sample fails', async () => {
    const { executor, status, service } = setup();
    executor.recordCapacitySample.mockRejectedValue(new Error('cannot measure'));

    await expect(service.tick()).resolves.toBeUndefined();
    await service.tick();

    expect(status.sample).toHaveBeenCalledTimes(2);
  });

  it('records a non-Error capacity failure without throwing', async () => {
    const { executor, service } = setup();
    executor.recordCapacitySample.mockRejectedValue('cannot measure');

    await expect(service.tick()).resolves.toBeUndefined();
  });
});
