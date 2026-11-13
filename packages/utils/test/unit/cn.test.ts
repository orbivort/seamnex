import { describe, expect, it } from 'vitest';
import { cn } from '../../src/cn';

describe('cn', () => {
  it('joins conditional class lists and drops falsy entries', () => {
    expect(cn('a', undefined, null, false, '', ['b', 'c'], { d: true, e: false })).toBe('a b c d');
  });

  it('keeps the later Tailwind utility when two conflict', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('treats the design-system text scale as a font size, not a colour', () => {
    // The bug this pins: `tailwind-merge` read `text-body` as a text colour and dropped the fill.
    expect(cn('text-primary-foreground', 'text-body')).toBe('text-primary-foreground text-body');
    expect(cn('text-micro', 'text-display')).toBe('text-display');
  });
});
