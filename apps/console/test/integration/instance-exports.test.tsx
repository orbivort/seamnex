import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstanceExport } from '@seamnex/domain';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * FR-1.13 / AC-20 — the Exports tab.
 *
 * The tab is the only place an operator can take the archive away, so what it renders has to match
 * the artefact: what it contains, what it leaves out, and a filename the server chose. It is also
 * gated by `instance.lifecycle` (R1-only), the same capability that creates the archive — a domain
 * owner must not see a control that is a guaranteed refusal.
 */
async function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
  return screen.findByRole('tabpanel');
}

/**
 * jsdom does not implement object URLs, and replacing the whole `URL` global breaks the router —
 * only the two methods the save helper touches are stubbed, and they are put back afterwards.
 */
const originalObjectUrl = {
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
};

afterEach(() => {
  URL.createObjectURL = originalObjectUrl.create;
  URL.revokeObjectURL = originalObjectUrl.revoke;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the exports tab', () => {
  it('lists the archives with what each one holds and what it leaves out', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Exports');

    expect(await within(panel).findByText('Data export')).toBeDefined();
    // Contents come from the capture, not from the button that produced them.
    expect((await within(panel).findAllByText('database')).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('volumes').length).toBeGreaterThan(0);
    // Secrets are named as absent rather than silently missing.
    expect(within(panel).getAllByText(/secrets/).length).toBeGreaterThan(0);
    expect(within(panel).getAllByRole('button', { name: 'Download' }).length).toBeGreaterThan(0);
    // The one thing a plaintext dataset must never claim to be.
    expect(
      within(panel).getAllByText(/unencrypted|not pruned automatically/).length,
    ).toBeGreaterThan(0);
  });

  it('is not offered to a role that may not export', async () => {
    openAs('R2', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    expect(screen.queryByRole('tab', { name: 'Exports' })).toBeNull();
  });

  /**
   * The capture computes `includes` from what it actually wrote, so an empty list is a real answer —
   * the screen must say "nothing captured" rather than render an empty cell a reader fills in.
   */
  it('names an archive that captured nothing, and one that left nothing out', async () => {
    const barren: InstanceExport = {
      exportId: '20261116T103100Z-1a2b3c4d',
      exportedAt: new Date().toISOString(),
      fileName: '20261116T103100Z-1a2b3c4d.tar.gz',
      bytes: 0,
      sha256: 'a'.repeat(64),
      includes: [],
      excluded: [],
      renderSetId: null,
    };
    server.use(http.get('/api/v1/instances/:id/exports', () => HttpResponse.json([barren])));
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Exports');

    expect(await within(panel).findByText('nothing captured')).toBeDefined();
    // Nothing omitted: an em dash, not a blank column.
    expect(within(panel).getByText('—')).toBeDefined();
  });

  it('explains an instance with no export yet instead of rendering an empty table', async () => {
    server.use(http.get('/api/v1/instances/:id/exports', () => HttpResponse.json([])));
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Exports');

    expect(await within(panel).findByText('No export yet')).toBeDefined();
  });

  it('reports an export list the server refused, with a retry', async () => {
    server.use(
      http.get('/api/v1/instances/:id/exports', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/internal',
            title: 'The export list could not be read',
            status: 500,
            detail: 'The exports directory is not readable.',
            code: 'INTERNAL_ERROR',
            fieldErrors: [],
            remediation: 'Check the instance data directory, then retry.',
          },
          { status: 500 },
        ),
      ),
    );
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Exports');

    expect(await within(panel).findByText('The export list could not be read')).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('reports a download that fails without saving a file under a plausible name', async () => {
    const createObjectURL = vi.fn(() => 'blob:export');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    server.use(
      http.get('/api/v1/instances/:id/exports/:exportId/archive', () => HttpResponse.error()),
    );
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Exports');
    const downloads = await within(panel).findAllByRole('button', { name: 'Download' });
    fireEvent.click(downloads[0] ?? panel);

    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('saves the archive under the filename the server sends', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:export');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    let saved: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved = this.download;
    });

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Exports');
    // The seeded instance has more than one archive; the first row is enough to prove the path.
    const downloads = await within(panel).findAllByRole('button', { name: 'Download' });
    fireEvent.click(downloads[0] ?? panel);

    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(saved).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}\.tar\.gz$/);
    });
  });
});
