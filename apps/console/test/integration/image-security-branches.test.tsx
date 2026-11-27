import { fireEvent, render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * NFR-4.6 / S-10 — the states the happy path does not reach.
 *
 * The tab exists to keep four answers apart, so the branches below are exactly the ones that would
 * collapse them: no image recorded, an image with no retained report, a scan that could not finish,
 * and a report that holds counts but no individual findings. Each is asserted on its own copy rather
 * than on the absence of an error.
 */
const digest = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;

const IMAGE = {
  digest: digest('a'),
  version: '31.0.2',
  state: 'current',
  builtAt: '2026-10-20T09:00:00.000Z',
  artefact: 'not-applicable',
};

async function tabPanel(): Promise<HTMLElement> {
  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Image security' }));
  const heading = await screen.findByRole('heading', { name: 'Image security' });
  const section = heading.closest('section');
  if (section === null) throw new Error('the security tab is not in a panel');
  return section;
}

describe('image security tab branches', () => {
  it('says nothing has been recorded when the instance has no image', async () => {
    server.use(http.get('/api/v1/instances/:id/images', () => HttpResponse.json([])));

    openAs('R1', '/instances/inst-collab');
    render(<App />);

    const panel = await tabPanel();
    expect(
      await within(panel).findByText('No image has been recorded for this instance'),
    ).toBeDefined();
  });

  it('renders an unscanned image as never scanned, with no findings to open', async () => {
    server.use(
      http.get('/api/v1/instances/:id/images', () => HttpResponse.json([{ ...IMAGE, scan: null }])),
    );

    openAs('R1', '/instances/inst-collab');
    render(<App />);

    const panel = await tabPanel();
    expect(await within(panel).findByText('never scanned')).toBeDefined();
    expect(
      within(panel).getByText(/Never scanned: no report is retained for this digest/),
    ).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'No report' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('renders a scanner that could not finish as a caution, not as a pass', async () => {
    server.use(
      http.get('/api/v1/instances/:id/images', () =>
        HttpResponse.json([
          {
            ...IMAGE,
            scan: {
              verdict: 'error',
              scanner: 'aquasec/trivy',
              scannerVersion: '0.58.0',
              scannedAt: '2026-11-01T10:00:00.000Z',
              severityCounts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
              blockingSeverities: ['critical'],
            },
          },
        ]),
      ),
    );

    openAs('R1', '/instances/inst-collab');
    render(<App />);

    const panel = await tabPanel();
    expect(await within(panel).findByText('scan failed')).toBeDefined();
    expect(within(panel).queryByText('passed')).toBeNull();
  });

  it('explains a retained report that holds counts but no individual findings', async () => {
    server.use(
      http.get('/api/v1/instances/:id/images', () =>
        HttpResponse.json([
          {
            ...IMAGE,
            scan: {
              verdict: 'passed',
              scanner: 'aquasec/trivy',
              scannerVersion: '0.58.0',
              scannedAt: '2026-11-01T10:00:00.000Z',
              severityCounts: { critical: 0, high: 1, medium: 2, low: 3, unknown: 0 },
              blockingSeverities: ['critical'],
            },
          },
        ]),
      ),
      http.get('/api/v1/instances/:id/image-scan', () =>
        HttpResponse.json({
          instanceId: 'inst-collab',
          imageRef: 'nextcloud:31.0.2-apache',
          imageDigest: IMAGE.digest,
          verdict: 'passed',
          scanner: 'aquasec/trivy',
          scannerVersion: '0.58.0',
          scannedAt: '2026-11-01T10:00:00.000Z',
          severityCounts: { critical: 0, high: 1, medium: 2, low: 3, unknown: 0 },
          blockingSeverities: ['critical'],
          findings: [],
          reportKey: null,
        }),
      ),
    );

    openAs('R1', '/instances/inst-collab');
    render(<App />);

    const panel = await tabPanel();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Findings' }));

    expect(
      await screen.findByText(/The retained report holds no individual findings/),
    ).toBeDefined();
    // A passed image carries no blocking callout.
    expect(screen.queryByText(/This image blocked a deployment/)).toBeNull();
  });
});
