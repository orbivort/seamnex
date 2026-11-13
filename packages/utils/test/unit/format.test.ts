import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FORMATTING,
  configureFormatting,
  formattingConfig,
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatLatency,
  formatNumber,
  formatPercent,
  formatRelative,
  ordinal,
  truncateMiddle,
} from '../../src/format';

/**
 * Formatting is configuration, not an ambient default: these cases pin the rendered string, because
 * a locale or zone that leaks in from the machine is exactly what made the same timestamp read
 * differently per operator.
 */
afterEach(() => {
  configureFormatting(DEFAULT_FORMATTING);
});

describe('configuration', () => {
  it('publishes the configuration in force without allowing the caller to mutate it by accident', () => {
    expect(formattingConfig()).toEqual(DEFAULT_FORMATTING);

    configureFormatting({ locale: 'de-DE' });

    expect(formattingConfig()).toEqual({ locale: 'de-DE', timeZone: 'UTC' });
    // A partial update keeps the fields it did not name.
    configureFormatting({ timeZone: 'Europe/Berlin' });
    expect(formattingConfig()).toEqual({ locale: 'de-DE', timeZone: 'Europe/Berlin' });
  });
});

describe('dates', () => {
  it('renders an instant in the configured zone, not the machine zone', () => {
    expect(formatDateTime('2026-11-05T12:00:00Z')).toBe('05 Nov 2026, 12:00');
    expect(formatDate('2026-11-05T12:00:00Z')).toBe('05 Nov 2026');
  });

  it('re-renders after a configuration change, and caches nothing stale', () => {
    expect(formatDateTime('2026-11-05T12:00:00Z')).toBe('05 Nov 2026, 12:00');
    configureFormatting({ timeZone: 'America/New_York' });
    expect(formatDateTime('2026-11-05T12:00:00Z')).toBe('05 Nov 2026, 07:00');
    configureFormatting(DEFAULT_FORMATTING);
    expect(formatDateTime('2026-11-05T12:00:00Z')).toBe('05 Nov 2026, 12:00');
  });

  it('accepts a Date instance as well as an instant string', () => {
    const instant = new Date('2026-11-05T12:00:00Z');

    expect(formatDateTime(instant)).toBe('05 Nov 2026, 12:00');
    expect(formatDate(instant)).toBe('05 Nov 2026');
    // A zero delta is not "ago"; the future branch owns the same instant.
    expect(formatRelative(instant, instant)).toBe('in a moment');
  });

  it('says "unknown" instead of "Invalid Date"', () => {
    expect(formatDateTime('not-a-date')).toBe('unknown');
    expect(formatDate('not-a-date')).toBe('unknown');
    expect(formatRelative('not-a-date')).toBe('unknown');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-11-05T12:00:00Z');

  it('keeps the sub-minute cases in words', () => {
    expect(formatRelative('2026-11-05T11:59:30Z', now)).toBe('just now');
    expect(formatRelative('2026-11-05T12:00:30Z', now)).toBe('in a moment');
  });

  it('moves through minutes, hours and days', () => {
    expect(formatRelative('2026-11-05T11:40:00Z', now)).toBe('20 min ago');
    expect(formatRelative('2026-11-05T09:00:00Z', now)).toBe('3 h ago');
    expect(formatRelative('2026-11-03T12:00:00Z', now)).toBe('2 d ago');
  });

  it('falls back to an absolute date beyond a month', () => {
    expect(formatRelative('2026-01-01T00:00:00Z', new Date('2026-02-15T00:00:00Z'))).toBe(
      '01 Jan 2026',
    );
  });
});

describe('sizes and latencies', () => {
  it('scales bytes and drops the fraction where it carries no information', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
  });

  it('keeps a sub-second latency in milliseconds', () => {
    // The bug this pins: rounding to whole seconds printed "0 s" for a 42 ms cycle.
    expect(formatLatency(42)).toBe('42 ms');
    expect(formatLatency(999)).toBe('999 ms');
    expect(formatLatency(1_000)).toBe('1 s');
    expect(formatLatency(90_000)).toBe('90 s');
    expect(formatLatency(-1)).toBe('unknown');
  });
});

describe('durations and plain numbers', () => {
  it('composes minutes, hours and days without empty parts', () => {
    expect(formatDuration(30)).toBe('30 min');
    expect(formatDuration(60)).toBe('1 h');
    expect(formatDuration(90)).toBe('1 h 30 min');
    expect(formatDuration(1_440)).toBe('1 d');
    expect(formatDuration(1_500)).toBe('1 d 1 h');
    expect(formatDuration(Number.NaN)).toBe('unknown');
  });

  it('formats percentages and grouped numbers through the configured locale', () => {
    expect(formatPercent(0.1234, 1)).toBe('12.3%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatNumber(1_234.5)).toBe('1,234.5');
  });
});

describe('ordinals and truncation', () => {
  it('handles the teens, which are the cases a modulo table gets wrong', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '101st',
      '111th',
    ]);
  });

  it('leaves a short value alone and elides the middle of a long one', () => {
    expect(truncateMiddle('short', 5, 5)).toBe('short');
    expect(truncateMiddle('abcdefghijklmnopqrstuvwxyz', 5, 5)).toBe('abcde…vwxyz');
    // Exactly head + tail + 1 is still short enough to print in full.
    expect(truncateMiddle('abcdefghijk', 5, 5)).toBe('abcdefghijk');
  });
});
