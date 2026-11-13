import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('access request queue (FR-3.13)', () => {
  it('opens on the requests still waiting for a decision', async () => {
    openAs('R1', '/governance/access-requests');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Access requests' })).toBeDefined();
    expect(await screen.findByText('Lena Hoff')).toBeDefined();
    // A decided request is not in the default scope; it is reachable from the All chip.
    expect(screen.queryByText('Iris Nwosu')).toBeNull();
  });

  it('names the requester in the decision control, not the row', async () => {
    openAs('R1', '/governance/access-requests');
    render(<App />);

    expect(
      await screen.findByRole('button', { name: /Approve request \S+ from Lena Hoff/i }),
    ).toBeDefined();
  });

  it('asks before it decides, then records the decision', async () => {
    openAs('R1', '/governance/access-requests');
    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Approve request \S+ from Lena Hoff/i }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Approving grants the requested access now/i)).toBeDefined();
    // Opening the dialog decides nothing: the row is still open behind it.
    expect(screen.getByText('Open')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and grant' }));

    // The approved row leaves the open scope and reports who decided it.
    expect(await screen.findByText(/Nothing is waiting for a decision/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    const row = (await screen.findByText('Lena Hoff')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Sofia Almeida')).toBeDefined();
    expect(within(row as HTMLElement).getByText('Approved')).toBeDefined();
  });

  it('narrows the queue by search', async () => {
    openAs('R1', '/governance/access-requests');
    render(<App />);

    await screen.findByText('Lena Hoff');
    fireEvent.change(screen.getByLabelText(/Search access requests/i), {
      target: { value: 'paperless' },
    });

    expect(screen.getByText('Lena Hoff')).toBeDefined();
    expect(screen.queryByText('Iris Nwosu')).toBeNull();
  });
});
