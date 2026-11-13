import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * FR-1.28: "requires recreate" is only real if the stored change can be applied. The mock handler's
 * allow-list omitted `reconfigure`, so the demo build answered 404 for a Must action the console
 * offered and the executor implements — a demonstration that contradicted the product.
 */
describe('reconfigure lifecycle action', () => {
  it('is accepted by the mock lifecycle endpoint and queued as a job', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reconfigure' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reconfigure' }));

    expect(await screen.findByText(/Reconfigure · job-/i)).toBeDefined();
  });
});
