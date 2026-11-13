import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, Kbd, StatusPill, Tag } from '../../../src/primitives/Badge';
import { toneChip } from '../../../src/primitives/tone';

/**
 * A chip is the smallest surface a tone appears on. What matters is that a tone always resolves
 * to a complete class string, that `mono` swaps the caps recipe rather than adding a second one,
 * and that `StatusPill` never conveys status by colour alone.
 */
describe('Badge', () => {
  it('defaults to a neutral, medium, sans chip', () => {
    render(<Badge>Unknown</Badge>);
    const badge = screen.getByText('Unknown');
    expect(badge.className).toContain(toneChip('neutral'));
    expect(badge.className).toContain('px-2');
    expect(badge.className).toContain('label-caps-sans');
  });

  it('reads the shared tone recipe for the four domain tones', () => {
    for (const tone of ['positive', 'caution', 'danger', 'info'] as const) {
      const { unmount } = render(<Badge tone={tone}>Label</Badge>);
      expect(screen.getByText('Label').className).toContain(toneChip(tone));
      unmount();
    }
  });

  it('keeps the two badge-only surfaces out of the domain recipe', () => {
    const { unmount } = render(<Badge tone="accent">Brand</Badge>);
    expect(screen.getByText('Brand').className).toContain('bg-primary-soft');
    unmount();

    render(<Badge tone="ink">Chrome</Badge>);
    expect(screen.getByText('Chrome').className).toContain('bg-ink');
  });

  it('swaps the caps recipe for mono instead of stacking two of them', () => {
    render(
      <Badge mono size="sm" className="extra-marker">
        a1b2
      </Badge>,
    );
    const badge = screen.getByText('a1b2');
    expect(badge.className).toContain('label-caps-code');
    expect(badge.className).not.toContain('label-caps-sans');
    expect(badge.className).toContain('px-1.5');
    expect(badge.className).toContain('extra-marker');
  });
});

describe('StatusPill', () => {
  it('ships an icon with the label for every tone', () => {
    for (const tone of ['positive', 'caution', 'danger', 'info', 'neutral'] as const) {
      const { container, unmount } = render(<StatusPill tone={tone} label={`state-${tone}`} />);
      expect(screen.getByText(`state-${tone}`)).toBeDefined();
      // The icon is decorative: the label beside it carries the status.
      expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      unmount();
    }
  });

  it('adds the pulse only when asked, and only inside a motion-safe query', () => {
    const { rerender } = render(<StatusPill tone="positive" label="Live" />);
    expect(screen.getByText('Live').querySelector('.animate-pulse-dot')).toBeNull();

    rerender(<StatusPill tone="positive" label="Live" pulse />);
    expect(
      screen.getByText('Live').querySelector('.motion-safe\\:animate-pulse-dot'),
    ).not.toBeNull();
  });

  it('loses to the caller on size and class without dropping its own inset', () => {
    render(<StatusPill tone="info" label="Queued" size="sm" className="extra-marker" />);
    const pill = screen.getByText('Queued');
    expect(pill.className).toContain('px-1.5');
    expect(pill.className).toContain('pl-1.5');
    expect(pill.className).toContain('extra-marker');
  });
});

describe('Tag', () => {
  it('is a quiet chip by default', () => {
    render(<Tag>eu-west-1</Tag>);
    const tag = screen.getByText('eu-west-1');
    expect(tag.className).toContain('bg-panel-soft');
    expect(tag.className).not.toContain('font-mono');
  });

  it('switches to mono for an identifier', () => {
    render(<Tag mono>abc123</Tag>);
    expect(screen.getByText('abc123').className).toContain('font-mono');
  });

  it('accepts a caller class', () => {
    render(<Tag className="extra-marker">tag</Tag>);
    expect(screen.getByText('tag').className).toContain('extra-marker');
  });
});

describe('Kbd', () => {
  it('renders a real kbd element', () => {
    const { container } = render(<Kbd>Esc</Kbd>);
    const kbd = container.querySelector('kbd');
    expect(kbd?.textContent).toBe('Esc');
    expect(kbd?.className).toContain('font-mono');
  });
});
