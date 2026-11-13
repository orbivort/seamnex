import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { formatDate } from '@seamnex/utils';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * The registry is the machine-readable inventory the workflow builder consumes. Its filters run in
 * the browser over an already-loaded projection, so they must not lose the honesty of the counters
 * (`N shown`) or the empty-state guidance that tells an operator what to do next.
 */
describe('integration registry', () => {
  it('projects every deployed instance with its authentication class', async () => {
    openAs('R1', '/registry');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Integration registry' })).toBeDefined();
    const rows = getState().registry;
    expect(rows.length).toBeGreaterThan(0);
    const first = present(rows[0], 'a registry entry');
    expect(await screen.findByText(`${rows.length} entries`)).toBeDefined();
    expect(await screen.findByText(`${rows.length} shown`)).toBeDefined();
    expect(await screen.findByText(first.product)).toBeDefined();
  });

  it('searches by product, key and slug at once', async () => {
    openAs('R1', '/registry');
    render(<App />);
    await screen.findByRole('heading', { name: 'Integration registry' });

    const search = screen.getByLabelText('Search registry');
    const target = present(getState().registry[0], 'a registry entry');

    fireEvent.change(search, { target: { value: target.entryKey.toLowerCase() } });
    await waitFor(() => expect(screen.getByText('1 shown')).toBeDefined());
    expect(screen.getByText(target.product)).toBeDefined();

    fireEvent.change(search, { target: { value: target.slug } });
    await waitFor(() => expect(screen.getByText('1 shown')).toBeDefined());

    // A partial key has to match the way a partial product name does; the key used to be compared
    // exactly, so half of the identifier printed in the first column returned nothing.
    fireEvent.change(search, {
      target: { value: target.entryKey.slice(0, 3).toLowerCase() },
    });
    await waitFor(() => expect(screen.getByText('1 shown')).toBeDefined());

    // The address printed under the product name is on the screen, so it must be searchable.
    fireEvent.change(search, { target: { value: target.route } });
    await waitFor(() => expect(screen.getByText('1 shown')).toBeDefined());

    fireEvent.change(search, { target: { value: 'nothing-matches-this' } });
    expect(await screen.findByText('No registry entry matches')).toBeDefined();
    expect(screen.getByText('0 shown')).toBeDefined();
  });

  it('filters to stale metadata without hiding the total', async () => {
    openAs('R1', '/registry');
    render(<App />);
    await screen.findByRole('heading', { name: 'Integration registry' });

    const stale = getState().registry.filter((entry) => entry.stale).length;
    const chip = screen.getByRole('button', { name: 'Stale only' });

    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByText(`${stale} shown`)).toBeDefined());

    fireEvent.click(chip);
    await waitFor(() =>
      expect(screen.getByText(`${getState().registry.length} shown`)).toBeDefined(),
    );
  });

  it('reports the write posture in three states rather than two', async () => {
    openAs('R1', '/registry');
    render(<App />);
    await screen.findByRole('heading', { name: 'Integration registry' });

    const rows = getState().registry;
    const writable = rows.filter((row) => row.writeEligible).length;
    const readOnly = rows.filter((row) => !row.writeEligible && row.workflowEligible).length;
    const none = rows.filter((row) => !row.workflowEligible).length;

    expect(await screen.findAllByText('eligible')).toHaveLength(writable);
    expect(screen.getAllByText('read-only')).toHaveLength(readOnly);
    expect(screen.getAllByText('no credential')).toHaveLength(none);
  });

  it('reports stale metadata as a badge', async () => {
    openAs('R1', '/registry');
    render(<App />);
    await screen.findByRole('heading', { name: 'Integration registry' });

    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1));
    const stale = getState().registry.filter((entry) => entry.stale).length;
    expect(within(table).getAllByText('stale')).toHaveLength(stale);
  });

  it('keeps the verification date next to a stale badge', async () => {
    // The badge replaced the date, so a stale row said "stale" without saying how old the facts
    // were — the one number a reviewer needs to decide what to re-verify.
    const target = present(getState().registry[0], 'a registry entry');
    const verifiedAt = '2025-01-15T00:00:00.000Z';
    target.stale = true;
    target.verifiedAt = verifiedAt;
    const stale = getState().registry.filter((entry) => entry.stale).length;

    openAs('R1', '/registry');
    render(<App />);
    const table = await screen.findByRole('table');

    await waitFor(() => expect(within(table).getAllByText('stale')).toHaveLength(stale));
    expect(within(table).getByText(formatDate(verifiedAt))).toBeDefined();
  });

  it('renders an unreachable registry as an error with a retry, not an empty register', async () => {
    server.use(http.get('/api/v1/registry/instances', () => HttpResponse.error()));

    openAs('R1', '/registry');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
    expect(screen.queryByText('No registry entry matches')).toBeNull();
  });

  it('keeps an empty registry honest about what the list means', async () => {
    getState().registry = [];

    openAs('R1', '/registry');
    render(<App />);

    expect(await screen.findByText('No registry entry matches')).toBeDefined();
    expect(screen.getByText('0 entries')).toBeDefined();
  });

  it('hides the registry from a role without registry.view', async () => {
    openAs('R5', '/registry');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });
});
