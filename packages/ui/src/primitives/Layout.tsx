import type { ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Search } from 'lucide-react';
import { cn } from '@seamnex/utils';
import { Input } from './Field';

/**
 * Layout primitives.
 *
 * These exist because sixteen screens hand-wrote `grid gap-3 lg:grid-cols-[1.35fr_1fr]` with
 * seven different ratios across two different breakpoints, and thirty screens wrapped their
 * root in `<div className="animate-fade">`. Those are not decisions a page should re-make; they
 * are the product's layout and motion policy, so they live here and a page picks a name.
 */

/**
 * The root of a screen. Entry motion is `motion-safe`, so a reduced-motion visitor gets the
 * page without the fade instead of a 1ms flash.
 */
export function Page({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section';
}) {
  return <Tag className={cn('motion-safe:animate-fade', className)}>{children}</Tag>;
}

/*
 * Vertical rhythm is `flex flex-col gap-*` at the call site rather than a `Stack` component:
 * three primitives are enough, and the one that does not exist cannot drift.
 */
const gridVariants = cva('grid', {
  variants: {
    /* Card and KPI rows step up the scale, not sideways: one column, two, then the full row. */
    cols: {
      1: 'grid-cols-1',
      2: 'grid-cols-1 sm:grid-cols-2',
      3: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3',
      4: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4',
    },
    gap: {
      sm: 'gap-2',
      md: 'gap-3',
      lg: 'gap-4',
    },
  },
  defaultVariants: { cols: 2, gap: 'md' },
});

export type GridProps = VariantProps<typeof gridVariants> & {
  children: ReactNode;
  className?: string;
};

/** An even card/KPI grid. */
export function Grid({ children, cols, gap, className }: GridProps) {
  return <div className={cn(gridVariants({ cols, gap }), className)}>{children}</div>;
}

const splitVariants = cva('grid gap-3', {
  variants: {
    /**
     * Three ratios cover every screen that used to invent its own: a dominant column with a
     * supporting one, two equal columns, and a main column with a fixed-width rail.
     */
    ratio: {
      content: 'lg:grid-cols-[1.5fr_1fr]',
      even: 'lg:grid-cols-2',
      rail: 'lg:grid-cols-[1fr_22rem]',
    },
  },
  defaultVariants: { ratio: 'content' },
});

export type SplitLayoutProps = VariantProps<typeof splitVariants> & {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section';
};

/** Main column plus a supporting column, stacking to one column below `lg`. */
export function SplitLayout({ children, ratio, className, as: Tag = 'div' }: SplitLayoutProps) {
  return <Tag className={cn(splitVariants({ ratio }), className)}>{children}</Tag>;
}

/**
 * The search input every list screen carries: icon, field, and one width policy
 * (`min-w-50 flex-1 sm:max-w-xs`). Two screens used to rebuild this by hand with a 200px one
 * and a 220px one, and drift.
 */
export function SearchField({
  value,
  onValueChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={cn('relative min-w-50 flex-1 sm:max-w-xs', className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint"
      />
      <Input
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="pl-8"
      />
    </div>
  );
}
