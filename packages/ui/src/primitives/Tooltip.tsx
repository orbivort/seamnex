import type { ReactNode } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

/**
 * One provider per application.
 *
 * Radix expects a single provider to own the open/close delay shared by every tooltip. Creating
 * one per tooltip (which every instance used to do) means a context provider, a delay timer and a
 * portal per node — twenty-four of them on the workflow canvas alone.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={200}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({
  children,
  content,
  side = 'top',
}: {
  children: ReactNode;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-modal max-w-64 animate-fade rounded-sm border border-line-ink bg-ink px-2.5 py-1.5 text-meta leading-snug text-ink-text shadow-lift"
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-ink" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
