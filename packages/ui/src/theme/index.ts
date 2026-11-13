/**
 * Subpath barrel for the theme preference.
 *
 * The storage module and the control are exported together because the control is useless
 * without the pre-paint script that shares its key: a consumer that mounts `ThemeToggle` without
 * `THEME_STORAGE_KEY` in `index.html` gets a toggle that works but flashes on reload. Keeping the
 * key in the same barrel makes that omission visible at the import site.
 */
export {
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  applyThemePreference,
  readThemePreference,
  writeThemePreference,
  type ThemePreference,
} from './preference';
export { ThemeToggle, useThemePreference } from './ThemeToggle';
