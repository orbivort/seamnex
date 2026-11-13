import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar, FilterChip } from '../../../src/patterns/FilterBar';

/**
 * One toolbar for every list screen — which is the point: the search field, the filter row and
 * the result count are one layout, and a screen cannot re-invent a 200px versus 220px field.
 */
describe('FilterBar', () => {
  it('renders the shared search field with the caller label and placeholder', () => {
    render(
      <FilterBar
        search=""
        onSearch={vi.fn()}
        searchLabel="Search instances"
        placeholder="Name or id"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Search instances' });
    expect(input.getAttribute('placeholder')).toBe('Name or id');
  });

  it('reports every keystroke', () => {
    const onSearch = vi.fn();
    render(<FilterBar search="" onSearch={onSearch} searchLabel="Search" placeholder="Find" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'crm' } });
    expect(onSearch).toHaveBeenCalledWith('crm');
  });

  it('renders the filter controls and the trailing count when supplied', () => {
    render(
      <FilterBar
        search=""
        onSearch={vi.fn()}
        searchLabel="Search"
        placeholder="Find"
        className="extra-marker"
        trailing="12 results"
      >
        <button type="button">Healthy only</button>
      </FilterBar>,
    );
    expect(screen.getByRole('button', { name: 'Healthy only' })).toBeDefined();
    expect(screen.getByText('12 results').className).toContain('ml-auto');
    const bar = screen.getByRole('textbox').closest('div')?.parentElement as HTMLElement;
    expect(bar.className).toContain('extra-marker');
  });

  it('leaves both optional slots out when there is nothing to put in them', () => {
    const { container } = render(
      <FilterBar search="" onSearch={vi.fn()} searchLabel="Search" placeholder="Find" />,
    );
    const bar = container.firstElementChild as HTMLElement;
    // One child: the search field wrapper.
    expect(bar.children).toHaveLength(1);
  });
});

describe('FilterChip', () => {
  it('is a toggle button that reports its pressed state', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <FilterChip active onClick={onClick}>
        Healthy
      </FilterChip>,
    );
    const chip = screen.getByRole('button', { name: 'Healthy' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.className).toContain('bg-primary-soft');

    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <FilterChip active={false} onClick={onClick}>
        Healthy
      </FilterChip>,
    );
    const off = screen.getByRole('button', { name: 'Healthy' });
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(off.className).toContain('bg-panel');
  });
});
