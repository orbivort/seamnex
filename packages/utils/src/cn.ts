import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `tailwind-merge` cannot see the design system's own type scale. The system defines
 * `--text-micro … --text-display`, and `tailwind-merge` reads those names as text *colours*
 * because the `text-*` namespace is ambiguous. It then treated `text-primary-foreground
 * text-body` as two competing utilities, kept the last one and silently dropped the colour —
 * a primary button rendered its label in body ink on top of the brand fill. Registering the
 * scale keeps font-size and text-colour in separate conflict groups.
 *
 * Keep this list in step with `packages/ui/src/styles/tokens.css`. A role renamed there and
 * forgotten here re-introduces the dropped-colour bug, silently.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['micro', 'meta', 'body', 'heading', 'title', 'metric', 'display'],
    },
  },
});

/** Merge conditional class lists while resolving conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
