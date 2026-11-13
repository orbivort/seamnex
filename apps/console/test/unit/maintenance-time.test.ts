import { describe, expect, it } from 'vitest';
import type { MaintenanceWindow } from '@seamnex/domain';
import {
  localInputToIso,
  toLocalInputValue,
  windowStateLabel,
} from '../../src/features/governance/maintenance-time';

/**
 * Three pieces of clock arithmetic: the two form conversions and the state verdict. The verdict is
 * the interesting one — `completed` cannot say whether a window finished or was cancelled, so the
 * end time decides.
 */
describe('maintenance time conversions', () => {
  it('formats a local wall-clock value the datetime-local input accepts', () => {
    expect(toLocalInputValue(new Date(2026, 0, 5, 7, 4))).toBe('2026-01-05T07:04');
    expect(toLocalInputValue(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31T23:59');
  });

  it('pads single-digit months, days, hours and minutes', () => {
    expect(toLocalInputValue(new Date(2026, 8, 9, 8, 5))).toBe('2026-09-09T08:05');
  });

  it('round-trips a local input value through the contract representation', () => {
    const iso = localInputToIso('2026-03-04T05:06');
    expect(iso).toBe(new Date(2026, 2, 4, 5, 6).toISOString());
    expect(toLocalInputValue(new Date(iso as string))).toBe('2026-03-04T05:06');
  });

  it('refuses an unparseable input instead of inventing an instant', () => {
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('not a date')).toBeNull();
    expect(localInputToIso('2026-13-45T99:99')).toBeNull();
  });
});

describe('maintenance window state', () => {
  const window = (overrides: Partial<MaintenanceWindow>): MaintenanceWindow =>
    ({
      id: 'mw-1',
      title: 'Window',
      state: 'scheduled',
      startsAt: '2026-11-06T08:00:00.000Z',
      endsAt: '2026-11-06T10:00:00.000Z',
      ...overrides,
    }) as MaintenanceWindow;

  const now = Date.parse('2026-11-06T09:00:00.000Z');

  it('calls a running window active', () => {
    expect(windowStateLabel(window({ state: 'active' }), now)).toEqual({
      label: 'Active',
      tone: 'caution',
    });
  });

  it('calls a future window scheduled', () => {
    expect(windowStateLabel(window({ state: 'scheduled' }), now)).toEqual({
      label: 'Scheduled',
      tone: 'neutral',
    });
  });

  it('reads a completed window whose end time is still ahead as cancelled', () => {
    expect(
      windowStateLabel(window({ state: 'completed', endsAt: '2026-11-06T10:00:00.000Z' }), now),
    ).toEqual({ label: 'Cancelled', tone: 'neutral' });
  });

  it('reads a completed window whose end time has passed as ended', () => {
    expect(
      windowStateLabel(window({ state: 'completed', endsAt: '2026-11-06T08:00:00.000Z' }), now),
    ).toEqual({ label: 'Ended', tone: 'positive' });
  });

  it('treats the exact end instant as ended, not as cancelled', () => {
    expect(
      windowStateLabel(window({ state: 'completed', endsAt: '2026-11-06T09:00:00.000Z' }), now),
    ).toEqual({ label: 'Ended', tone: 'positive' });
  });
});
