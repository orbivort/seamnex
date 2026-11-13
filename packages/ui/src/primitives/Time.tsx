import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@seamnex/utils';

/**
 * A ticking clock.
 *
 * It is a hook rather than page-level state on purpose. Three screens used to hold `now` at the
 * top of the page, which made a one-second timer re-render the whole screen — including a table
 * whose columns were rebuilt per tick. Mounting the clock in the leaf that prints the time keeps
 * the re-render inside that leaf.
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * A deadline that stays readable to people using a screen reader without reading itself out
 * every second.
 *
 * The digits are decorative (`aria-hidden`) and update each second; the announced sentence
 * changes only at a minute boundary. A live region on the digits — which is what this replaced —
 * queues an announcement per tick and cannot be silenced without muting the page.
 */
export function Countdown({
  expiresAt,
  className,
  expiredClassName,
  expiredLabel = 'Expired',
}: {
  expiresAt: string;
  className?: string;
  /** Applied to the digits once the deadline has passed, so a caller can keep its own tone. */
  expiredClassName?: string;
  expiredLabel?: ReactNode;
}) {
  const now = useNow(1_000);
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  const expired = remaining === 0;
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);

  // Only these strings reach the live region, and each one changes at most once a minute.
  const spoken = expired
    ? typeof expiredLabel === 'string'
      ? expiredLabel
      : 'Expired'
    : minutes >= 1
      ? `${minutes} minute${minutes === 1 ? '' : 's'} remaining`
      : 'Less than a minute remaining';

  return (
    <span className={className} role="timer" aria-live="off">
      <span aria-hidden className={cn(expired && expiredClassName)}>
        {expired ? expiredLabel : `${minutes} min ${String(seconds).padStart(2, '0')} s remaining`}
      </span>
      <span className="sr-only" role="status">
        {spoken}
      </span>
    </span>
  );
}
