import type { ReactNode } from 'react';
import { CircleAlert, Inbox, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { cn, formatRelative } from '@seamnex/utils';
import type { ProblemDetail, Tone } from '@seamnex/domain';
import { Button } from './Button';
import { toneBar, toneBox, toneText } from './tone';

export function Alert({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: Tone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    // `role="alert"` already implies an assertive live region, and `role="status"` a polite one.
    // Restating `aria-live` alongside them only gives a second, weaker source of truth.
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-md border px-3.5 py-3',
        toneBox(tone),
        className,
      )}
    >
      <span className={cn('mt-0.5 shrink-0', toneText(tone))}>
        {tone === 'danger' ? (
          <CircleAlert className="size-4" />
        ) : tone === 'caution' ? (
          <TriangleAlert className="size-4" />
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold text-text">{title}</p>
        {children ? (
          <div className="mt-1 text-body leading-relaxed text-muted">{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  compact,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-8' : 'py-14',
      )}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-full border border-line bg-paper-deep text-faint">
        {icon ?? <Inbox className="size-5" />}
      </span>
      <p className="font-display text-heading font-semibold text-text">{title}</p>
      <p className="mt-1 max-w-sm text-body leading-relaxed text-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('motion-safe:animate-pulse rounded-xs bg-paper-deep', className)}
    />
  );
}

export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: lines }, (_, index) => (
        // A static placeholder list: the position is the identity, so a literal key is honest.
        <Skeleton
          key={`skeleton-line-${index}`}
          className={cn('h-3', index === lines - 1 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-meta text-muted" role="status">
      <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
  label,
  showValue = false,
  className,
}: {
  value: number;
  tone?: Tone | 'accent';
  label?: string;
  showValue?: boolean;
  className?: string;
}) {
  const safe = Math.min(100, Math.max(0, value));
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label || showValue ? (
        <div className="flex items-baseline justify-between gap-3 text-micro text-muted">
          <span>{label}</span>
          {showValue ? <span className="font-mono tabular-nums">{Math.round(safe)}%</span> : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={Math.round(safe)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Progress'}
        className="h-1.5 w-full overflow-hidden rounded-full bg-paper-deep"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out',
            toneBar(tone),
          )}
          style={{ width: `${safe}%` }}
        />
      </div>
    </div>
  );
}

export function ErrorState({
  problem,
  onRetry,
  compact,
}: {
  problem: ProblemDetail;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={cn('rounded-md border px-4', toneBox('danger'), compact ? 'py-4' : 'py-6')}>
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold text-text">{problem.title}</p>
          <p className="mt-1 text-body leading-relaxed text-muted">{problem.detail}</p>
          {problem.fieldErrors.length > 0 ? (
            // A 422 from the API names the fields it refused; without this the operator sees only
            // the generic detail and has to guess which input was wrong.
            <ul className="mt-2 flex flex-col gap-0.5">
              {problem.fieldErrors.map((error) => (
                <li
                  key={`${error.field}:${error.code}`}
                  className="text-meta leading-relaxed text-muted"
                >
                  <span className="font-mono text-micro text-text">{error.field || 'body'}</span>
                  {' — '}
                  {error.message}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-meta leading-relaxed text-link">{problem.remediation}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <code className="font-mono text-micro text-faint">
              {problem.code} · HTTP {problem.status}
            </code>
            {onRetry ? (
              <Button size="sm" variant="secondary" onClick={onRetry} icon={<RefreshCw />}>
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function InlineNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-meta leading-relaxed text-faint', className)}>{children}</p>;
}

/**
 * Shown when the API is unreachable. It states what is on screen rather than pretending the
 * data is current, and names the last moment a real response was received.
 */
export function StaleNotice({
  lastKnownAt,
  className,
}: {
  lastKnownAt: string | null;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2',
        toneBox('caution'),
        className,
      )}
    >
      <WifiOff className="mt-0.5 size-3.5 shrink-0 text-warning-strong" aria-hidden />
      <p className="text-meta leading-relaxed text-warning-strong">
        <span className="font-semibold">Live data unavailable.</span>{' '}
        {lastKnownAt
          ? `Showing the last known status from ${formatRelative(lastKnownAt)}; retry once the API is reachable.`
          : 'No successful response has been recorded in this session; retry once the API is reachable.'}
      </p>
    </div>
  );
}
