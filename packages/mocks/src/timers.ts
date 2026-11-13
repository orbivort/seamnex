/**
 * Registry for simulator timers.
 *
 * A scenario reset replaces the whole store, so any timer still holding the previous state
 * would write progress into a platform nobody is looking at (or, worse, into the new one).
 * Every simulator schedules through this module and `resetState` cancels them all.
 */

const pending = new Set<ReturnType<typeof setTimeout>>();

export function schedule(fn: () => void, ms: number): void {
  const id = setTimeout(() => {
    pending.delete(id);
    fn();
  }, ms);
  pending.add(id);
}

export function clearScheduledTimers(): void {
  for (const id of pending) clearTimeout(id);
  pending.clear();
}

export function pendingTimerCount(): number {
  return pending.size;
}
