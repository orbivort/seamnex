import type { ReactNode } from 'react';
import { cn } from '@seamnex/utils';
import { SearchField } from '../primitives/Layout';

type FilterBarProps = {
  search: string;
  onSearch: (value: string) => void;
  searchLabel: string;
  placeholder: string;
  /** Filter controls rendered next to the search box. */
  children?: ReactNode;
  /** Result count or other trailing metadata. */
  trailing?: ReactNode;
  className?: string;
};

/**
 * One toolbar for every list screen. Previously each list rebuilt the same
 * search-input-plus-filters row, and the copies drifted (labels, widths, counts).
 * The field itself is `SearchField`, so the third copy — the registry screen — could not
 * reintroduce a 200px/220px split.
 */
export function FilterBar({
  search,
  onSearch,
  searchLabel,
  placeholder,
  children,
  trailing,
  className,
}: FilterBarProps) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-2 border-b border-line px-4 py-2', className)}
    >
      <SearchField
        value={search}
        onValueChange={onSearch}
        label={searchLabel}
        placeholder={placeholder}
      />
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
      {trailing ? (
        <span className="ml-auto font-mono text-micro text-faint">{trailing}</span>
      ) : null}
    </div>
  );
}

type FilterChipProps = {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
};

export function FilterChip({ active, onClick, children }: FilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'tap-target rounded-xs border px-2 py-1 text-meta font-medium',
        active
          ? 'border-primary bg-primary-soft text-primary-soft-foreground'
          : 'border-line bg-panel text-muted hover:border-line-strong hover:text-text',
      )}
    >
      {children}
    </button>
  );
}
