import { createContext, useContext, type ReactNode } from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { cn } from '@seamnex/utils';

/**
 * The selected tab value, mirrored out of `Tabs` for `TabPanel`.
 *
 * Radix knows internally which panel is selected, but a *force-mounted* panel reports itself as
 * present, so Radix stops setting `hidden` on it — the panel has to hide itself, which needs the
 * selected value. Reading it from the `value` prop `Tabs` already takes avoids a second source of
 * truth.
 */
const TabsValueContext = createContext<string | null>(null);

export function Tabs({
  value,
  onValueChange,
  tabs,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: ReactNode; count?: number | undefined }[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={className}>
      <TabsValueContext.Provider value={value}>
        <TabsPrimitive.List
          aria-label="Sections"
          className="scroll-slim flex gap-0 overflow-x-auto overscroll-x-contain border-b border-line"
        >
          {tabs.map((tab) => (
            <TabsPrimitive.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                'relative flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5',
                'text-body font-medium text-muted transition-colors hover:text-text',
                'data-[state=active]:border-primary data-[state=active]:text-link',
                'focus-visible:-outline-offset-2',
              )}
            >
              {tab.label}
              {typeof tab.count === 'number' ? (
                <span className="rounded-xs bg-paper-deep px-1 font-mono text-micro text-muted">
                  {tab.count}
                </span>
              ) : null}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        {children}
      </TabsValueContext.Provider>
    </TabsPrimitive.Root>
  );
}

export function TabPanel({
  value,
  children,
  className,
  keepMounted = false,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  /**
   * Keep an inactive panel mounted instead of letting Radix unmount it. Radix unmounting is the
   * default because it is the cheap option, and destroying local state with it is invisible: a
   * typed environment override or a scrolled table is gone after one stray click on another tab.
   *
   * Opt in **only** for a panel that holds user input. Opting in everywhere costs what the default
   * buys: every hidden panel would mount at once, so a six-tab detail screen would fire six sets of
   * queries on first paint and keep six subscriptions alive.
   */
  keepMounted?: boolean;
}) {
  const selected = useContext(TabsValueContext) === value;
  const hide = keepMounted && !selected;
  return (
    <TabsPrimitive.Content
      value={value}
      {...(keepMounted ? { forceMount: true as const } : {})}
      {...(hide ? { hidden: true } : {})}
      // `hidden` is an attribute, and an attribute loses to any class: a `flex`/`grid` utility in
      // `className` would leave the "hidden" panel on screen. The inline style wins that argument.
      style={hide ? { display: 'none' } : undefined}
      className={cn('animate-fade focus-ring-inset', className)}
    >
      {children}
    </TabsPrimitive.Content>
  );
}
