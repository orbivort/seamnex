import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '@seamnex/api-client';
import { server } from '@seamnex/mocks/server';
import { LaunchDialog } from '../../src/components/LaunchDialog';
import { openAs } from '../helpers';
import { problemResponse } from '../problem-response';
import { tile } from '../tile-fixture';

function renderDialog(instanceId: string, onOpenChange = vi.fn()): void {
  openAs('R5');
  render(
    <ApiProvider>
      <LaunchDialog tile={tile({ instanceId })} onOpenChange={onOpenChange} />
    </ApiProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LaunchDialog', () => {
  it('opens a native product on its published URL and records the launch', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onOpenChange = vi.fn();
    renderDialog('inst-crm', onOpenChange);

    // The body is one async region: the URL appears only once the target has loaded.
    expect(await screen.findByText('https://crm.seamnex.local/')).toBeDefined();
    expect(screen.getByText('Single sign-on')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Open in new tab/i }));

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://crm.seamnex.local/',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    // A native route needs no ticket, so the dialog stays open until the user closes it.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('mints a ticket for a forward-auth product and plants it in the claimed tab', async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const tab = {
      opener: {} as Window | null,
      location: { replace },
      close,
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(tab);
    const onOpenChange = vi.fn();
    renderDialog('inst-projects', onOpenChange);

    expect(await screen.findByText('https://projects.seamnex.local/')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Open in new tab/i }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        expect.stringContaining('/__seamnex/session?ticket=demo-'),
      ),
    );
    // The product tab must not be able to reach back into the portal.
    expect(tab.opener).toBeNull();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('leaves the dialog open when the browser blocks the popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const onOpenChange = vi.fn();
    renderDialog('inst-projects', onOpenChange);

    expect(await screen.findByText('https://projects.seamnex.local/')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Open in new tab/i }));

    // `window.location.assign` cannot be observed in jsdom, but the branch must not close the
    // dialog: the user navigates away in the same tab instead.
    await waitFor(() => expect(onOpenChange).not.toHaveBeenCalled());
  });

  it('closes the claimed tab and explains a refused ticket', async () => {
    const close = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      location: { replace: vi.fn() },
      close,
    } as unknown as Window);
    server.use(
      http.post('/api/v1/portal/launch-tickets/:instanceId', () =>
        problemResponse(403, 'ENTITLEMENT_REQUIRED', 'Not entitled', 'The ticket was refused.'),
      ),
    );
    renderDialog('inst-projects');

    expect(await screen.findByText('https://projects.seamnex.local/')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Open in new tab/i }));

    expect(await screen.findByText(/launch ticket could not be minted/i)).toBeDefined();
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('warns before opening a sign-in path that could not be verified', async () => {
    server.use(
      http.get('/api/v1/portal/launch-targets/:instanceId', () =>
        HttpResponse.json({
          instanceId: 'inst-crm',
          url: 'https://crm.seamnex.local/',
          authClass: 'native',
          ssoState: 'sso_unverified',
          note: 'Wired for single sign-on, but unproven.',
          opensInNewTab: true,
          bootstrapRequired: false,
          ssoHealth: {
            checked: false,
            ok: false,
            checkedAt: null,
            detail: '',
            reason: 'never_checked',
          },
        }),
      ),
    );
    renderDialog('inst-crm');

    expect(await screen.findByText(/The platform has no recent proof/)).toBeDefined();
    expect(screen.getByText(/No end-to-end sign-in check has run/)).toBeDefined();
    expect(screen.getByText(/Sign-in path unverified/)).toBeDefined();
  });

  it('reports a failed target read in place of the dialog body', async () => {
    server.use(
      http.get('/api/v1/portal/launch-targets/:instanceId', () =>
        problemResponse(
          404,
          'INSTANCE_NOT_FOUND',
          'Instance not found',
          'No instance matches inst-crm.',
        ),
      ),
    );
    renderDialog('inst-crm');

    expect(await screen.findByText('Instance not found')).toBeDefined();
    // The footer action cannot run without a target.
    expect(
      (screen.getByRole('button', { name: /Open in new tab/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('opens the product even when the launch record cannot be written', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    server.use(
      http.post('/api/v1/portal/launch-events/:instanceId', () =>
        problemResponse(503, 'AUDIT_UNAVAILABLE', 'Audit log unavailable', 'The record was lost.'),
      ),
    );
    renderDialog('inst-crm');
    await screen.findByText('https://crm.seamnex.local/');

    fireEvent.click(screen.getByRole('button', { name: /Open in new tab/i }));

    // The click is the last moment the platform is part of; a failed record must not block it.
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/launch ticket could not be minted/i)).toBeNull();
  });

  it('says it is preparing the sign-in while the ticket is minted', async () => {
    vi.spyOn(window, 'open').mockReturnValue({
      location: { replace: vi.fn() },
      close: vi.fn(),
    } as unknown as Window);
    server.use(
      http.post('/api/v1/portal/launch-tickets/:instanceId', async () => {
        await delay(150);
        return HttpResponse.json({
          url: 'https://projects.seamnex.local/__seamnex/session?ticket=slow',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }),
    );
    renderDialog('inst-projects');
    await screen.findByText('https://projects.seamnex.local/');

    fireEvent.click(screen.getByRole('button', { name: /Open in new tab/i }));

    expect(await screen.findByText('Preparing sign-in…')).toBeDefined();
  });

  it('explains a gate that does not need a bootstrap ticket', async () => {
    server.use(
      http.get('/api/v1/portal/launch-targets/:instanceId', () =>
        HttpResponse.json({
          instanceId: 'inst-crm',
          url: 'https://crm.seamnex.local/',
          authClass: 'fa_gate',
          ssoState: 'sign_in_required',
          note: 'Sign-in required. The product keeps its own credential.',
          opensInNewTab: true,
          bootstrapRequired: false,
          ssoHealth: {
            checked: false,
            ok: false,
            checkedAt: null,
            detail: '',
            reason: 'never_checked',
          },
        }),
      ),
    );
    renderDialog('inst-crm');

    expect(await screen.findByText(/The product signs you in itself/)).toBeDefined();
    expect(screen.getByText('Sign-in required — proxy gate only')).toBeDefined();
  });

  it('closes without launching when the user cancels', async () => {
    const onOpenChange = vi.fn();
    renderDialog('inst-crm', onOpenChange);
    await screen.findByText('https://crm.seamnex.local/');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('describes a gate without claiming who holds the credential', async () => {
    renderDialog('inst-projects');

    // ADR-BE-22: some gates are signed in by a relay with a platform-managed account, so the
    // dialog's own sentence may not say the credential is provisioned outside the platform.
    expect(await screen.findByText(/sits behind the platform gate/i)).toBeDefined();
    expect(screen.getByText('Sign-in required')).toBeDefined();
  });
});
