import type { ReactNode } from 'react';
import { cn } from '@seamnex/utils';
import type { Tone } from '@seamnex/domain';
import { toneRow } from './tone';

export type Column<T> = {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /**
   * The cell that carries the row's identity, and therefore its link target: when `renderRowLink`
   * is also supplied, this cell's content becomes the row's only keyboard stop. A column marked
   * `primary` must not be hidden by `hideBelow`, or the row loses its link on narrow screens.
   */
  primary?: boolean;
  align?: 'left' | 'right' | 'center';
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  width?: string;
  mono?: boolean;
  /**
   * Identifiers (`D01-01`, a slug, a version) must not break across lines. The header already
   * refuses to wrap, so without this a table that is one column too tight printed `D01-` above
   * `01` — which reads as two different keys rather than one narrow column.
   */
  nowrap?: boolean;
};

const HIDE_CLASS: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

const ALIGN_CLASS = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/**
 * The row-link style, owned by the primitive so the call sites cannot drift: `block` makes the whole
 * cell width clickable, and the colour/hover pair is the one the screens already use for an in-cell
 * link (`apps/console/src/features/admin/UsersPage.tsx`).
 */
const ROW_LINK_CLASS = 'block font-medium text-text hover:text-link';

export type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowActivate?: (row: T) => void;
  /**
   * Renders the primary cell's content as the row's link target. Receives the class that fills the
   * cell so every row link looks the same; without it the primary cell stays inert and the table
   * keeps whatever in-cell controls the columns define.
   */
  renderRowLink?: (row: T, className: string, children: ReactNode) => ReactNode;
  empty?: ReactNode;
  dense?: boolean;
  caption?: string;
  className?: string;
  selectedKey?: string;
  rowTone?: (row: T) => Tone | 'default';
};

/**
 * Deliberately not wrapped in `memo`: identity stability of `columns`, `rowKey` and `onRowActivate`
 * is the caller's job, and the row — not the table — is the unit that re-renders without it.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowActivate,
  renderRowLink,
  empty,
  dense,
  caption,
  className,
  selectedKey,
  rowTone,
}: DataTableProps<T>) {
  if (rows.length === 0 && empty) {
    return <div className={className}>{empty}</div>;
  }

  return (
    // `overscroll-x-contain` and not `overscroll-contain`: this wrapper scrolls horizontally only,
    // and containing the vertical axis would swallow the page's wheel while the pointer is over the
    // table — `overflow-x: auto` already makes it a vertical scroll container that cannot scroll.
    //
    // `edge-fade-x` is the only cue that columns continue off-screen on a touch device, where the
    // platform scrollbar is an overlay that appears only after the finger has already moved.
    <div
      className={cn(
        'scroll-slim edge-fade-x print-unclip w-full overflow-x-auto overscroll-x-contain',
        className,
      )}
    >
      <table className="w-full border-collapse text-body">
        {caption ? (
          <caption className="px-4 pb-2 text-left text-meta text-faint">{caption}</caption>
        ) : null}
        <thead>
          <tr className="border-b border-line-strong bg-paper-deep">
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  'label-caps-sans px-4 whitespace-nowrap',
                  dense ? 'py-1.5' : 'py-2.5',
                  ALIGN_CLASS[column.align ?? 'left'],
                  column.hideBelow ? HIDE_CLASS[column.hideBelow] : '',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = selectedKey === rowKey(row);
            return (
              <tr
                key={rowKey(row)}
                onClick={
                  onRowActivate
                    ? (event) => {
                        // The primary cell's link already navigates; following the bubble too would
                        // push a second history entry for the same row.
                        if (event.target instanceof Element && event.target.closest('a')) return;
                        onRowActivate(row);
                      }
                    : undefined
                }
                // `aria-selected` is only valid on grid/treegrid rows; a plain table uses aria-current.
                aria-current={selected ? true : undefined}
                data-selected={selected || undefined}
                className={cn(
                  'border-b border-line transition-colors duration-100',
                  toneRow(rowTone?.(row) ?? 'default'),
                  onRowActivate && 'cursor-pointer hover:bg-primary-soft/60',
                  selected && 'bg-primary-soft/80',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      'px-4 align-middle',
                      dense ? 'py-1.5' : 'py-2.5',
                      ALIGN_CLASS[column.align ?? 'left'],
                      column.mono && 'font-mono text-meta',
                      column.nowrap && 'whitespace-nowrap',
                      column.hideBelow ? HIDE_CLASS[column.hideBelow] : '',
                    )}
                  >
                    {column.primary && renderRowLink
                      ? renderRowLink(row, ROW_LINK_CLASS, column.cell(row))
                      : column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A no-op that names the convention: column definitions belong at module scope, so a screen does
 * not rebuild the array — and every cell closure in it — on each render. `DataTable` no longer
 * compares props, so this is where the stability that used to be promised by `memo` actually comes
 * from; the codebase can be linted for "only `defineColumns` produces a `Column[]`".
 */
export function defineColumns<T>(columns: Column<T>[]): Column<T>[] {
  return columns;
}

export function TableToolbar({
  children,
  className,
  end,
}: {
  children: ReactNode;
  className?: string;
  end?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {end ? <div className="flex items-center gap-2">{end}</div> : null}
    </div>
  );
}

export function KeyValueRows({
  rows,
  className,
}: {
  rows: { key: string; label: ReactNode; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={cn('divide-y divide-line', className)}>
      {rows.map((row) => (
        <div key={row.key} className="leader-row py-2 text-body">
          <dt className="shrink-0 text-muted">{row.label}</dt>
          <dd className="ml-auto text-right font-medium text-text">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
