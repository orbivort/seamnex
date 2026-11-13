import { fireEvent, render, screen, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { resetState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';
import { problemResponse } from '../problem-response';

const SEARCH = /Search entitled applications/i;

function renderLauncher(): void {
  openAs('R5');
  render(<App />);
}

describe('launcher search, filters and empty states', () => {
  it('narrows the grid to the search term across product, domain, slug and key', async () => {
    renderLauncher();
    await screen.findByText('EspoCRM');

    const search = screen.getByRole('textbox', { name: SEARCH });

    fireEvent.change(search, { target: { value: 'zammad' } });
    expect(screen.getByText('Zammad')).toBeDefined();
    expect(screen.queryByText('EspoCRM')).toBeNull();

    // The deployment address is the only thing distinguishing sibling instances.
    fireEvent.change(search, { target: { value: 'documents' } });
    expect(screen.getByText('Paperless-ngx')).toBeDefined();
    expect(screen.queryByText('Zammad')).toBeNull();

    // The catalog key is an exact-match search term.
    fireEvent.change(search, { target: { value: 'D01-01' } });
    expect(screen.getByText('EspoCRM')).toBeDefined();
    expect(screen.queryByText('Paperless-ngx')).toBeNull();
  });

  it('filters by availability and shows the count on each control', async () => {
    renderLauncher();
    await screen.findByText('EspoCRM');

    fireEvent.click(screen.getByRole('button', { name: /^Degraded/ }));

    expect(screen.getByRole('button', { name: /^Degraded/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('Paperless-ngx')).toBeDefined();
    expect(screen.queryByText('EspoCRM')).toBeNull();
    expect(screen.getByText('1 shown')).toBeDefined();
  });

  it('clears the search and the filter from the no-match state', async () => {
    renderLauncher();
    await screen.findByText('EspoCRM');

    fireEvent.change(screen.getByRole('textbox', { name: SEARCH }), {
      target: { value: 'nothing-matches-this' },
    });

    expect(await screen.findByText('Nothing matches this filter')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(screen.getByText('EspoCRM')).toBeDefined();
    expect((screen.getByRole('textbox', { name: SEARCH }) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: /^All/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('tells a role with no entitlements that the catalog is empty for it', async () => {
    resetState('empty');
    openAs('R5');
    render(<App />);

    expect(await screen.findByText('No applications yet')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Contact your domain owner' })).toBeDefined();
  });

  it('opens and closes the launch dialog from a tile', async () => {
    renderLauncher();
    await screen.findByText('EspoCRM');

    fireEvent.click(screen.getByRole('button', { name: /^Open EspoCRM$/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Launch target')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a failed listing behind the shared problem panel', async () => {
    server.use(
      http.get('/api/v1/me/launcher', () =>
        problemResponse(
          503,
          'LAUNCHER_UNAVAILABLE',
          'Launcher unavailable',
          'The listing could not be built.',
        ),
      ),
    );
    renderLauncher();

    expect(await screen.findByText('Launcher unavailable')).toBeDefined();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeDefined();
  });
});
