import { fireEvent, render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { admissionVerdict } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The capacity board's unhappy shapes: a host that cannot admit another deployment, a snapshot
 * taken before the guard measured memory and disk, and a forecast read that failed.
 *
 * Why these cases matter: the board is read before a deployment starts. A shortfall rendered as
 * "admissible", or a missing measurement rendered as a zero, is the mistake that gets a deploy
 * approved twice; the copy for each branch is what tells the operator which situation they are in.
 */

function problemResponse(status: number, title: string, detail: string, code = 'INTERNAL') {
  return HttpResponse.json(
    {
      type: 'https://platform.seamnex.local/problems/unavailable',
      title,
      status,
      detail,
      code,
      fieldErrors: [],
      remediation: 'Retry. If the API stays slow, check the control-plane health page.',
    },
    { status },
  );
}

describe('capacity shortfall', () => {
  it('reports a host that cannot admit another deployment as a shortfall', async () => {
    const snapshot = getState().capacity;
    // The same request shape the API judges with, so the badge and the rulers cannot disagree.
    const requested = { cpu: 40, memoryMb: 120_000, diskMb: 2_000_000 };
    const allocated = {
      cpuCores: requested.cpu,
      memoryMb: requested.memoryMb,
      diskMb: requested.diskMb,
    };
    const verdict = admissionVerdict({
      host: {
        cpu: snapshot.host.cpuCores,
        memoryMb: snapshot.host.memoryMb,
        diskMb: snapshot.host.diskMb,
      },
      reserve: {
        cpu: snapshot.platformReserve.cpuCores,
        memoryMb: snapshot.platformReserve.memoryMb,
        diskMb: snapshot.platformReserve.diskMb,
      },
      allocated: requested,
      request: { cpu: 0, memoryMb: 0, diskMb: 0 },
      oversubscriptionFactor: snapshot.oversubscriptionFactor,
    });
    expect(verdict.admissible).toBe(false);

    server.use(
      http.get('/api/v1/capacity', () =>
        HttpResponse.json({
          ...snapshot,
          allocated,
          verdict: {
            admissible: verdict.admissible,
            headline: verdict.headline,
            detail: verdict.detail,
            shortfall: verdict.shortfall,
            reserveNote: verdict.reserveNote,
          },
        }),
      ),
    );

    openAs('R1', '/capacity');
    render(<App />);

    // "shortfall", never "admissible": the two words are the whole verdict.
    expect(await screen.findByText('shortfall')).toBeDefined();
    expect(await screen.findByText(verdict.headline)).toBeDefined();
  });
});

describe('capacity snapshot without live measurements', () => {
  it('drops the free figures when the snapshot measured none, keeping the totals', async () => {
    const snapshot = getState().capacity;
    server.use(
      http.get('/api/v1/capacity', () =>
        HttpResponse.json({
          ...snapshot,
          memoryAvailableMb: undefined,
          diskAvailableMb: undefined,
        }),
      ),
    );

    openAs('R1', '/capacity');
    render(<App />);

    // The reservation is a fact about the platform; free space is a sample that an older snapshot
    // does not carry. Printing "0.0 GB free" for the missing one would be a false measurement.
    expect(await screen.findByText('10.0 GB reserved')).toBeDefined();
    expect(screen.getByText('100.0 GB reserved')).toBeDefined();
    expect(screen.queryByText(/GB free$/)).toBeNull();

    // The admission callout still names the filesystem, without inventing a free-space figure.
    expect(screen.getByText(/Disk measured on \/var\/lib\/seamnex\/instances/)).toBeDefined();
    expect(screen.queryByText(/GB free of/)).toBeNull();
  });

  it('omits the filesystem note when the snapshot does not record where disk was measured', async () => {
    const snapshot = getState().capacity;
    server.use(
      http.get('/api/v1/capacity', () => HttpResponse.json({ ...snapshot, diskPath: undefined })),
    );

    openAs('R1', '/capacity');
    render(<App />);

    // Without a measured path there is no claim to make about the disk axis.
    expect(await screen.findByText('Allocation ledger')).toBeDefined();
    expect(screen.queryByText(/Disk measured on/)).toBeNull();
    expect(screen.getByText(snapshot.verdict.headline)).toBeDefined();
  });
});

describe('capacity forecast', () => {
  it('reports a forecast that cannot be read and draws it when the operator retries', async () => {
    // A failed forecast must not replace the snapshot it is drawn beside, so it is retried in
    // place rather than reloading the page.
    let failing = true;
    server.use(
      http.get('/api/v1/capacity/forecast', () =>
        failing
          ? problemResponse(
              503,
              'The capacity forecast could not be projected',
              'The forecast worker is restarting.',
            )
          : HttpResponse.json(getState().capacity.forecast),
      ),
    );

    openAs('R1', '/capacity');
    render(<App />);

    expect(await screen.findByText('The capacity forecast could not be projected')).toBeDefined();
    // The snapshot is still on screen beside the failed outlook.
    expect(screen.getByText('Allocation ledger')).toBeDefined();

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(/Forecast is a planning aid, not a reservation/)).toBeDefined();
  });
});
