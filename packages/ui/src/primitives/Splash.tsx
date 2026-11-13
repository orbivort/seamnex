import { cn } from '@seamnex/utils';

/**
 * The surface shown while the application decides whether it can start: the mock platform is
 * being installed, or the server's session is being read.
 *
 * It exists so first paint is the product instead of an empty document. `index.html` carries the
 * same block as static markup, so the frame before React mounts is already on brand and the
 * handover is invisible.
 */
export function Splash({
  appName,
  label = 'Loading…',
  className,
}: {
  appName: string;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('grid min-h-screen place-items-center bg-paper px-6', className)}
    >
      <div className="flex w-full max-w-xs flex-col items-center gap-3 text-center">
        <span
          aria-hidden
          className="grid size-10 place-items-center rounded-md border border-primary-border bg-ink font-mono text-body font-semibold text-ink-text"
        >
          SN
        </span>
        <p className="font-display text-heading font-semibold text-text">{appName}</p>
        <p className="font-mono text-micro text-faint">{label}</p>
        {/* A thin indeterminate bar: the wait is a round trip with no progress to report. */}
        <span aria-hidden className="h-[3px] w-24 overflow-hidden rounded-full bg-line">
          <span className="block h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
        </span>
      </div>
    </div>
  );
}
