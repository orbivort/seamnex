import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { findEntry, getState, scaffoldFor } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The branches the happy path never reaches: filter combinations, a partial repository reload,
 * an entry that cannot be re-read, and the empty, stale and ineligible shapes of the tabs.
 *
 * Why these cases matter: the catalog is the declarative source of truth. A receipt that hides a
 * refused environment file, or a detail screen that paints a refused read as "nothing here", is
 * exactly the failure the screen exists to prevent — so each branch below is asserted on its copy,
 * not only on the number beside it.
 */

/** A refused read/write in the shape the API sends (`application/problem+json`). */
function problemResponse(status: number, title: string, detail: string, code = 'FORBIDDEN') {
  return HttpResponse.json(
    {
      type: 'https://platform.seamnex.local/problems/refused',
      title,
      status,
      detail,
      code,
      fieldErrors: [],
      remediation: 'Ask the platform administrator.',
    },
    { status },
  );
}

/**
 * The fixture entry, or a failure that names the missing fixture. Spreading a possibly-absent
 * entry would send `{}` to the screen and turn a fixture mistake into a confusing DOM assertion.
 */
function entryFor(key: string) {
  const entry = findEntry(key);
  if (entry === undefined) throw new Error(`the mock platform has no catalog entry ${key}`);
  return entry;
}

/** Radix activates a tab on pointer-down, not on click. */
async function openTab(name: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
  return screen.findByRole('tabpanel');
}

describe('catalog list filters', () => {
  it('narrows the list by packaging, cluster and search, then widens it again', async () => {
    openAs('R1', '/catalog');
    render(<App />);
    await screen.findByText('Domain catalog');

    // Packaging alone: nine entries ship a compose file.
    fireEvent.click(await screen.findByRole('button', { name: 'Compose' }));
    expect(await screen.findByText('9 shown')).toBeDefined();

    // The chip states that it is the active filter, not only the rows that changed.
    expect(screen.getByRole('button', { name: 'Compose' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    // A cluster narrows it further; both filters are carried on the same request.
    fireEvent.change(screen.getByLabelText('Filter by domain cluster'), {
      target: { value: 'Enabling Platform' },
    });
    expect(await screen.findByText('3 shown')).toBeDefined();

    // Search is debounced, so it is its own request once it settles — and here nothing matches.
    fireEvent.change(screen.getByLabelText('Search catalog'), { target: { value: 'Metabase' } });
    expect(
      await screen.findByText(
        'No entry matches this filter. Clear the filters to see the full catalog.',
      ),
    ).toBeDefined();

    // Clearing the filters puts the full catalog back: the "all" branches are what keep an empty
    // `packaging`/`cluster` parameter out of the query key.
    fireEvent.change(screen.getByLabelText('Search catalog'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'All packaging' }));
    fireEvent.change(screen.getByLabelText('Filter by domain cluster'), {
      target: { value: 'all' },
    });

    expect(await screen.findByText('13 shown')).toBeDefined();
    expect(screen.getByRole('button', { name: 'All packaging' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('reports a catalog that cannot be read and lists it when the operator retries', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/catalog', () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(
              403,
              'Browsing the catalog needs a catalog reader',
              'catalog.browse is required.',
            )
          : HttpResponse.json(getState().catalog);
      }),
    );

    openAs('R1', '/catalog');
    render(<App />);

    // The list is the page: a failure that left no data replaces it, and the retry is the only
    // way back without a reload.
    expect(await screen.findByText('Browsing the catalog needs a catalog reader')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('EspoCRM')).toBeDefined();
    expect(attempts).toBe(2);
  });

  it('counts an entry that is not deployed as its own deployment', async () => {
    const entries = getState().catalog.map((entry) =>
      entry.key === 'D01-01' ? { ...entry, primaryInstanceId: null } : entry,
    );
    server.use(http.get('/api/v1/catalog', () => HttpResponse.json(entries)));

    openAs('R1', '/catalog');
    render(<App />);
    await screen.findByText('EspoCRM');

    // An entry with no instance still owns a deployment slot of its own; dropping it would make
    // the header undercount what the table is showing.
    const header = screen.getByText(/\d+ domain entries, \d+ deployments/);
    expect(header.textContent).toContain('13 domain entries');
    expect(header.textContent).toContain('12 deployments');
  });
});

describe('catalog reload receipt', () => {
  it('names every refused file, unapplied artefact and change of a partial reload', async () => {
    server.use(
      http.post('/api/v1/catalog/reload', () =>
        HttpResponse.json({
          reloadedAt: '2026-10-21T09:00:00.000Z',
          revision: 'b40e771',
          entries: 13,
          added: 1,
          changed: 1,
          removed: 0,
          reconciled: [
            { key: 'D03-01', change: 'updated', detail: 'D03-01 httpPort 8080 → 80' },
            { key: 'D04-01', change: 'unchanged', detail: 'D04-01 matches repository revision' },
          ],
          environment: {
            added: 1,
            changed: 1,
            removed: 0,
            refused: [
              {
                key: 'D02-01',
                name: 'MAUTIC_DB_PASSWORD',
                reason: 'a running instance reads the current value',
              },
              { key: 'D07-01', name: null, reason: 'the file declares no variables' },
            ],
            applied: [{ key: 'D09-01', added: 1, changed: 0, removed: 0 }],
          },
          invalid: [
            {
              path: 'catalog/env/D05-01.json',
              scope: 'environment',
              key: 'D05-01',
              reason: 'the file is not parseable JSON',
            },
          ],
        }),
      ),
    );

    openAs('R1', '/catalog');
    render(<App />);
    await screen.findByText('Domain catalog');

    fireEvent.click(await screen.findByRole('button', { name: 'Reload from repository' }));

    // A refusal is not a success: the title says so instead of claiming the repository reloaded.
    expect(
      await screen.findByText(/Repository reloaded at revision b40e771, with changes refused/),
    ).toBeDefined();

    // Each refused file is named, with and without the variable it was about.
    const receipt = screen.getByText(/Repository reloaded at revision b40e771/).closest('div');
    expect(within(receipt as HTMLElement).getByText(/MAUTIC_DB_PASSWORD/)).toBeDefined();
    expect(
      within(receipt as HTMLElement).getByText(
        /File skipped, nothing was written: the file declares no variables/,
      ),
    ).toBeDefined();

    // An artefact that could not even be read is reported separately from a refusal.
    expect(
      within(receipt as HTMLElement).getByText(
        /Not applied, left as projected: the file is not parseable JSON/,
      ),
    ).toBeDefined();

    // The delta names what moved and what the environment reconciled.
    expect(within(receipt as HTMLElement).getByText('D03-01 httpPort 8080 → 80')).toBeDefined();
    expect(within(receipt as HTMLElement).getByText('updated')).toBeDefined();
    expect(
      within(receipt as HTMLElement).getByText(/environment: 1 added, 0 changed, 0 removed/),
    ).toBeDefined();
    expect(within(receipt as HTMLElement).getByText('env')).toBeDefined();
  });

  it('says nothing moved when the projection already matched the revision', async () => {
    // An older API omits the environment half entirely; the receipt must still read as a success
    // rather than printing "Environment: undefined added".
    server.use(
      http.post('/api/v1/catalog/reload', () =>
        HttpResponse.json({
          reloadedAt: '2026-10-21T09:00:00.000Z',
          revision: 'c0ffee1',
          entries: 13,
          added: 0,
          changed: 0,
          removed: 0,
          reconciled: [
            { key: 'D01-01', change: 'unchanged', detail: 'D01-01 matches repository revision' },
          ],
        }),
      ),
    );

    openAs('R1', '/catalog');
    render(<App />);
    await screen.findByText('Domain catalog');

    fireEvent.click(await screen.findByRole('button', { name: 'Reload from repository' }));

    expect(await screen.findByText(/Repository reloaded at revision c0ffee1/)).toBeDefined();
    expect(
      screen.getByText(
        /No drift: every entry and environment schema already matched this revision/,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Environment: \d+ added/)).toBeNull();
  });

  it('keeps the action unavailable while the reload is in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/catalog/reload', async () => {
        await gate;
        return HttpResponse.json({
          reloadedAt: '2026-10-21T09:00:00.000Z',
          revision: 'd1e2f30',
          entries: 13,
          added: 0,
          changed: 0,
          removed: 0,
          reconciled: [],
          environment: { added: 0, changed: 0, removed: 0, refused: [], applied: [] },
          invalid: [],
        });
      }),
    );

    openAs('R1', '/catalog');
    render(<App />);
    await screen.findByText('Domain catalog');

    fireEvent.click(await screen.findByRole('button', { name: 'Reload from repository' }));

    // A second click would start a second reconciliation against the same working tree.
    const pending = await screen.findByRole('button', { name: 'Reloading…' });
    expect(pending.hasAttribute('disabled')).toBe(true);

    release();
    expect(await screen.findByText(/Repository reloaded at revision d1e2f30/)).toBeDefined();
  });
});

describe('catalog entry actions', () => {
  it('keeps prefetch and deploy to the platform administrator', async () => {
    openAs('R2', '/catalog/D01-01');
    render(<App />);

    await screen.findByRole('heading', { name: /EspoCRM/ });

    // The pull consumes host bandwidth and disk, so a scoped reader is told who may run it.
    const prefetch = await screen.findByRole('button', { name: /Prefetch images/ });
    expect(prefetch.hasAttribute('disabled')).toBe(true);
    expect(prefetch.getAttribute('title')).toMatch(/R1 pre-pulls images/);

    // No deploy link either: the badge states the rule instead of an action that would be refused.
    expect(screen.queryByRole('link', { name: /Deploy/ })).toBeNull();
    expect(screen.getByText('deploy: platform administrator')).toBeDefined();
  });

  it('says the images are being pulled before the API answers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/catalog/D01-01/prefetch', async () => {
        await gate;
        return HttpResponse.json({
          jobId: 'job-prefetch-d1',
          links: {
            self: '/api/v1/jobs/job-prefetch-d1',
            logs: '/api/v1/jobs/job-prefetch-d1/logs',
          },
        });
      }),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    fireEvent.click(await screen.findByRole('button', { name: /Prefetch images/ }));

    const pending = await screen.findByRole('button', { name: 'Starting…' });
    expect(pending.hasAttribute('disabled')).toBe(true);

    release();
    expect(await screen.findByText(/Pre-pulling the images for D01-01/)).toBeDefined();
  });

  it('reports a prefetch that the API refused', async () => {
    server.use(
      http.post('/api/v1/catalog/D01-01/prefetch', () =>
        problemResponse(
          403,
          'Pulling images needs the platform administrator',
          'metadata.manage is required.',
        ),
      ),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    fireEvent.click(await screen.findByRole('button', { name: /Prefetch images/ }));

    // A refused pull must not look like a pull that started.
    expect(
      await screen.findByText('Pulling images needs the platform administrator'),
    ).toBeDefined();
    expect(screen.queryByText(/Pre-pulling the images for D01-01/)).toBeNull();
  });

  it('reports a review that the API refused', async () => {
    server.use(
      http.patch('/api/v1/catalog/D01-01/integration-metadata', () =>
        problemResponse(
          403,
          'Recording a review needs metadata.manage',
          'A scoped grant may not record a verification.',
        ),
      ),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    fireEvent.click(await screen.findByRole('button', { name: /Record verified review/ }));

    expect(await screen.findByText('Recording a review needs metadata.manage')).toBeDefined();
    expect(screen.queryByText(/metadata verified/)).toBeNull();
  });

  it('says the review is being recorded while the call is in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.patch('/api/v1/catalog/D01-01/integration-metadata', async () => {
        await gate;
        return HttpResponse.json(entryFor('D01-01'));
      }),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    fireEvent.click(await screen.findByRole('button', { name: /Record verified review/ }));

    const pending = await screen.findByRole('button', { name: 'Recording…' });
    expect(pending.hasAttribute('disabled')).toBe(true);

    release();
    expect(await screen.findByText('D01-01 metadata verified')).toBeDefined();
  });

  it('keeps the cached entry and offers a retry when a re-read fails', async () => {
    const entry = entryFor('D01-01');
    let rereadFails = false;
    server.use(
      http.get('/api/v1/catalog/D01-01', () =>
        rereadFails
          ? problemResponse(
              403,
              'Reading the entry needs catalog.read_metadata',
              'Re-read refused.',
            )
          : HttpResponse.json(entry),
      ),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    // Recording a review invalidates the entry, so the next read is the one that fails.
    rereadFails = true;
    fireEvent.click(await screen.findByRole('button', { name: /Record verified review/ }));

    expect(await screen.findByText('Showing the last data that loaded')).toBeDefined();
    // The cached detail surface stays: a failed *refetch* is not an empty entry.
    expect(screen.getByRole('heading', { name: /EspoCRM/ })).toBeDefined();
    expect(screen.getByText('Re-read refused.')).toBeDefined();

    rereadFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByText('Showing the last data that loaded')).toBeNull());
  });

  it('retries an entry that could not be read at all', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/catalog/D01-01', () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(403, 'Reading the entry needs catalog.read_metadata', 'No read scope.')
          : HttpResponse.json(entryFor('D01-01'));
      }),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);

    // Nothing is cached, so the whole screen is a gate — and the gate's retry is the way back.
    expect(await screen.findByText('No read scope.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: /EspoCRM/ })).toBeDefined();
    expect(attempts).toBe(2);
  });

  it('says an entry has no deployment, no dependencies and a digest nothing can pin', async () => {
    server.use(
      http.get('/api/v1/catalog/D01-01', () =>
        HttpResponse.json({
          ...entryFor('D01-01'),
          primaryInstanceId: null,
          dependencies: [],
          imageDigest: 'sha256:9c1f4a7e2b',
        }),
      ),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    // "Not deployed" and "None" are statements, not blanks: an empty cell reads as unknown.
    expect(await screen.findByText('Not deployed')).toBeDefined();
    expect(screen.getByText('None')).toBeDefined();
    // A digest that is not a sha256 of 64 hex characters can never match a registry manifest.
    expect(screen.getByText(/Not a sha256:<64 hex> digest/)).toBeDefined();
    expect(screen.queryByText(/This digest is what a deployment pins/)).toBeNull();
  });

  it('confirms a digest that a deployment can actually pin', async () => {
    // The fixtures carry a synthetic digest, so the other side of the FR-1.5 check needs a real
    // one: without it the screen would never state that the pin is what a deployment resolves.
    const pinned = `sha256:${'a1'.repeat(32)}`;
    server.use(
      http.get('/api/v1/catalog/D01-01', () =>
        HttpResponse.json({ ...entryFor('D01-01'), imageDigest: pinned }),
      ),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    expect(await screen.findByText(/This digest is what a deployment pins/)).toBeDefined();
    expect(screen.getByText(pinned)).toBeDefined();
  });

  it('states the entry that shares a deployment and the upstream release it is behind', async () => {
    openAs('R1', '/catalog/D05-01');
    render(<App />);
    await screen.findByRole('heading', { name: /ERPNext Accounts/ });

    // D5 and D6 run on one deployment, so an operator reading D5 must see what else is on it.
    expect(await screen.findByText('D06-01')).toBeDefined();
    expect(screen.getByText('15.41.3 (update available)')).toBeDefined();
    expect(screen.getByText(/GHSA-/)).toBeDefined();
    expect(screen.getByText(/Tracked in the patch register/)).toBeDefined();
  });

  it('warns before a granularity change makes the entry write-ineligible', async () => {
    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    const select = (await screen.findByLabelText('Credential granularity')) as HTMLSelectElement;
    expect(select.value).toBe('scoped');

    fireEvent.change(select, { target: { value: 'none' } });

    // The verdict, not the label: the operator sees the consequence before submitting.
    expect(await screen.findByText('Write-ineligible')).toBeDefined();
    expect(screen.getByText(/Unrecorded change/)).toBeDefined();

    // Back to the recorded value and the draft is no longer a pending change.
    fireEvent.change(select, { target: { value: 'scoped' } });

    await waitFor(() => expect(screen.queryByText(/Unrecorded change/)).toBeNull());
    expect(screen.queryByText('Write-ineligible')).toBeNull();
  });
});

describe('integration metadata tab', () => {
  it('flags an overdue review and a product that cannot support single logout', async () => {
    openAs('R1', '/catalog/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Mautic/ });

    const panel = await openTab('Integration metadata');

    expect(await within(panel).findByText('Metadata review is overdue')).toBeDefined();
    expect(within(panel).getByText('Not supported')).toBeDefined();
  });

  it('falls back to the raw identifier for a trigger the label map does not know', async () => {
    const entry = entryFor('D01-01');
    server.use(
      http.get('/api/v1/catalog/D01-01', () =>
        HttpResponse.json({
          ...entry,
          integration: {
            ...entry.integration,
            eventModes: [{ mode: 'none', label: 'Nothing is published' }],
          },
        }),
      ),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    const panel = await openTab('Integration metadata');

    // `none` is a declared mode with no label; printing nothing would hide the declaration.
    expect(await within(panel).findByText('none')).toBeDefined();
    expect(within(panel).getByText('Nothing is published')).toBeDefined();
  });

  it('says an entry with no event mechanism would fall back to polling', async () => {
    const entry = entryFor('D01-01');
    server.use(
      http.get('/api/v1/catalog/D01-01', () =>
        HttpResponse.json({
          ...entry,
          integration: { ...entry.integration, eventModes: [] },
        }),
      ),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    const panel = await openTab('Integration metadata');

    expect(
      await within(panel).findByText(
        /This entry declares no event mechanism; workflows would fall back to polling/,
      ),
    ).toBeDefined();
  });

  it('says a write-ineligible entry may still be read from', async () => {
    openAs('R1', '/catalog/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Mautic/ });

    const panel = await openTab('Integration metadata');

    // `account` granularity: writes are refused, reads are not — the screen used to say nothing.
    expect(
      await within(panel).findByText('Write workflows are ineligible for this entry'),
    ).toBeDefined();
    expect(within(panel).getByText(/Workflows may still read from it/)).toBeDefined();
  });

  it('says no workflow of any kind may target an entry with no credential to broker', async () => {
    openAs('R1', '/catalog/D11-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Metabase/ });

    const panel = await openTab('Integration metadata');

    expect(
      await within(panel).findByText('Write workflows are ineligible for this entry'),
    ).toBeDefined();
    expect(within(panel).getByText(/No workflow of any kind may target it/)).toBeDefined();
  });
});

describe('environment schema tab', () => {
  it('names the repository revision the declaration was projected from', async () => {
    server.use(
      http.get('/api/v1/catalog/D01-01/env-schema', () =>
        HttpResponse.json([
          {
            name: 'SMTP_HOST',
            purpose: 'Outbound mail relay used for notifications and password resets.',
            type: 'string',
            required: true,
            defaultValue: 'smtp.seamnex.local',
            constraint: 'hostname or IP',
            conditional: null,
            secret: false,
            overrideCeiling: 'profile_only',
            revision: 'a91f0c4f6d2e7b19',
          },
        ]),
      ),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    const panel = await openTab(/Environment schema/);

    // "What is declared" without "where from" leaves the operator guessing whether a reload ran.
    expect(await within(panel).findByText(/projected from revision a91f0c4f6d2/)).toBeDefined();
  });

  it('says the entry declares no variables at all', async () => {
    server.use(http.get('/api/v1/catalog/D01-01/env-schema', () => HttpResponse.json([])));

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    const panel = await openTab(/Environment schema/);

    expect(await within(panel).findByText('No declared variables')).toBeDefined();
    // With nothing declared there is no file to name, so the provenance line is not rendered.
    expect(within(panel).queryByText(/Declared in/)).toBeNull();
  });

  it('reports a schema that cannot be read and lists it when the operator retries', async () => {
    // Kept failing until the operator retries: the loader answers 5xx, which the query retries
    // on its own, so a one-shot failure would be recovered without the retry being involved.
    let failing = true;
    server.use(
      http.get('/api/v1/catalog/D01-01/env-schema', () =>
        failing
          ? problemResponse(
              503,
              'The environment schema could not be projected',
              'The loader crashed.',
              'INTERNAL',
            )
          : HttpResponse.json([
              {
                name: 'SMTP_HOST',
                purpose: 'Outbound mail relay used for notifications and password resets.',
                type: 'string',
                required: true,
                defaultValue: 'smtp.seamnex.local',
                constraint: 'hostname or IP',
                conditional: null,
                secret: false,
                overrideCeiling: 'profile_only',
              },
            ]),
      ),
    );

    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    const panel = await openTab(/Environment schema/);

    expect(
      await within(panel).findByText('The environment schema could not be projected'),
    ).toBeDefined();

    failing = false;
    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));

    expect(await within(panel).findByText('SMTP_HOST')).toBeDefined();
  });
});

describe('scaffold draft tab', () => {
  it('says the confirmation is in flight and hides the action meanwhile', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Confirming invalidates the whole `catalog` key space, so the draft is re-read afterwards:
    // the handler has to report the approval or the refetch would undo it on screen.
    let confirmed = false;
    server.use(
      http.get('/api/v1/catalog/D02-01/scaffold', () =>
        HttpResponse.json({
          ...scaffoldFor('D02-01'),
          approvedBy: confirmed ? 'Sofia Almeida' : null,
        }),
      ),
      http.post('/api/v1/catalog/D02-01/scaffold/:draftId/confirm', async () => {
        await gate;
        confirmed = true;
        return HttpResponse.json({ ...scaffoldFor('D02-01'), approvedBy: 'Sofia Almeida' });
      }),
    );

    openAs('R1', '/catalog/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Mautic/ });

    const panel = await openTab('Scaffold draft');
    fireEvent.click(await within(panel).findByRole('button', { name: /Confirm artefacts/ }));

    // A second confirmation would commit a second time against the same draft.
    const pending = await within(panel).findByRole('button', { name: 'Confirming…' });
    expect(pending.hasAttribute('disabled')).toBe(true);

    release();
    // The confirmed draft replaces the cached one, so the action and the "pending review" copy
    // both go: the button existing still would mean the confirmation did not land.
    expect(await within(panel).findByText(/Approved by Sofia Almeida/)).toBeDefined();
    expect(within(panel).queryByRole('button', { name: /Confirm/ })).toBeNull();
  });

  it('reports a confirmation the API refused and leaves the action available', async () => {
    server.use(
      http.get('/api/v1/catalog/D02-01/scaffold', () =>
        HttpResponse.json({ ...scaffoldFor('D02-01'), approvedBy: null }),
      ),
      http.post('/api/v1/catalog/D02-01/scaffold/:draftId/confirm', () =>
        problemResponse(
          403,
          'Confirming a draft needs the platform administrator',
          'Only R1 may commit generated artefacts.',
        ),
      ),
    );

    openAs('R1', '/catalog/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Mautic/ });

    const panel = await openTab('Scaffold draft');
    fireEvent.click(await within(panel).findByRole('button', { name: /Confirm artefacts/ }));

    // A refused confirmation is shown in place, and the draft stays pending so it can be repeated
    // once the grant exists — hiding the button would strand the entry without a path forward.
    expect(
      await within(panel).findByText('Confirming a draft needs the platform administrator'),
    ).toBeDefined();
    expect(within(panel).getByRole('button', { name: /Confirm artefacts/ })).toBeDefined();
  });

  it('reports a draft that carries no diagnostics of its own', async () => {
    server.use(
      http.get('/api/v1/catalog/D02-01/scaffold', () =>
        HttpResponse.json({ ...scaffoldFor('D02-01'), diagnostics: [] }),
      ),
    );

    openAs('R1', '/catalog/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Mautic/ });

    const panel = await openTab('Scaffold draft');

    // Absence of results is not a pass: the copy says why the list is empty.
    expect(
      await within(panel).findByText(/No diagnostics are recorded on the draft/),
    ).toBeDefined();
  });

  it('reports a draft whose own check failed', async () => {
    server.use(
      http.get('/api/v1/catalog/D02-01/scaffold', () =>
        HttpResponse.json({
          ...scaffoldFor('D02-01'),
          diagnostics: [
            {
              id: 'health',
              label: 'Health check present',
              state: 'fail',
              detail: 'No health check is declared for the `web` service.',
              remediation: null,
            },
          ],
        }),
      ),
    );

    openAs('R1', '/catalog/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Mautic/ });

    const panel = await openTab('Scaffold draft');

    expect(await within(panel).findByText('fail')).toBeDefined();
    expect(
      within(panel).getByText('No health check is declared for the `web` service.'),
    ).toBeDefined();
  });

  it('reports a draft that cannot be read and shows it when the operator retries', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/catalog/D02-01/scaffold', () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(
              404,
              'No scaffold draft for this entry',
              'The draft was pruned.',
              'SCAFFOLD_NOT_FOUND',
            )
          : HttpResponse.json(scaffoldFor('D02-01'));
      }),
    );

    openAs('R1', '/catalog/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Mautic/ });

    const panel = await openTab('Scaffold draft');

    expect(await within(panel).findByText('The draft was pruned.')).toBeDefined();

    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));

    expect(await within(panel).findByText('Generated artefacts')).toBeDefined();
  });
});
