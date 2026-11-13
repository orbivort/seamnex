import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CornerDownLeft, Search } from 'lucide-react';
import { Dialog, Input, Kbd } from '@seamnex/ui';
import { cn } from '@seamnex/utils';
import { preloadRoute } from '../lazy-routes';
import { useNavigation } from '../use-navigation';

/**
 * How long the result count waits before it is announced. A live region queues every change it is
 * given, so reading the count on each keystroke makes a four-letter query queue four sentences, all
 * of them already stale — and only the last one matters. Waiting for the typing to settle announces
 * the answer instead of the search history.
 *
 * A timer rather than `useDeferredValue`: deferral yields under render pressure, which still lets
 * several intermediate counts through between keystrokes, and it belongs on the render path (the
 * filter itself), not on a side channel to assistive technology.
 */
const ANNOUNCE_DELAY_MS = 400;

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { flat } = useNavigation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [announcement, setAnnouncement] = useState('');

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return flat.filter((item) => needle === '' || item.label.toLowerCase().includes(needle));
  }, [flat, query]);

  /**
   * What the live region should end up saying. The count stays — it is the one piece of feedback a
   * keyboard user gets that the list changed — but it is announced once the query settles instead
   * of once per keystroke. "No results" is the case worth interrupting for, so it is kept verbatim.
   */
  const resultMessage =
    items.length === 0
      ? 'No section matches'
      : `${items.length} section${items.length === 1 ? '' : 's'} available`;

  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncement(resultMessage), ANNOUNCE_DELAY_MS);
    // Clearing the previous timer is the fix: each keystroke cancels the announcement it replaced.
    return () => window.clearTimeout(timer);
  }, [resultMessage]);

  /**
   * Closing resets the search here, not in an effect: closing is a user event, and an effect
   * could only reset the palette one render after it had already been reopened with the previous
   * query still in the box.
   */
  const changeOpen = (next: boolean) => {
    if (!next) {
      setQuery('');
      setCursor(0);
    }
    onOpenChange(next);
  };

  const go = (href: string) => {
    changeOpen(false);
    navigate(href);
  };

  const activeId = items.length === 0 ? undefined : `palette-option-${cursor}`;

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title="Jump to"
      description="Search console sections. Arrow keys move, Enter opens."
      size="sm"
    >
      <div className="space-y-3">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint"
          />
          {/* eslint-disable jsx-a11y/no-autofocus -- a palette exists to be typed into: the caret
              belongs in this field the moment the dialog opens, and the dialog does not own it. */}
          <Input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="palette-listbox"
            aria-autocomplete="list"
            {...(activeId === undefined ? {} : { 'aria-activedescendant': activeId })}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              // Moving the cursor warms the highlighted screen's chunk, so Enter opens it with
              // one round trip instead of two.
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                const next = Math.min(cursor + 1, items.length - 1);
                setCursor(next);
                const item = items[next];
                if (item) preloadRoute(item.href);
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                const next = Math.max(cursor - 1, 0);
                setCursor(next);
                const item = items[next];
                if (item) preloadRoute(item.href);
              }
              if (event.key === 'Enter') {
                const item = items[cursor];
                if (item) go(item.href);
              }
            }}
            placeholder="Catalog, instances, audit, break-glass…"
            className="pl-8"
            aria-label="Search console sections"
          />
          {/* eslint-enable jsx-a11y/no-autofocus */}
        </div>

        {/*
          `role="status"` already implies `aria-live="polite"`; declaring both is the redundant pair
          A11Y-07 is about. The text is the settled message, not the current one, so typing does not
          queue an announcement per letter.
        */}
        <p role="status" className="sr-only">
          {announcement}
        </p>

        <ul
          id="palette-listbox"
          role="listbox"
          aria-label="Console sections"
          className="max-h-72 overflow-y-auto"
        >
          {items.length === 0 ? (
            <li className="px-2 py-6 text-center text-meta text-faint">
              No section matches “{query}”.
            </li>
          ) : null}
          {items.map((item, index) => {
            const Icon = item.icon;
            const selected = index === cursor;
            return (
              <li key={item.href} role="none">
                <button
                  type="button"
                  id={`palette-option-${index}`}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  onMouseEnter={() => {
                    setCursor(index);
                    preloadRoute(item.href);
                  }}
                  onClick={() => go(item.href)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-body',
                    selected ? 'bg-primary-soft text-link' : 'text-text hover:bg-paper-deep',
                  )}
                >
                  <Icon className="size-4 shrink-0 text-faint" />
                  <span className="flex-1">{item.label}</span>
                  {selected ? <CornerDownLeft className="size-3.5 text-faint" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>

        <p className="flex items-center gap-2 border-t border-line pt-2 text-micro text-faint">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move <Kbd>↵</Kbd> to open <Kbd>esc</Kbd> to close
        </p>
      </div>
    </Dialog>
  );
}
