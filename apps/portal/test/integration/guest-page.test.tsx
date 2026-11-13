import { fireEvent, render, screen, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { resetState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

function renderGuest(): void {
  openAs('R6');
  render(<App />);
}

describe('guest surface', () => {
  it('shows the one scoped product, its status and the session lifetime', async () => {
    renderGuest();

    expect(await screen.findByText(/Hello, Jonas/)).toBeDefined();
    expect(screen.getByText('Zammad')).toBeDefined();
    expect(screen.getAllByText('Guest access · scoped invitation').length).toBeGreaterThan(0);
    expect(screen.getByText('Session')).toBeDefined();
    expect(screen.getByText('Boundaries')).toBeDefined();
    expect(screen.getByText(/No catalog browsing. No administration./)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open surface' })).toBeDefined();
  });

  it('opens the launch dialog for the invited product', async () => {
    renderGuest();

    fireEvent.click(await screen.findByRole('button', { name: 'Open surface' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Launch target')).toBeDefined();
    expect(await within(dialog).findByText('https://helpdesk.seamnex.local/')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/Hello, Jonas/)).toBeDefined();
  });

  it('labels the guest session as a scoped invitation, not a single factor', async () => {
    renderGuest();

    expect(await screen.findByText('Scoped invite')).toBeDefined();
  });

  it('says the session is still loading when the identity has not answered yet', async () => {
    server.use(
      http.get('/api/v1/me', async () => {
        await delay('infinite');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderGuest();

    expect(await screen.findByText('Zammad')).toBeDefined();
    expect(screen.getByText('Loading session…')).toBeDefined();
    expect(screen.getByText('Loading')).toBeDefined();
  });

  it('ends the session only after confirmation', async () => {
    renderGuest();

    fireEvent.click(await screen.findByRole('button', { name: 'End session' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/ends your platform session/i)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay signed in' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/Hello, Jonas/)).toBeDefined();
  });

  it('explains an invitation with no product attached', async () => {
    server.use(
      http.get('/api/v1/me/launcher', () =>
        HttpResponse.json({
          environment: 'sbx-frankfurt-01',
          generatedAt: new Date().toISOString(),
          tiles: [],
          counts: { total: 0, available: 0, degraded: 0, unavailable: 0, maintenance: 0 },
        }),
      ),
    );
    renderGuest();

    expect(await screen.findByText('This invitation has no product attached')).toBeDefined();
    expect(screen.getByText(/The link may have expired or been revoked/)).toBeDefined();
  });

  it('reports an unreachable API instead of an empty invitation', async () => {
    resetState('offline');
    openAs('R6', 'offline');
    render(<App />);

    expect(await screen.findByText(/Platform API is unreachable/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    // The retry is a refetch of the same query; the outage stands, so the panel stays.
    expect(await screen.findByText(/Platform API is unreachable/i)).toBeDefined();
  });
});
