import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY } from '../../../src/theme/preference';
import { ThemeToggle } from '../../../src/theme/ThemeToggle';

/**
 * The control is a thin skin over Radix's radio group; what belongs to this package is the link
 * between the selected value and the two side effects — the class on `<html>` and the stored key.
 * Both are asserted here, because a toggle that changes its own appearance but not the document
 * would pass a snapshot test and still be broken.
 */
beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = '';
});

function radios() {
  return screen.getAllByRole('radio');
}

describe('ThemeToggle', () => {
  it('renders one named option per state and checks the stored one', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { container } = render(<ThemeToggle className="extra-marker" />);

    const group = screen.getByRole('radiogroup', { name: 'Colour theme' });
    expect(group).toBeDefined();
    // The caller class lands on the element the shells position in their strips.
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');

    expect(radios()).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Follow system theme' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Light theme' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Dark theme' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('checks system by default, which is no stored value and no class', () => {
    render(<ThemeToggle />);

    expect(
      screen.getByRole('radio', { name: 'Follow system theme' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('applies and stores a chosen theme', () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('radio', { name: 'Dark theme' }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark theme' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('clears both hooks when the choice returns to the system preference', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    document.documentElement.classList.add('dark');
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('radio', { name: 'Follow system theme' }));

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });
});
