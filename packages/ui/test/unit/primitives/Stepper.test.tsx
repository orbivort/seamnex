import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Stepper, type Step } from '../../../src/primitives/Stepper';

const steps: Step[] = [
  { id: 'draft', label: 'Draft', description: 'Fill in the request', state: 'complete' },
  { id: 'review', label: 'Review', state: 'current' },
  { id: 'approve', label: 'Approve', state: 'upcoming' },
  { id: 'deploy', label: 'Deploy', state: 'error' },
];

/**
 * A stepper is a navigation control, not decoration. The step name lives beside the number, so
 * every button has to carry its own label; only the steps a user may return to are enabled, and
 * the current one is announced as `aria-current`.
 */
describe('Stepper', () => {
  it('labels every step with its position, name and state', () => {
    render(<Stepper steps={steps} />);
    expect(screen.getByRole('button', { name: 'Step 1 of 4: Draft (complete)' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Step 2 of 4: Review (current)' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Step 3 of 4: Approve' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Step 4 of 4: Deploy' })).toBeDefined();
  });

  it('marks only the current step as aria-current', () => {
    render(<Stepper steps={steps} />);
    expect(screen.getByRole('button', { name: /Step 2 of 4/ }).getAttribute('aria-current')).toBe(
      'step',
    );
    expect(
      screen.getByRole('button', { name: /Step 1 of 4/ }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('disables the steps a user may not jump to', () => {
    render(<Stepper steps={steps} onSelect={vi.fn()} />);
    expect(
      (screen.getByRole('button', { name: /Step 1 of 4/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: /Step 2 of 4/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: /Step 3 of 4/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: /Step 4 of 4/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('reports a selection from a reachable step only', () => {
    const onSelect = vi.fn();
    render(<Stepper steps={steps} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Step 1 of 4/ }));
    fireEvent.click(screen.getByRole('button', { name: /Step 2 of 4/ }));
    fireEvent.click(screen.getByRole('button', { name: /Step 3 of 4/ }));

    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenNthCalledWith(1, 'draft');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'review');
  });

  it('is inert when the caller has nothing to select', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<Stepper steps={steps} />);
    // Reachable but unhandled: enabled, and clicking must not throw.
    fireEvent.click(screen.getByRole('button', { name: /Step 2 of 4/ }));
    expect(onSelect).not.toHaveBeenCalled();

    rerender(<Stepper steps={steps} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Step 2 of 4/ }));
    expect(onSelect).toHaveBeenCalledWith('review');
  });

  it('draws a tick for a complete step, a number for the open ones and an icon for an error', () => {
    const { container } = render(<Stepper steps={steps} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]?.querySelector('svg')).not.toBeNull();
    expect(buttons[1]?.textContent).toBe('2');
    expect(buttons[2]?.textContent).toBe('3');
    expect(buttons[3]?.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('ol > li')).toHaveLength(4);
  });

  it('renders descriptions where they exist', () => {
    render(<Stepper steps={steps} />);
    expect(screen.getByText('Fill in the request').className).toContain('text-muted');
  });

  it('lays out horizontally by default and keeps a caller class', () => {
    const { container } = render(<Stepper steps={steps} className="extra-marker" />);
    const list = container.querySelector('ol') as HTMLElement;
    expect(list.className).toContain('flex-wrap');
    expect(list.className).toContain('extra-marker');
    // No rail between the steps in the horizontal layout.
    expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0);
  });

  it('stacks vertically, with a rail between consecutive steps', () => {
    const { container } = render(<Stepper steps={steps} orientation="vertical" />);
    const list = container.querySelector('ol') as HTMLElement;
    expect(list.className).toContain('flex-col');
    expect(container.querySelectorAll('li')).toHaveLength(4);
    // Three rails: one after each step but the last.
    expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(3);
  });
});
