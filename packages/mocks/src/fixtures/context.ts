/**
 * The fixture clock.
 *
 * Every fixture is written as an offset from this instant ("15 days ago", "in 28 minutes"), never
 * as a calendar date. The instant itself is the moment the mock platform loads, so the dataset
 * keeps its shape — and every relative label on screen keeps saying `15 d ago` — while the
 * absolute timestamps move with the wall clock.
 *
 * This mattered: the clock used to be pinned to `2026-10-22T08:15:00Z`, while derived state
 * (break-glass expiry, a policy exception's decision window, `formatRelative` in the chrome) is
 * computed against the real clock. A demo run weeks later therefore showed an approved elevation
 * that was instantly `expired`, an exception nobody could approve any more, and "just now" writes
 * stamped two weeks in the past.
 */
export const SEED_NOW_MS = Date.now();

/** The fixture world's origin, ISO. Kept for the screens and tests that want to name it. */
export const SEED_NOW = new Date(SEED_NOW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * ISO instant relative to the clock. Negative values are in the past.
 *
 * Read live rather than from `SEED_NOW_MS`: a record the operator creates during the demo — a job,
 * an approved elevation, an audit row — has to be stamped now, not when the document loaded.
 */
export function at(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * MINUTE).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function daysAgo(days: number): string {
  return at(-days * 24 * 60);
}

export function hoursAgo(hours: number): string {
  return at(-hours * 60);
}

export const ENVIRONMENT_NAME = 'sbx-frankfurt-01';
export const PLATFORM_DOMAIN = 'seamnex.local';
export const PLATFORM_VERSION = '1.8.3';
