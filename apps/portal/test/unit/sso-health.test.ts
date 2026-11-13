import { describe, expect, it } from 'vitest';
import type { SsoHealth } from '@seamnex/domain';
import { formatRelative } from '@seamnex/utils';
import { describeSsoHealth } from '../../src/components/sso-health';

const CHECKED_AT = '2026-11-02T08:00:00.000Z';

function health(overrides: Partial<SsoHealth> = {}): SsoHealth {
  return {
    checked: true,
    ok: true,
    checkedAt: CHECKED_AT,
    detail: 'stages 1–2 passed',
    reason: 'ok',
    ...overrides,
  };
}

describe('describeSsoHealth', () => {
  it('states that the last check passed, with when it ran', () => {
    const sentence = describeSsoHealth(health(), CHECKED_AT);

    expect(sentence).toMatch(/^The last end-to-end check passed /);
    expect(sentence).not.toContain('evidence window');
    expect(sentence.endsWith('.')).toBe(true);
  });

  it('explains a stale pass as outside the evidence window, including the API detail', () => {
    const sentence = describeSsoHealth(
      health({ reason: 'stale', detail: 'stages 1–2 passed at 08:00' }),
      CHECKED_AT,
    );

    expect(sentence).toContain('stages 1–2 passed at 08:00');
    expect(sentence).toContain('outside the evidence window');
    expect(sentence).toContain('Re-run verification');
  });

  it('reports a failed check and the reason the API recorded', () => {
    const sentence = describeSsoHealth(
      health({ ok: false, reason: 'failed', detail: 'the product answered 502' }),
      CHECKED_AT,
    );

    expect(sentence).toContain('The last end-to-end check failed');
    expect(sentence).toContain('the product answered 502');
  });

  it('says plainly that no check has run yet', () => {
    expect(
      describeSsoHealth(
        health({ checked: false, ok: false, checkedAt: null, detail: '', reason: 'never_checked' }),
        CHECKED_AT,
      ),
    ).toBe('No end-to-end sign-in check has run for this product yet.');
  });

  it('falls back to the observation timestamp when the check carries none', () => {
    const observedAt = '2026-10-01T08:00:00.000Z';
    const sentence = describeSsoHealth(health({ checkedAt: null, reason: 'ok' }), observedAt);

    expect(sentence).toContain(formatRelative(observedAt));
  });
});
