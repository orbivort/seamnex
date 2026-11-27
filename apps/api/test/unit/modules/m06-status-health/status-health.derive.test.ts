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

  it('does not promote a product that is answering with its own installer', () => {
    // The observed incident: every container running, `wget` getting a 302 from `/`, the portal tile
    // offering the product, and the page behind it the Setup Wizard. `httpReady` is true and that is
    // exactly the fact that must not decide the state on its own.
    expect(derive('degraded', running, true, '/installer/index.php/welcome')).toEqual({
      state: 'degraded',
      ready: false,
      reason:
        'the product is serving its own installer at /installer/index.php/welcome; the installation has not been completed',
    });
  });

  it('promotes the same instance once the installer is gone', () => {
    expect(derive('degraded', running, true, null)).toEqual({
      state: 'ready',
      ready: true,
      reason: null,
    });
  });
});
