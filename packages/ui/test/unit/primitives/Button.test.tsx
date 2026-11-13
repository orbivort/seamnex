import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, IconButton, buttonVariants } from '../../../src/primitives/Button';

/**
 * The primitive every screen reaches for. What is worth pinning: it never submits a form by
 * accident, an icon-only control always carries a name, and a tone/variant recipe stays a joined
 * class string (Tailwind scans source text, so a fragment would never be generated).
 */
describe('Button', () => {
  it('defaults to type="button" so it cannot submit an enclosing form', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('button');
  });

  it('lets the caller opt into submit without losing merged classes', () => {
    render(
      <Button type="submit" className="extra-marker">
        Send
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button.getAttribute('type')).toBe('submit');
    expect(button.className).toContain('extra-marker');
  });

  it('composes variant, size and block into one class string', () => {
    const classes = buttonVariants({ variant: 'primary', size: 'lg', block: true });
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('h-11');
    expect(classes).toContain('w-full');
    expect(classes).not.toContain('undefined');
  });

  it('never renders a falsy class from an unset variant', () => {
    // `cn` must drop the `false`/`undefined` a cva default leaves behind.
    const classes = buttonVariants({ variant: 'ghost' });
    expect(classes).not.toMatch(/undefined|false/);
  });

  it('wraps an icon and a trailing node in their own shrink-proof spans', () => {
    render(
      <Button icon={<span data-testid="leading" />} trailing={<span data-testid="trailing" />}>
        Deploy
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Deploy' });
    for (const testId of ['leading', 'trailing']) {
      const wrapper = screen.getByTestId(testId).parentElement as HTMLElement;
      // The icon must never be squeezed by a long label, and must not leak a size rule upward.
      expect(wrapper.tagName).toBe('SPAN');
      expect(wrapper.className).toContain('shrink-0');
      expect(button.contains(wrapper)).toBe(true);
    }
  });

  it('renders no icon slots when the caller supplies none', () => {
    const { container } = render(<Button>Deploy</Button>);
    expect(container.querySelectorAll('span')).toHaveLength(0);
    expect(container.firstElementChild?.textContent).toBe('Deploy');
  });
});

describe('IconButton', () => {
  it('carries an accessible name and a matching tooltip', () => {
    render(
      <IconButton label="Close the dialog">
        <span aria-hidden="true">x</span>
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Close the dialog' });
    expect(button.getAttribute('title')).toBe('Close the dialog');
    expect(button.getAttribute('type')).toBe('button');
  });

  it('is always a ghost icon square unless the caller says otherwise', () => {
    const { rerender } = render(
      <IconButton label="Refresh">
        <span aria-hidden="true">r</span>
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button.className).toContain('size-8');
    expect(button.className).toContain('hover:bg-primary-soft');

    rerender(
      <IconButton label="Refresh" variant="danger" className="extra-marker">
        <span aria-hidden="true">r</span>
      </IconButton>,
    );
    const danger = screen.getByRole('button', { name: 'Refresh' });
    expect(danger.className).toContain('bg-danger');
    expect(danger.className).toContain('extra-marker');
  });
});
