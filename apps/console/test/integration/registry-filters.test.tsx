import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * FR-2.10 — the registry's headline is its primary filter.
 *
 * The three posture tiles (C-11 has three outcomes, not two) and the search box all narrow the same
 * table, and the empty state offers a way back out. A filter that cannot be cleared from the screen
 * that claims to be filtering is the failure this file guards against.
 */
async function openRegistry() {
  openAs('R1', '/registry');
  render(<App />);
  await screen.findByRole('heading', { name: 'Integration registry' });
  const rows = getState().registry;
  await screen.findByText(`${rows.length} shown`);
  return rows;
}

describe('registry posture tiles', () => {
  it('filters to the writable rows and back to the whole register on a second press', async () => {
    const rows = await openRegistry();
    const writable = rows.filter((entry) => entry.writeEligible).length;
    const tile = screen.getByRole('button', { name: /^Writable/ });
    expect(tile.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(tile);
    await waitFor(() => expect(screen.getByText(`${writable} shown`)).toBeDefined());
    expect(screen.getByRole('button', { name: /^Writable/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    // The pressed tile is the filter; pressing it again restores the register.
    fireEvent.click(screen.getByRole('button', { name: /^Writable/ }));
    await waitFor(() => expect(screen.getByText(`${rows.length} shown`)).toBeDefined());
  });

  it('counts each posture state over the whole register, not the filtered rows', async () => {
    const rows = await openRegistry();

    for (const [label, predicate] of [
      ['Writable', (entry: (typeof rows)[number]) => entry.writeEligible],
      [
        'Read-only',
        (entry: (typeof rows)[number]) => !entry.writeEligible && entry.workflowEligible,
      ],
      ['No credential', (entry: (typeof rows)[number]) => !entry.workflowEligible],
    ] as const) {
      const count = rows.filter(predicate).length;
      const tile = screen.getByRole('button', { name: new RegExp(`^${label}`) });
      expect(tile.textContent).toContain(String(count));
    }
  });
});

describe('registry empty state', () => {
  it('clears the search, the stale chip and the posture tile in one action', async () => {
    const rows = await openRegistry();

    fireEvent.click(screen.getByRole('button', { name: 'Stale only' }));
    fireEvent.click(screen.getByRole('button', { name: /^Read-only/ }));
    fireEvent.change(screen.getByLabelText('Search registry'), {
      target: { value: 'nothing-matches-this' },
    });

    expect(await screen.findByText('No registry entry matches')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));

    await waitFor(() => expect(screen.getByText(`${rows.length} shown`)).toBeDefined());
    expect(screen.getByLabelText('Search registry')).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Stale only' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: /^Read-only/ }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});

describe('registry route projection', () => {
  it('prints a bare host that is not a URL as-is instead of dropping the cell', async () => {
    // `registry-feed` stores `host`, the demo fixtures store `https://host/`; both have to read as
    // an address rather than as `undefined`.
    const entry = present(getState().registry[0], 'a registry entry');
    entry.route = 'registry-feed';

    await openRegistry();
    expect(await screen.findByText('registry-feed')).toBeDefined();
  });
});
