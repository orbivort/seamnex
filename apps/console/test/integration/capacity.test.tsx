import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The capacity board is the screen an operator opens before a deployment, so its rulers have to
 * read on the same scale as the verdict above them: allocation plus the platform reserve, against
 * the admission limit the API judged with.
 */
describe('capacity board', () => {
  it('draws the rulers on the admission limits, not on allocation versus host minus reserve', async () => {
    openAs('R1', '/capacity');
    render(<App />);

    // 14.5 vCPU allocated plus the 4 vCPU reserve, against 16 vCPU × 1.25 oversubscription.
    expect(await screen.findByText('18.5 / 20.0 vCPU')).toBeDefined();
    expect(screen.queryByText('14.5 / 12.0 vCPU')).toBeNull();
    // 33 GB allocated + 10 GB reserve of 0.95 × 64 GB, and 580 GB + 100 GB of 0.9 × 1 TB.
    expect(await screen.findByText('43.0 / 60.8 GB')).toBeDefined();
    expect(await screen.findByText('680.0 / 921.6 GB')).toBeDefined();
  });

  it('reports the measured pool as capacity, with free space as the secondary figure', async () => {
    openAs('R1', '/capacity');
    render(<App />);

    // Host disk is the filesystem's capacity (1 TiB), not what happens to be free on it.
    expect(await screen.findByText('1024.0 GB')).toBeDefined();
    expect(await screen.findByText('100.0 GB reserved · 444.0 GB free')).toBeDefined();
    // And the board names the filesystem it judged, so a reader can verify the number.
    expect(screen.getByText(/Disk measured on \/var\/lib\/seamnex\/instances/)).toBeDefined();
  });

  it('reports an unreadable capacity read as unavailable, not as a shortfall', async () => {
    server.use(http.get('/api/v1/capacity', () => HttpResponse.error()));

    openAs('R1', '/capacity');
    render(<App />);

    expect(await screen.findByText('capacity unavailable')).toBeDefined();
    expect(screen.queryByText('shortfall')).toBeNull();
  });
});
