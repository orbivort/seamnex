import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TabPanel, Tabs } from '../../../src/primitives/Tabs';

/**
 * Tabs are mostly Radix, but the panel's force-mount contract is ours: an opt-in panel stays
 * mounted and hides itself, because Radix stops setting `hidden` on a force-mounted panel that
 * reports itself as present.
 */
describe('Tabs', () => {
  it('renders one trigger per tab, with a count only where one exists', () => {
    const { container } = render(
      <Tabs
        value="a"
        onValueChange={vi.fn()}
        tabs={[
          { value: 'a', label: 'Overview', count: 0 },
          { value: 'b', label: 'Jobs' },
        ]}
        className="extra-marker"
      >
        <TabPanel value="a">Overview body</TabPanel>
      </Tabs>,
    );
    const list = screen.getByRole('tablist', { name: 'Sections' });
    expect(list.tagName).toBe('DIV');
    // The caller class lands on the root the caller is styling.
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
    expect(screen.getByRole('tab', { name: /Overview/ }).textContent).toBe('Overview0');
    expect(screen.getByRole('tab', { name: 'Jobs' }).textContent).toBe('Jobs');
    expect(screen.getByRole('tab', { name: /Overview/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('reports a click back to the caller', () => {
    const onValueChange = vi.fn();
    render(
      <Tabs
        value="a"
        onValueChange={onValueChange}
        tabs={[
          { value: 'a', label: 'Overview' },
          { value: 'b', label: 'Jobs' },
        ]}
      >
        <TabPanel value="a">Overview body</TabPanel>
      </Tabs>,
    );
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Jobs' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }));

    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('renders only the selected panel by default', () => {
    render(
      <Tabs
        value="a"
        onValueChange={vi.fn()}
        tabs={[
          { value: 'a', label: 'Overview' },
          { value: 'b', label: 'Jobs' },
        ]}
      >
        <TabPanel value="a" className="extra-marker">
          Overview body
        </TabPanel>
        <TabPanel value="b">Jobs body</TabPanel>
      </Tabs>,
    );
    expect(screen.getByRole('tabpanel').textContent).toBe('Overview body');
    expect(screen.getByRole('tabpanel').className).toContain('extra-marker');
    expect(screen.queryByText('Jobs body')).toBeNull();
  });

  it('keeps an opted-in panel mounted and hides it with an inline display', () => {
    render(
      <Tabs
        value="a"
        onValueChange={vi.fn()}
        tabs={[
          { value: 'a', label: 'Overview' },
          { value: 'b', label: 'Jobs' },
        ]}
      >
        <TabPanel value="b" keepMounted>
          Jobs body
        </TabPanel>
      </Tabs>,
    );
    const panel = screen.getByText('Jobs body').closest('[role="tabpanel"]') as HTMLElement;
    // `hidden` is an attribute and loses to a utility class, so the inline style is the guard.
    expect(panel.hidden).toBe(true);
    expect(panel.style.display).toBe('none');
  });

  it('shows an opted-in panel while it is selected', () => {
    render(
      <Tabs value="b" onValueChange={vi.fn()} tabs={[{ value: 'b', label: 'Jobs' }]}>
        <TabPanel value="b" keepMounted>
          Jobs body
        </TabPanel>
      </Tabs>,
    );
    const panel = screen.getByRole('tabpanel');
    expect(panel.hidden).toBe(false);
    expect(panel.style.display).not.toBe('none');
  });
});
