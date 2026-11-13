import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyThemePreference,
  readThemePreference,
  writeThemePreference,
} from '../../../src/theme/preference';

/**
 * The store is the whole persistence contract: one key, three accepted values, and a fallback to
 * `system` for every way a read can fail. `system` is represented by the absence of a class, so
 * the important assertions here are about what is *removed* as much as what is added.
 */
beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = '';
});

describe('readThemePreference', () => {
  it('defaults to system when nothing is stored', () => {
    expect(readThemePreference()).toBe('system');
  });

  it('round-trips every accepted value', () => {
    for (const preference of ['system', 'light', 'dark'] as const) {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
      expect(readThemePreference()).toBe(preference);
    }
  });

  it('rejects a value the stylesheet has no hook for', () => {
    // Casing and near-misses are the realistic corruptions: a hand-edited key, or a value from a
    // future build that has since been renamed.
    for (const written of ['Dark', 'midnight', '', 'light ']) {
      window.localStorage.setItem(THEME_STORAGE_KEY, written);
      expect(readThemePreference()).toBe('system');
    }
  });

  it('falls back to system when storage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(readThemePreference()).toBe('system');
  });
});

describe('writeThemePreference', () => {
  it('persists the choice under the shared key', () => {
    writeThemePreference('dark');

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('does not throw when storage refuses the write', () => {
    // A full quota or a blocked partition is not the user's problem, and it must not become an
    // error boundary on a click.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(() => writeThemePreference('light')).not.toThrow();
  });
});

describe('applyThemePreference', () => {
  it('sets the dark hook and clears the light one', () => {
    document.documentElement.classList.add('light');

    applyThemePreference('dark');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('sets the light hook and clears the dark one', () => {
    document.documentElement.classList.add('dark');

    applyThemePreference('light');

    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('leaves no hook at all for system, so the OS resolves the pair', () => {
    document.documentElement.classList.add('dark');

    applyThemePreference('system');

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });
});
