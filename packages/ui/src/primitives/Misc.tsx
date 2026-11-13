import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { cn } from '@seamnex/utils';
import { IconButton } from './Button';

export function Avatar({
  initials,
  size = 'md',
  tone = 'ink',
  className,
}: {
  initials: string;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'ink' | 'teal' | 'paper';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-sm border font-mono font-semibold tracking-tight',
        size === 'sm'
          ? 'size-6 text-micro'
          : size === 'lg'
            ? 'size-10 text-micro'
            : 'size-8 text-micro',
        tone === 'ink' && 'border-line-ink bg-ink text-ink-text',
        tone === 'teal' && 'border-primary-border bg-primary text-primary-foreground',
        tone === 'paper' && 'border-line-strong bg-paper-deep text-muted',
        className,
      )}
    >
      {initials}
    </span>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-meta text-muted', className)}>{children}</span>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  // A timeout that outlives the component still fires; it also stacked up on repeated copies,
  // so the second copy's confirmation could be cleared by the first copy's timer.
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = () => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setCopied(false), 1_500);
      })
      .catch((error: unknown) => {
        console.error('Clipboard unavailable', error);
      });
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className="tap-target inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-faint hover:bg-paper-deep hover:text-link"
    >
      {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
    </button>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 text-meta text-muted">
      <span className="font-mono tabular-nums">
        {start}–{end} of {total}
      </span>
      <div className="flex items-center gap-2">
        <IconButton
          label="Previous page"
          onClick={onPrev}
          disabled={!onPrev || page === 0}
          className="tap-target size-7"
        >
          <ChevronLeft className="size-3.5" />
        </IconButton>
        <IconButton
          label="Next page"
          onClick={onNext}
          disabled={!onNext || end >= total}
          className="tap-target size-7"
        >
          <ChevronRight className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}
