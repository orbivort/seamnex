import { describe, expect, it } from 'vitest';
import { derive } from '../../../../src/modules/m06-status-health/status-health.service';

/**
 * A deliberate stop is a state, not a fault. Deriving `degraded` from "no container is running"
 * erased it on the next sample, and `lifecycleAvailability` only offers `start` from `stopped` —
 * so the console showed a degraded instance whose Start button could never be pressed again.
 */
describe('status derivation', () => {
  const exited = [{ state: 'exited' }];
  const running = [{ state: 'running' }];

  it('keeps an operator-initiated stop instead of degrading it', () => {
    expect(derive('stopped', exited, false)).toEqual({
      state: 'stopped',
      ready: false,
      reason: 'stopped; containers are not running',
    });
  });

  it('still reports a degraded instance when only some containers are down', () => {
    expect(derive('degraded', [{ state: 'running' }, { state: 'exited' }], false)).toEqual({
      state: 'degraded',
      ready: false,
      reason: '1 of 2 container(s) not running',
    });
  });

  it('still reports ready when a stopped record disagrees with running containers', () => {
    expect(derive('stopped', running, true).state).toBe('ready');
  });

  it('keeps a transitional state while a job owns it', () => {
    expect(derive('deploying', running, true)).toEqual({
      state: 'deploying',
      ready: false,
      reason: 'transition in progress',
    });
  });
});
