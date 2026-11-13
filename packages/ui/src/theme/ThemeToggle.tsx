import { useCallback, useState } from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { cn } from '@seamnex/utils';
import {
  applyThemePreference,
  readThemePreference,
  writeThemePreference,
  type ThemePreference,
} from './preference';

/**
 * `system` leads because it is the default and the way back. A two-item control cannot express
 * "follow my OS", and hiding that state behind a cycle would make it undiscoverable — so the
 * order is the reset first, then the two values it overrides.
 */
const OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'Follow system theme', icon: Monitor },
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon },
];

/**
 * The preference and its writer. Read once on mount: the pre-paint script in `index.html`
 * has already put the stored class on `<html>`, so the first render agrees with the document
 * instead of correcting it.
 */
export function useThemePreference(): {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
} {
  const [preference, setStored] = useState<ThemePreference>(readThemePreference);

  const setPreference = useCallback((next: ThemePreference) => {
    // Document first: a click must repaint even if the storage write is refused.
    applyThemePreference(next);
    writeThemePreference(next);
    setStored(next);
  }, []);

  return { preference, setPreference };
}

/**
 * A three-state preference, not a switch.
 *
 * `Switch` cannot express it: a boolean has no way to say "follow the OS", and collapsing the
 * three states into "dark on/off" would silently drop the mode most users should stay in. The
 * radio group is the pattern that matches the question — one of three, always exactly one — and
 * Radix supplies the roving focus and arrow-key behaviour, so this is a skin over it.
 *
 * It sits on the ink chrome in both shells, which is why every colour here is an `ink-*` or
 * `-on-ink` token: those never invert, so the control looks the same whichever theme is active.
 *
 * Each segment is 24×24 (WCAG 2.5.8's floor) and deliberately does not use `tap-target`: that
 * utility grows the hit area 8px per side on a coarse pointer, and segments 2px apart would
 * overlap each other — the contract in `utilities.css` requires `gap-2` in a row that uses it.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useThemePreference();

  return (
    <RadioGroupPrimitive.Root
      value={preference}
      onValueChange={(value) => setPreference(value as ThemePreference)}
      aria-label="Colour theme"
      orientation="horizontal"
      loop
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-xs border border-line-ink bg-ink-raised p-px',
        className,
      )}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <RadioGroupPrimitive.Item
          key={value}
          value={value}
          aria-label={label}
          title={label}
          className={cn(
            'grid size-6 cursor-pointer place-items-center rounded-xs text-ink-text-muted transition-colors',
            'hover:bg-ink-hover hover:text-ink-text',
            'data-[state=checked]:bg-ink-active data-[state=checked]:text-primary-on-ink',
            '[&>svg]:size-3.5',
          )}
        >
          <Icon aria-hidden />
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
