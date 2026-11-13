import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Splash } from '../../../src/primitives/Splash';

/**
 * The splash is the frame before React mounts, and `index.html` carries the same block as static
 * markup. It is a polite status region so a screen reader is not left in silence while the
 * platform boots.
 */
describe('Splash', () => {
  it('is a polite status region naming the app and its default label', () => {
    render(<Splash appName="Seamnex" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.className).toContain('min-h-screen');
    expect(screen.getByText('Seamnex')).toBeDefined();
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  it('takes a caller label and a caller class', () => {
    render(<Splash appName="Seamnex" label="Reading your session…" className="extra-marker" />);
    expect(screen.getByText('Reading your session…')).toBeDefined();
    expect(screen.getByRole('status').className).toContain('extra-marker');
  });

  it('renders the mark as decorative text', () => {
    const { container } = render(<Splash appName="Seamnex" />);
    expect(container.querySelector('span[aria-hidden]')?.textContent).toBe('SN');
  });
});
