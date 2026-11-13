import type { MaintenanceWindow, Tone } from '@seamnex/domain';

/*
 * The maintenance screen needs three pieces of clock arithmetic and nothing else: the two form
 * conversions and the state verdict. They live in their own module so the screen file stays one
 * screen — and so the conversions can be unit-tested without rendering a page.
 */

/** `datetime-local` speaks local wall-clock time; the contract carries UTC instants. */
export function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localInputToIso(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * The platform clock decides a window's state and the list is re-read on a timer, so the state
 * column is never a second opinion. The one thing the record cannot express is *why* a window
 * completed: `state` says `completed` for a finished window and for a cancelled one alike, and only
 * a cancelled window owns an end time that still lies ahead.
 */
export function windowStateLabel(
  entry: MaintenanceWindow,
  now: number,
): { label: string; tone: Tone } {
  if (entry.state === 'active') return { label: 'Active', tone: 'caution' };
  if (entry.state === 'scheduled') return { label: 'Scheduled', tone: 'neutral' };
  return Date.parse(entry.endsAt) > now
    ? { label: 'Cancelled', tone: 'neutral' }
    : { label: 'Ended', tone: 'positive' };
}
