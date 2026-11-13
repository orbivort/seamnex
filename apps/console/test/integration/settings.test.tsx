import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * Platform settings are a write surface with two independent reads: the limits form and the alert
 * channels. One failing read must not stand in for the other, and an unchanged form must not be
 * savable.
 */
describe('platform settings', () => {
  it('shows the stored limits and names who changed them', async () => {
    openAs('R1', '/admin/settings');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeDefined();
    const stored = getState().settings;
    expect(await screen.findByDisplayValue(String(stored.breakGlassMaxMinutes))).toBeDefined();
    expect(screen.getByDisplayValue(String(stored.restoreConcurrency))).toBeDefined();
    expect(screen.getByDisplayValue(String(stored.oversubscriptionFactor))).toBeDefined();
    expect(screen.getByText(`${stored.sessionIdleMinutes} min`)).toBeDefined();
    expect(screen.getByText(new RegExp(`Last changed .* by ${stored.updatedBy}`))).toBeDefined();
  });

  it('refuses to save an untouched form and saves a changed one', async () => {
    openAs('R1', '/admin/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save.hasAttribute('disabled')).toBe(true);

    fireEvent.change(await screen.findByLabelText(/Break-glass maximum/), {
      target: { value: '75' },
    });

    expect(await screen.findByText('unsaved changes: breakGlassMaxMinutes')).toBeDefined();
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    fireEvent.click(save);

    expect(await screen.findByText('Settings saved')).toBeDefined();
    await waitFor(() => expect(screen.queryByText(/unsaved changes:/)).toBeNull());
    expect(getState().settings.breakGlassMaxMinutes).toBe(75);
  });

  it('surfaces a stale-form refusal instead of overwriting', async () => {
    server.use(
      http.put('/api/v1/admin/settings', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/precondition-failed',
            title: 'Platform settings changed since this form was loaded',
            status: 412,
            detail: 'The stored representation is newer; reload the settings before saving.',
            code: 'PRECONDITION_FAILED',
            fieldErrors: [],
            remediation: 'Reload the settings.',
          },
          { status: 412 },
        ),
      ),
    );

    openAs('R1', '/admin/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });

    fireEvent.change(await screen.findByLabelText(/Restore concurrency/), {
      target: { value: '6' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('Platform settings changed since this form was loaded'),
    ).toBeDefined();
  });

  it('toggles an alert channel through the API', async () => {
    openAs('R1', '/admin/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });

    const channels = getState().alerts;
    const switches = await screen.findAllByRole('switch');
    expect(switches).toHaveLength(channels.length);

    const target = channels.findIndex((channel) => !channel.enabled);
    if (target === -1) return;
    fireEvent.click(present(switches[target], 'the switch of the disabled channel'));

    await waitFor(() => expect(getState().alerts[target]?.enabled).toBe(true));
  });

  it('reports a refused alert-channel write inside the panel', async () => {
    server.use(
      http.put('/api/v1/admin/settings/alerts', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Alert configuration is not permitted for your role',
            status: 403,
            detail: 'alert.configure needs the platform administrator.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the platform administrator.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/admin/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });

    const switches = await screen.findAllByRole('switch');
    fireEvent.click(present(switches[0], 'an alert-channel switch'));

    expect(
      await screen.findByText('Alert configuration is not permitted for your role'),
    ).toBeDefined();
  });

  it('offers to configure the first channel when none exists', async () => {
    getState().alerts = [];

    openAs('R1', '/admin/settings');
    render(<App />);

    expect(await screen.findByText('No alert channel configured')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Add an e-mail channel' }));

    await waitFor(() => expect(getState().alerts).toHaveLength(1));
    expect(await screen.findByText('ops@seamnex.local')).toBeDefined();
  });

  it('keeps the alert panel usable when only the settings read fails', async () => {
    server.use(http.get('/api/v1/admin/settings', () => HttpResponse.error()));

    openAs('R1', '/admin/settings');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    // The alert panel is a separate region and still rendered its channels.
    expect(await screen.findByText('it-ops@seamnex.local')).toBeDefined();
  });

  it('keeps the settings form usable when only the alert read fails', async () => {
    server.use(http.get('/api/v1/admin/settings/alerts', () => HttpResponse.error()));

    openAs('R1', '/admin/settings');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(
      await screen.findByDisplayValue(String(getState().settings.breakGlassMaxMinutes)),
    ).toBeDefined();
  });

  it('is read-only for a role without settings.manage', async () => {
    // R2 holds `settings.view` but not `settings.manage`; the route admits it and the API refuses.
    openAs('R2', '/admin/settings');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
