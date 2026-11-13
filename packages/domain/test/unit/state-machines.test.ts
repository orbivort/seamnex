import { describe, expect, it } from 'vitest';
import {
  INSTANCE_TRANSITIONS,
  RESTORE_ORDER,
  breakGlassStateAt,
  canTransitionBreakGlass,
  canTransitionInstance,
  canTransitionWorkflow,
  isTransitional,
  lifecycleAvailability,
  restoreProgress,
} from '../../src/state-machines';
import { INSTANCE_STATES } from '../../src/enums';

describe('instance state machine (§7.4)', () => {
  it('covers every declared state', () => {
    for (const state of INSTANCE_STATES) {
      expect(INSTANCE_TRANSITIONS[state], state).toBeDefined();
    }
  });

  it('allows the deployment path and forbids shortcuts to ready', () => {
    expect(canTransitionInstance('requested', 'validating')).toBe(true);
    expect(canTransitionInstance('verifying', 'ready')).toBe(true);
    expect(canTransitionInstance('validating', 'ready')).toBe(false);
    expect(canTransitionInstance('stopped', 'ready')).toBe(false);
  });

  it('treats deleted as terminal', () => {
    expect(INSTANCE_TRANSITIONS.deleted).toEqual([]);
  });

  it('keeps transitions asymmetric where the design requires it', () => {
    expect(canTransitionInstance('ready', 'stopping')).toBe(true);
    expect(canTransitionInstance('stopping', 'ready')).toBe(false);
  });
});

describe('lifecycle affordances', () => {
  it('offers start only from stopped and never while busy', () => {
    expect(lifecycleAvailability('stopped').start).toBe(true);
    expect(lifecycleAvailability('starting').start).toBe(false);
    expect(lifecycleAvailability('ready').start).toBe(false);
  });

  it('offers stop/restart/upgrade while running or degraded', () => {
    for (const state of ['ready', 'degraded'] as const) {
      const actions = lifecycleAvailability(state);
      expect(actions.stop, state).toBe(true);
      expect(actions.restart, state).toBe(true);
      expect(actions.upgrade, state).toBe(true);
    }
  });

  it('hides destructive actions mid-transition', () => {
    for (const state of ['upgrading', 'rolling_back', 'deleting'] as const) {
      expect(isTransitional(state), state).toBe(true);
      expect(lifecycleAvailability(state).delete, state).toBe(false);
      expect(lifecycleAvailability(state).export, state).toBe(false);
    }
  });
});

describe('restore order (FR-1.36)', () => {
  it('restores the identity provider before the control plane and products', () => {
    expect(RESTORE_ORDER.indexOf('idp')).toBeLessThan(RESTORE_ORDER.indexOf('control_plane'));
    expect(RESTORE_ORDER.indexOf('control_plane')).toBeLessThan(
      RESTORE_ORDER.indexOf('login_verified'),
    );
    expect(RESTORE_ORDER.indexOf('login_verified')).toBeLessThan(RESTORE_ORDER.indexOf('products'));
    expect(RESTORE_ORDER.indexOf('products')).toBeLessThan(RESTORE_ORDER.indexOf('verify'));
  });

  it('reports monotonic progress and completes on failure', () => {
    expect(restoreProgress('preparing')).toBeLessThan(restoreProgress('idp'));
    expect(restoreProgress('verify')).toBeLessThan(restoreProgress('complete'));
    expect(restoreProgress('complete')).toBe(100);
    expect(restoreProgress('failed')).toBe(100);
  });
});

describe('break-glass and workflow states', () => {
  it('starts the clock on approval and never re-opens a closed session', () => {
    // Approval is one write: it decides the request and grants the elevation.
    expect(canTransitionBreakGlass('requested', 'active')).toBe(true);
    expect(canTransitionBreakGlass('requested', 'approved')).toBe(true);
    expect(canTransitionBreakGlass('expired', 'active')).toBe(false);
    expect(canTransitionBreakGlass('revoked', 'active')).toBe(false);
    expect(canTransitionBreakGlass('rejected', 'active')).toBe(false);
  });

  it('does not allow activation from a draft without validation', () => {
    expect(canTransitionWorkflow('draft', 'validated')).toBe(true);
    expect(canTransitionWorkflow('draft', 'active')).toBe(false);
    expect(canTransitionWorkflow('validated', 'active')).toBe(true);
  });
});

/**
 * The stored state is only rewritten when something writes it. A grant past its deadline is over
 * regardless, and every reader (list, single record, console) derives that from the clock.
 */
describe('break-glass state at a point in time', () => {
  const deadline = '2026-11-02T12:00:00.000Z';
  const after = Date.parse('2026-11-02T12:00:01.000Z');
  const before = Date.parse('2026-11-02T11:59:59.000Z');

  it('expires an active grant whose window has closed', () => {
    expect(breakGlassStateAt('active', deadline, after)).toBe('expired');
  });

  it('keeps an active grant that is still inside its window', () => {
    expect(breakGlassStateAt('active', deadline, before)).toBe('active');
  });

  it('treats the deadline itself as the end of the grant', () => {
    expect(breakGlassStateAt('active', deadline, Date.parse(deadline))).toBe('expired');
  });

  it('never rewrites a state that carries no deadline', () => {
    expect(breakGlassStateAt('requested', null, after)).toBe('requested');
    expect(breakGlassStateAt('revoked', deadline, after)).toBe('revoked');
    expect(breakGlassStateAt('active', null, after)).toBe('active');
  });

  it('leaves an unparseable deadline alone rather than inventing an expiry', () => {
    expect(breakGlassStateAt('active', 'not-a-date', after)).toBe('active');
  });

  it('accepts a Date for the deadline, which is what a typed caller usually has', () => {
    expect(breakGlassStateAt('active', new Date(deadline), after)).toBe('expired');
    expect(breakGlassStateAt('active', new Date(deadline), before)).toBe('active');
  });
});

describe('restore progress', () => {
  it('reports a percentage for each fixed phase', () => {
    expect(restoreProgress('preparing')).toBe(Math.round((1 / RESTORE_ORDER.length) * 100));
    expect(restoreProgress('complete')).toBe(100);
  });

  it('treats a failure as the end of the run and an unknown phase as not started', () => {
    expect(restoreProgress('failed')).toBe(100);
    expect(restoreProgress('not-a-phase' as (typeof RESTORE_ORDER)[number])).toBe(0);
  });
});
