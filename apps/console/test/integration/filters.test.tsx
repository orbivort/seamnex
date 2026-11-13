import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('server-driven list behaviour', () => {
  it('filters the catalog on the server and keeps the result count honest', async () => {
    openAs('R1', '/catalog');
    render(<App />);

    expect(await screen.findByText('EspoCRM')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Search catalog'), { target: { value: 'Zammad' } });

    await waitFor(() => expect(screen.queryByText('EspoCRM')).toBeNull());
    expect(await screen.findByText('Zammad')).toBeDefined();
    expect(await screen.findByText(/1 shown/)).toBeDefined();
  });

  it('filters the audit trail by actor on the server', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Audit trail' })).toBeDefined();
    await screen.findAllByText(/Sofia Almeida|Ruth Adler|Mara Vogel/);

    fireEvent.change(screen.getByLabelText('Actor', { exact: false }), {
      target: { value: 'Anja' },
    });

    // Scope to the table: the layout topbar legitimately shows the signed-in actor.
    await waitFor(() => {
      const table = screen.getByRole('table');
      expect(within(table).queryByText('Sofia Almeida')).toBeNull();
    });
    expect(within(screen.getByRole('table')).getAllByText('Anja Keller').length).toBeGreaterThan(0);
  });

  it('reports the loaded page against the server total for jobs', async () => {
    openAs('R1', '/jobs');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeDefined();
    expect(await screen.findByText(/\d+ of \d+ shown/)).toBeDefined();
  });

  it('filters the fleet by state without losing the empty-state guidance', async () => {
    openAs('R1', '/instances');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Instances' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /stopped/i }));

    await waitFor(() => expect(screen.getByText(/matching/i)).toBeDefined());
    expect(await screen.findByRole('heading', { name: 'Instances' })).toBeDefined();
  });
});
