import { describe, expect, it } from 'vitest';
import { toneBar, toneBox, toneChip, toneRow, toneText } from '../../../src/primitives/tone';

/**
 * The tone recipes are the one place a status colour is defined, so every key of every recipe
 * must produce a complete class string: Tailwind scans source text, and a value that is empty,
 * duplicated with another tone, or built from a fragment would silently not be generated.
 */
const TONES = ['positive', 'caution', 'danger', 'info', 'neutral'] as const;

describe('toneBox', () => {
  it('gives every tone a border and a fill, and no two tones share one', () => {
    const values = TONES.map((tone) => toneBox(tone));
    for (const value of values) {
      expect(value).toMatch(/^border-\S+ bg-\S+$/);
    }
    expect(new Set(values).size).toBe(TONES.length);
  });

  it('pairs each tone with its own colour step', () => {
    expect(toneBox('positive')).toBe('border-success-border bg-success-soft');
    expect(toneBox('caution')).toBe('border-warning-border bg-warning-soft');
    expect(toneBox('danger')).toBe('border-danger-border bg-danger-soft');
    expect(toneBox('info')).toBe('border-info-border bg-info-soft');
    expect(toneBox('neutral')).toBe('border-line-strong bg-panel-soft');
  });
});

describe('toneText', () => {
  it('reads the strong step of every tone', () => {
    expect(TONES.map((tone) => toneText(tone))).toEqual([
      'text-success-strong',
      'text-warning-strong',
      'text-danger-strong',
      'text-info-strong',
      'text-muted',
    ]);
  });
});

describe('toneChip', () => {
  it('carries the full box recipe so a chip never needs a second class', () => {
    for (const tone of TONES) {
      expect(toneChip(tone)).toContain(toneBox(tone).split(' ')[0] ?? '');
      expect(toneChip(tone)).toContain(toneText(tone));
    }
  });

  it('fills a neutral chip with the deeper paper instead of a wash', () => {
    expect(toneChip('neutral')).toBe('border-line-strong bg-paper-deep text-muted');
  });
});

describe('toneRow', () => {
  it('washes only the four alerting tones', () => {
    expect(toneRow('positive')).toBe('bg-success-wash');
    expect(toneRow('caution')).toBe('bg-warning-wash');
    expect(toneRow('danger')).toBe('bg-danger-wash');
    expect(toneRow('info')).toBe('bg-info-wash');
  });

  it('leaves default rows and neutral rows unpainted', () => {
    expect(toneRow('default')).toBe('');
    expect(toneRow('neutral')).toBe('');
  });
});

describe('toneBar', () => {
  it('fills a bar with the solid step of a tone', () => {
    expect(toneBar('accent')).toBe('bg-primary');
    expect(toneBar('positive')).toBe('bg-success');
    expect(toneBar('caution')).toBe('bg-warning');
    expect(toneBar('danger')).toBe('bg-danger');
    expect(toneBar('info')).toBe('bg-info');
    expect(toneBar('neutral')).toBe('bg-neutral-fill');
  });
});
