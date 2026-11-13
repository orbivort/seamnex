import { describe, expect, it } from 'vitest';
import {
  maintenanceWindowStateAt,
  policyExceptionDiff,
  policyExceptionRequester,
  toMaintenanceWindow,
  type MaintenanceWindowRow,
} from '../../../../src/modules/m18-governance/maintenance-window';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

function row(overrides: Partial<MaintenanceWindowRow> = {}): MaintenanceWindowRow {
  return {
    id: 'mw-1',
    scope: 'Core Operations',
    instance_id: 'i-1',
    product: 'Mail',
    starts_at: new Date('2026-06-01T10:00:00.000Z'),
    ends_at: new Date('2026-06-01T14:00:00.000Z'),
    created_by: 'sub-1',
    created_by_label: 'Alice',
    cancelled_at: null,
    ...overrides,
  };
}

describe('maintenanceWindowStateAt', () => {
  it('reports scheduled before the start', () => {
    expect(
      maintenanceWindowStateAt(
        {
          starts_at: new Date(NOW + 60_000),
          ends_at: new Date(NOW + 120_000),
          cancelled_at: null,
        },
        NOW,
      ),
    ).toBe('scheduled');
  });

  it('reports active between the boundaries', () => {
    expect(
      maintenanceWindowStateAt(
        {
          starts_at: new Date(NOW - 60_000),
          ends_at: new Date(NOW + 60_000),
          cancelled_at: null,
        },
        NOW,
      ),
    ).toBe('active');
  });

  it('reports completed at the exact end instant, as the suppressor does', () => {
    expect(
      maintenanceWindowStateAt(
        {
          starts_at: new Date(NOW - 60_000),
          ends_at: new Date(NOW),
          cancelled_at: null,
        },
        NOW,
      ),
    ).toBe('completed');
  });

  it('reports a cancelled window as completed whatever the time', () => {
    expect(
      maintenanceWindowStateAt(
        {
          starts_at: new Date(NOW - 60_000),
          ends_at: new Date(NOW + 60_000),
          cancelled_at: new Date(NOW - 10_000),
        },
        NOW,
      ),
    ).toBe('completed');
  });

  it('defaults to the current instant', () => {
    expect(
      maintenanceWindowStateAt({
        starts_at: new Date(Date.now() - 1_000),
        ends_at: new Date(Date.now() + 60_000),
        cancelled_at: null,
      }),
    ).toBe('active');
  });
});

describe('toMaintenanceWindow', () => {
  it('names the product in the label and title, and resolves the creator', () => {
    const window = toMaintenanceWindow(row(), NOW);

    expect(window).toEqual({
      id: 'mw-1',
      scope: 'Core Operations',
      scopeLabel: 'Mail',
      instanceId: 'i-1',
      title: 'Mail maintenance',
      startsAt: '2026-06-01T10:00:00.000Z',
      endsAt: '2026-06-01T14:00:00.000Z',
      createdBy: 'Alice',
      state: 'active',
      suppressAlerts: true,
    });
  });

  it('keeps the operator scope text for a platform-wide window', () => {
    const window = toMaintenanceWindow(
      row({ product: null, instance_id: null, scope: 'Platform upgrade' }),
      NOW,
    );
    expect(window.scopeLabel).toBe('Platform upgrade');
    expect(window.title).toBe('Platform upgrade');
  });

  it('falls back to "Platform" when a platform window has no scope text', () => {
    const window = toMaintenanceWindow(row({ product: null, scope: '   ' }), NOW);
    expect(window.scopeLabel).toBe('Platform');
  });

  it('falls back to the subject id when the directory has no name', () => {
    expect(toMaintenanceWindow(row({ created_by_label: null }), NOW).createdBy).toBe('sub-1');
  });

  it('does not claim to suppress alerts for a completed or cancelled window', () => {
    const completed = toMaintenanceWindow(
      row({ starts_at: new Date(NOW - 7_200_000), ends_at: new Date(NOW - 3_600_000) }),
      NOW,
    );
    expect(completed.state).toBe('completed');
    expect(completed.suppressAlerts).toBe(false);

    const cancelled = toMaintenanceWindow(row({ cancelled_at: new Date(NOW - 1_000) }), NOW);
    expect(cancelled.suppressAlerts).toBe(false);
  });
});

describe('policyExceptionRequester', () => {
  it('reads the requester out of the written diff', () => {
    expect(
      policyExceptionRequester({ approver: 'sub-approver', patch_diff: { requestedBy: 'sub-1' } }),
    ).toBe('sub-1');
  });

  it('falls back to the approver column until a decision is taken', () => {
    expect(policyExceptionRequester({ approver: 'sub-a', patch_diff: null })).toBe('sub-a');
    expect(policyExceptionRequester({ approver: 'sub-a', patch_diff: 'text' })).toBe('sub-a');
    expect(policyExceptionRequester({ approver: 'sub-a', patch_diff: { requestedBy: '' } })).toBe(
      'sub-a',
    );
    expect(policyExceptionRequester({ approver: 'sub-a', patch_diff: { requestedBy: 7 } })).toBe(
      'sub-a',
    );
  });
});

describe('policyExceptionDiff', () => {
  it('returns a written string unchanged', () => {
    expect(policyExceptionDiff('--- a\n+++ b')).toBe('--- a\n+++ b');
  });

  it('unwraps a diff envelope', () => {
    expect(policyExceptionDiff({ diff: '--- a' })).toBe('--- a');
  });

  it('serialises an envelope without a usable diff', () => {
    expect(policyExceptionDiff({ other: true })).toBe('{"other":true}');
    expect(policyExceptionDiff({ diff: '' })).toBe('{"diff":""}');
  });

  it('answers none for a missing diff', () => {
    expect(policyExceptionDiff(null)).toBe('none');
    expect(policyExceptionDiff(undefined)).toBe('none');
    expect(policyExceptionDiff('')).toBe('none');
    expect(policyExceptionDiff(42)).toBe('none');
  });
});
