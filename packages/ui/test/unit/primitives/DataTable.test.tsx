import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DataTable,
  KeyValueRows,
  TableToolbar,
  defineColumns,
  type Column,
} from '../../../src/primitives/DataTable';

type Row = { id: string; name: string; state: 'up' | 'down' };

const columns: Column<Row>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.name, primary: true },
  { id: 'state', header: 'State', cell: (row) => row.state, align: 'right', mono: true },
];

const rows: Row[] = [
  { id: 'a', name: 'alpha', state: 'up' },
  { id: 'b', name: 'beta', state: 'down' },
];

/**
 * The table is the one primitive with real behaviour in it: an optional row link must be the
 * only keyboard stop, a click on that link must not also activate the row, and every visual
 * column option has to land on both the header and the cell.
 */
describe('DataTable', () => {
  it('replaces the whole table with the empty slot when there are no rows', () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        empty={<p>Nothing here</p>}
        className="extra-marker"
      />,
    );
    expect(screen.getByText('Nothing here')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Nothing here').parentElement?.className).toContain('extra-marker');
  });

  it('still renders the header when there are no rows and no empty slot', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(row) => row.id} />);
    expect(screen.getByRole('table')).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeDefined();
    expect(screen.getAllByRole('row')).toHaveLength(1);
  });

  it('renders a caption and maps every row through its columns', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        caption="Instances in eu-west-1"
        className="extra-marker"
      />,
    );
    expect(screen.getByText('Instances in eu-west-1').tagName).toBe('CAPTION');
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('beta')).toBeDefined();
    expect(screen.getByRole('table').parentElement?.className).toContain('extra-marker');
  });

  it('applies width, alignment, mono and the hide-below breakpoint', () => {
    const wide: Column<Row>[] = [
      {
        id: 'name',
        header: 'Name',
        cell: (row) => row.name,
        width: '12rem',
        align: 'center',
        hideBelow: 'lg',
      },
      {
        id: 'state',
        header: 'State',
        cell: (row) => row.state,
        align: 'right',
        mono: true,
        hideBelow: 'xl',
      },
      { id: 'id', header: 'Id', cell: (row) => row.id, hideBelow: 'sm' },
      { id: 'alt', header: 'Alt', cell: (row) => row.id, hideBelow: 'md' },
    ];
    render(<DataTable columns={wide} rows={[rows[0] as Row]} rowKey={(row) => row.id} />);

    const nameHeader = screen.getByRole('columnheader', { name: 'Name' });
    expect(nameHeader.style.width).toBe('12rem');
    expect(nameHeader.className).toContain('text-center');
    expect(nameHeader.className).toContain('hidden lg:table-cell');
    expect(screen.getByRole('columnheader', { name: 'State' }).className).toContain(
      'hidden xl:table-cell',
    );
    expect(screen.getByRole('columnheader', { name: 'Id' }).className).toContain(
      'hidden sm:table-cell',
    );
    expect(screen.getByRole('columnheader', { name: 'Alt' }).className).toContain(
      'hidden md:table-cell',
    );
    // The mono flag lands on the cell, not on the header.
    expect(screen.getByText('up').className).toContain('font-mono');
    expect(screen.getByText('up').className).toContain('text-right');
  });

  it('defaults to the comfortable row padding and left alignment', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />);
    const header = screen.getByRole('columnheader', { name: 'Name' });
    expect(header.className).toContain('py-2.5');
    expect(header.className).toContain('text-left');
    expect(header.style.width).toBe('');
  });

  it('tightens the padding in the dense variant', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} dense />);
    expect(screen.getByRole('columnheader', { name: 'Name' }).className).toContain('py-1.5');
    expect(screen.getByText('alpha').className).toContain('py-1.5');
  });

  it('activates a row on click when a handler is supplied', () => {
    const onRowActivate = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        onRowActivate={onRowActivate}
      />,
    );
    fireEvent.click(screen.getByText('alpha'));

    expect(onRowActivate).toHaveBeenCalledWith(rows[0]);
    expect(screen.getAllByRole('row')[1]?.className).toContain('cursor-pointer');
  });

  it('defers to a handler-less row', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />);
    fireEvent.click(screen.getByText('alpha'));
    expect(screen.getAllByRole('row')[1]?.className).not.toContain('cursor-pointer');
  });

  it('renders the primary cell through the row-link recipe', () => {
    const renderRowLink = vi.fn((row: Row, className: string, children: React.ReactNode) => (
      <a href={`#${row.id}`} className={className} data-testid={`link-${row.id}`}>
        {children}
      </a>
    ));
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        renderRowLink={renderRowLink}
      />,
    );

    const link = screen.getByTestId('link-a');
    expect(link.className).toContain('hover:text-link');
    expect(link.textContent).toBe('alpha');
    expect(renderRowLink).toHaveBeenCalledTimes(rows.length);
    // The secondary cell keeps whatever the column defines.
    expect(screen.getByText('up').tagName).toBe('TD');
  });

  it('does not activate the row when the click came from inside the row link', () => {
    const onRowActivate = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        onRowActivate={onRowActivate}
        renderRowLink={(row, className, children) => (
          <a href={`#${row.id}`} className={className}>
            {children}
          </a>
        )}
      />,
    );
    fireEvent.click(screen.getByText('alpha'));

    // One history entry per row: the link already navigates.
    expect(onRowActivate).not.toHaveBeenCalled();
  });

  it('paints the row tone and honours the selected key', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        selectedKey="b"
        rowTone={(row) => (row.state === 'up' ? 'danger' : 'default')}
      />,
    );
    const [first, second] = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(first?.className).toContain('bg-danger-wash');
    // Selection outranks the tone wash, so the selected row keeps only its selection fill.
    expect(second?.className).toContain('bg-primary-soft/80');
    expect(second?.getAttribute('aria-current')).toBe('true');
    expect(second?.getAttribute('data-selected')).toBe('true');
    expect(first?.getAttribute('aria-current')).toBeNull();
    expect(first?.hasAttribute('data-selected')).toBe(false);
  });
});

describe('defineColumns', () => {
  it('is an identity that names the convention', () => {
    const defined = defineColumns(columns);
    expect(defined).toBe(columns);
  });
});

describe('TableToolbar', () => {
  it('renders its actions and an optional trailing group', () => {
    const { container, rerender } = render(
      <TableToolbar className="extra-marker">
        <button type="button">Filter</button>
      </TableToolbar>,
    );
    expect(screen.getByRole('button', { name: 'Filter' })).toBeDefined();
    const toolbar = container.firstElementChild as HTMLElement;
    expect(toolbar.className).toContain('extra-marker');
    // One child: the group of actions. No trailing slot was supplied.
    expect(toolbar.children).toHaveLength(1);

    rerender(
      <TableToolbar end={<span>12 rows</span>}>
        <button type="button">Filter</button>
      </TableToolbar>,
    );
    expect(screen.getByText('12 rows')).toBeDefined();
  });
});

describe('KeyValueRows', () => {
  it('renders a leader row per entry', () => {
    const { container } = render(
      <KeyValueRows
        className="extra-marker"
        rows={[
          { key: 'a', label: 'Owner', value: 'platform' },
          { key: 'b', label: 'Team', value: 'core' },
        ]}
      />,
    );
    expect(container.querySelector('dl')?.className).toContain('extra-marker');
    expect(container.querySelectorAll('dt')).toHaveLength(2);
    expect(screen.getByText('Owner').tagName).toBe('DT');
    expect(screen.getByText('platform').tagName).toBe('DD');
    expect(screen.getByText('platform').className).toContain('text-right');
  });
});
