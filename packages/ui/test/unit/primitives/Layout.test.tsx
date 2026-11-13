import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Grid, Page, SearchField, SplitLayout } from '../../../src/primitives/Layout';

/**
 * The layout policy. Each primitive replaces a class string that sixteen screens used to retype,
 * so the point of a test is that the decision is *here*: the ratio names, the column ladder and
 * the search field's single width policy.
 */
describe('Page', () => {
  it('is a div with entry motion by default', () => {
    const { container } = render(<Page>content</Page>);
    const page = container.firstElementChild as HTMLElement;
    expect(page.tagName).toBe('DIV');
    expect(page.className).toContain('motion-safe:animate-fade');
  });

  it('can be a section, and takes a caller class', () => {
    const { container } = render(
      <Page as="section" className="extra-marker">
        content
      </Page>,
    );
    expect(container.firstElementChild?.tagName).toBe('SECTION');
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
  });
});

describe('Grid', () => {
  it('defaults to two columns with a medium gap', () => {
    const { container } = render(<Grid>cards</Grid>);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid');
    expect(grid.className).toContain('sm:grid-cols-2');
    expect(grid.className).toContain('gap-3');
  });

  it('steps up the column ladder', () => {
    const { container, rerender } = render(<Grid cols={1}>cards</Grid>);
    expect((container.firstElementChild as HTMLElement).className).toContain('grid-cols-1');

    rerender(<Grid cols={3}>cards</Grid>);
    expect((container.firstElementChild as HTMLElement).className).toContain('xl:grid-cols-3');

    rerender(<Grid cols={4}>cards</Grid>);
    expect((container.firstElementChild as HTMLElement).className).toContain('xl:grid-cols-4');
  });

  it('steps through the gap scale and keeps a caller class', () => {
    const { container, rerender } = render(
      <Grid gap="sm" className="extra-marker">
        cards
      </Grid>,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('gap-2');
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');

    rerender(<Grid gap="lg">cards</Grid>);
    expect((container.firstElementChild as HTMLElement).className).toContain('gap-4');
  });
});

describe('SplitLayout', () => {
  it('defaults to a dominant content column', () => {
    const { container } = render(<SplitLayout>columns</SplitLayout>);
    const split = container.firstElementChild as HTMLElement;
    expect(split.tagName).toBe('DIV');
    expect(split.className).toContain('lg:grid-cols-[1.5fr_1fr]');
  });

  it('names the other two ratios', () => {
    const { container, rerender } = render(<SplitLayout ratio="even">columns</SplitLayout>);
    expect((container.firstElementChild as HTMLElement).className).toContain('lg:grid-cols-2');

    rerender(<SplitLayout ratio="rail">columns</SplitLayout>);
    expect((container.firstElementChild as HTMLElement).className).toContain(
      'lg:grid-cols-[1fr_22rem]',
    );
  });

  it('can be a section, and takes a caller class', () => {
    const { container } = render(
      <SplitLayout as="section" className="extra-marker">
        columns
      </SplitLayout>,
    );
    expect(container.firstElementChild?.tagName).toBe('SECTION');
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
  });
});

describe('SearchField', () => {
  it('is one labelled search input with the shared icon', () => {
    const { container } = render(
      <SearchField
        value=""
        onValueChange={vi.fn()}
        label="Search instances"
        placeholder="Name or id"
        className="extra-marker"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Search instances' });
    expect(input.getAttribute('placeholder')).toBe('Name or id');
    expect(input.className).toContain('pl-8');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
  });

  it('reports every keystroke', () => {
    const onValueChange = vi.fn();
    render(
      <SearchField value="" onValueChange={onValueChange} label="Search" placeholder="Find" />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cr' } });
    expect(onValueChange).toHaveBeenCalledWith('cr');
  });
});
