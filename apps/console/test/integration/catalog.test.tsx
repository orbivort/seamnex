import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { scaffoldFor } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The catalog is the declarative source of truth: an entry's pinned images, its verified
 * integration facts and its declared environment all have to be inspectable before a deployment,
 * and recording a review is what restarts the staleness clock.
 */
describe('catalog list', () => {
  it('reloads the repository and reports what the revision changed', async () => {
    openAs('R1', '/catalog');
    render(<App />);
    await screen.findByText('Domain catalog');

    fireEvent.click(await screen.findByRole('button', { name: 'Reload from repository' }));

    expect(await screen.findByText(/Repository reloaded at revision/i)).toBeDefined();
  });

  it('does not offer a reload to a role without metadata.manage', async () => {
    openAs('R2', '/catalog');
    render(<App />);
    await screen.findByText('Domain catalog');

    const reload = await screen.findByRole('button', { name: 'Reload from repository' });
    expect(reload.hasAttribute('disabled')).toBe(true);
  });

  it('reports a refused reload next to the action', async () => {
    server.use(
      http.post('/api/v1/catalog/reload', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Reloading the catalog needs the platform administrator',
            status: 403,
            detail: 'metadata.manage is required.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the platform administrator.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/catalog');
    render(<App />);
    await screen.findByText('Domain catalog');

    fireEvent.click(await screen.findByRole('button', { name: 'Reload from repository' }));

    expect(
      await screen.findByText('Reloading the catalog needs the platform administrator'),
    ).toBeDefined();
  });
});

describe('catalog entry', () => {
  it('states the entry facts, its pinned image and its licence', async () => {
    openAs('R1', '/catalog/D01-01');
    render(<App />);

    expect(await screen.findByRole('heading', { name: /EspoCRM/ })).toBeDefined();
    expect(await screen.findByText('Catalog entry facts')).toBeDefined();
    expect(screen.getByText('Upstream repository')).toBeDefined();
    expect(screen.getByText('Pinned image')).toBeDefined();
    expect(screen.getByText('Default resource shape')).toBeDefined();
  });

  it('lists the verified integration facts and the operation inventory', async () => {
    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Integration metadata' }));
    const panel = await screen.findByRole('tabpanel');

    expect(await within(panel).findByText('Verified integration facts')).toBeDefined();
    expect(within(panel).getByText('API base URL')).toBeDefined();
    expect(within(panel).getByText('Operation inventory')).toBeDefined();
    expect(within(panel).getByText('Event and start modes')).toBeDefined();
  });

  it('lists the declared environment schema', async () => {
    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Environment schema/ }));
    const panel = await screen.findByRole('tabpanel');

    expect(await within(panel).findByText('Declared environment schema')).toBeDefined();
    expect(within(panel).getByText('ADMIN_EMAIL')).toBeDefined();
    expect(within(panel).getAllByText('Profile + instance').length).toBeGreaterThan(0);
  });

  it('records a verified review and restarts the staleness clock', async () => {
    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    fireEvent.click(await screen.findByRole('button', { name: /Record verified review/ }));

    expect(await screen.findByText('D01-01 metadata verified')).toBeDefined();
    expect(screen.getByText(/Review recorded by/)).toBeDefined();
  });

  it('prefetches the pinned images without touching the route', async () => {
    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    fireEvent.click(await screen.findByRole('button', { name: /Prefetch images/ }));

    expect(await screen.findByText(/Pre-pulling the images for D01-01/)).toBeDefined();
    expect(
      screen.getByText(/It does not create containers or touch the published route/),
    ).toBeDefined();
  });

  it('sends an operator to the deploy wizard', async () => {
    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    const deploy = await screen.findByRole('link', { name: /Deploy/ });
    expect(deploy).toBeDefined();
  });

  it('shows the scaffold tab only for a scaffolded entry', async () => {
    openAs('R1', '/catalog/D01-01');
    render(<App />);
    await screen.findByRole('heading', { name: /EspoCRM/ });

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).not.toContain(
      'Scaffold draft',
    );
  });

  it('renders the generated artefacts of a scaffolded draft', async () => {
    openAs('R1', '/catalog/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Mautic/ });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Scaffold draft' }));
    const panel = await screen.findByRole('tabpanel');

    expect(await within(panel).findByText('Generated artefacts')).toBeDefined();
    expect(within(panel).getByText('Validation diagnostics')).toBeDefined();
    expect(within(panel).getAllByText('pass').length).toBeGreaterThan(0);
  });

  it('confirms a draft that is still pending review', async () => {
    const draft = scaffoldFor('D02-01');
    expect(draft).toBeDefined();
    server.use(
      http.get('/api/v1/catalog/:key/scaffold', () =>
        HttpResponse.json({ ...draft, approvedBy: null, committedAt: null }),
      ),
    );

    openAs('R1', '/catalog/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: /Mautic/ });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Scaffold draft' }));
    const panel = await screen.findByRole('tabpanel');
    fireEvent.click(await within(panel).findByRole('button', { name: /Confirm artefacts/ }));

    await waitFor(() =>
      expect(within(panel).queryByRole('button', { name: /Confirm artefacts/ })).toBeNull(),
    );
  });

  it('reports an entry that cannot be read instead of an empty page', async () => {
    server.use(http.get('/api/v1/catalog/D01-01', () => HttpResponse.error()));

    openAs('R1', '/catalog/D01-01');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
  });

  it('marks an entry whose metadata is stale', async () => {
    openAs('R1', '/catalog/D02-01');
    render(<App />);

    expect(await screen.findByText('metadata stale')).toBeDefined();
  });
});
