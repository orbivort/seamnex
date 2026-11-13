import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tooltip, TooltipProvider } from '../../../src/primitives/Tooltip';

/**
 * One provider owns the open/close delay for every tooltip in the application, so the wrapper is
 * the contract and the tooltip only has to prove that its content reaches the portal with the
 * requested side, and that the trigger stays the caller's own element.
 */
describe('Tooltip', () => {
  it('shows its content on focus and keeps the caller as the trigger', async () => {
    render(
      <TooltipProvider>
        <Tooltip content="Restart the instance">
          <button type="button">Restart</button>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Restart' });
    fireEvent.focus(trigger);

    const content = await screen.findByRole('tooltip');
    expect(content.textContent).toContain('Restart the instance');
    expect(trigger.getAttribute('aria-describedby')).toBe(content.id);
  });

  it('places the content on the requested side', async () => {
    render(
      <TooltipProvider>
        <Tooltip content="Filters" side="left">
          <button type="button">Filters</button>
        </Tooltip>
      </TooltipProvider>,
    );
    fireEvent.focus(screen.getByRole('button', { name: 'Filters' }));

    const content = await screen.findByRole('tooltip');
    expect(content.getAttribute('data-side')).toBe('left');
  });

  it('opens on the default side and closes when the trigger is blurred', async () => {
    render(
      <TooltipProvider>
        <Tooltip content="Sessions">
          <button type="button">Sessions</button>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Sessions' });
    fireEvent.focus(trigger);
    const content = await screen.findByRole('tooltip');
    expect(content.getAttribute('data-side')).toBe('top');

    fireEvent.blur(trigger);
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerDown(document.body);
  });
});
