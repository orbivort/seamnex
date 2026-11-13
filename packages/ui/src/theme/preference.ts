/**
 * The theme preference: one stored string and the two DOM writes that make it visible.
 *
 * This file is half of the feature; the stylesheet is the other half. `theme-dark.css` declares
 * `.dark` and `.light` as the only hooks a preference needs, because every semantic token in
 * `tokens.css` is a single `light-dark()` pair and `color-scheme` is the whole switch. So nothing
 * here names a colour — it only decides which side of those pairs resolves.
 *
 * `system` is the default and is represented by *no class at all*. `:root { color-scheme: light
 * dark }` then stays authoritative, the OS owns the choice, and a user who never touches the
 * control gets exactly the behaviour that shipped before the control existed. That is the whole
 * reason the value is stored rather than the resolved scheme: storing `light` or `dark` would
 * freeze a preference the user never expressed.
 */

export const THEME_STORAGE_KEY = 'seamnex:theme';

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * `null` is the interesting case: it is what a first visit and a cleared storage both produce,
 * and it has to fall through to `system` rather than throw or pick a side.
 */
function isThemePreference(value: string | null): value is ThemePreference {
  return value !== null && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Storage can be blocked by a partition policy, a privacy mode or an exhausted quota, and every
 * one of those throws on access rather than returning `null`. A theme is decorative: an unreadable
 * store means "follow the OS", never an error boundary.
 */
export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* The choice still applies to this page; it just does not survive a reload. */
  }
}

/**
 * Both hooks at once, because `classList.toggle` with a force argument is idempotent: selecting
 * `system` clears both, and the browser's `prefers-color-scheme` takes over again with no event
 * listener and no re-render in either application.
 */
export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  root.classList.toggle('dark', preference === 'dark');
  root.classList.toggle('light', preference === 'light');
}
