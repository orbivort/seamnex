import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, CircleDot, TriangleAlert } from 'lucide-react';
import { cn } from '@seamnex/utils';
import type { Tone } from '@seamnex/domain';
import { toneChip } from './tone';

export type BadgeTone = Tone | 'accent' | 'ink';

/**
 * The five domain tones come from the shared recipe in `tone.ts`; `accent` and `ink` are the
 * two badge-only surfaces (a brand chip, and a chip that sits on the dark chrome).
 */
const TONE_SURFACE: Record<BadgeTone, string> = {
  positive: toneChip('positive'),
  caution: toneChip('caution'),
  danger: toneChip('danger'),
  info: toneChip('info'),
  neutral: toneChip('neutral'),
  accent: 'border-primary-border bg-primary-soft text-primary-soft-foreground',
  ink: 'border-line-ink bg-ink text-ink-text',
};

const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-xs border whitespace-nowrap', {
  variants: {
    tone: TONE_SURFACE,
    size: {
      sm: 'px-1.5 py-px',
      md: 'px-2 py-0.5',
    },
    /**
     * The caps recipe is a variant, not an extra class: two caps utilities on one element
     * declare the same `font-family` / `letter-spacing` / `text-transform`, and only the
     * generated order would decide which won.
     */
    caps: {
      sans: 'label-caps-sans',
      code: 'label-caps-code',
    },
  },
  defaultVariants: { tone: 'neutral', size: 'md', caps: 'sans' },
});

export type BadgeProps = VariantProps<typeof badgeVariants> & {
  children: ReactNode;
  className?: string;
  mono?: boolean;
};

export function Badge({ children, className, tone, size, mono }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size, caps: mono ? 'code' : 'sans' }), className)}>
      {children}
    </span>
  );
}

const TONE_ICON: Record<Tone, ReactNode> = {
  positive: <CircleCheck aria-hidden className="size-3.5" />,
  caution: <TriangleAlert aria-hidden className="size-3.5" />,
  danger: <CircleAlert aria-hidden className="size-3.5" />,
  info: <CircleDot aria-hidden className="size-3.5" />,
  neutral: <CircleDashed aria-hidden className="size-3.5" />,
};

/** Status is never conveyed by colour alone: icon + text label always ship together. */
export function StatusPill({
  tone,
  label,
  className,
  pulse,
  size = 'md',
}: {
  tone: Tone;
  label: string;
  className?: string;
  pulse?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <Badge tone={tone} size={size} className={cn('pl-1.5', className)}>
      <span className={cn('inline-flex', pulse && 'motion-safe:animate-pulse-dot')}>
        {TONE_ICON[tone]}
      </span>
      {label}
    </Badge>
  );
}

export function Tag({
  children,
  className,
  mono,
}: {
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-xs border border-line bg-panel-soft px-1.5 py-0.5 text-micro text-muted',
        mono && 'font-mono text-micro',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line-strong bg-panel px-1.5 font-mono text-micro font-medium text-muted shadow-kbd',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
