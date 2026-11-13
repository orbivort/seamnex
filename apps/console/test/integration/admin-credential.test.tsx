import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiProvider } from '@seamnex/api-client';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { AdminCredentialPanel } from '../../src/features/instances/tabs/AdminCredentialPanel';
import { openAs } from '../helpers';

/**
 * ADR-BE-22 §Credentials — the one credential the provisioning sweep cannot derive.
 *
 * The panel is only reachable from the instance's Environment tab, so every case below mounts the
 * app the way an operator does. Three products answer the question differently (a bearer token, the
 * installer's login, no adapter at all), and the "Provision now" report has four zeroes that mean
 * four different things — none of which the panel may collapse into one sentence.
 */
const BEARER = 'inst-projects';

/** Opens the instance and activates the Environment tab, where the panel lives. */
async function openPanel(instanceId: string, heading: string): Promise<HTMLElement> {
  openAs('R1', `/instances/${instanceId}`);
  render(<App />);
  await screen.findByRole('heading', { name: heading });

  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Environment' }));
  const tab = await screen.findByRole('tabpanel');
  await within(tab).findByText('Resolved environment');
  return within(tab)
    .findByText('Product administrator token')
    .then(() => tab);
}

const credential = (overrides: Record<string, unknown> = {}) =>
  HttpResponse.json({
    kind: 'bearer',
    required: true,
    configured: true,
    name: 'product_api_token',
    version: 7,
    ...overrides,
  });

const report = (overrides: Record<string, unknown> = {}) =>
  HttpResponse.json({
    instanceId: BEARER,
    enabled: true,
    configured: true,
    considered: 1,
    provisioned: 1,
    failed: 0,
    ...overrides,
  });

describe('administrator credential panel', () => {
  /*
   * Runs first: the mock store keeps the stored token for the rest of this file, and this case is
   * the only one that asserts the "never configured" state.
   */
  it('stores a token once, reports the version, and never shows the value again', async () => {
    const panel = await openPanel(BEARER, 'OpenProject');

    expect(await within(panel).findByText('not configured')).toBeDefined();
    expect(within(panel).getByText('product_api_token')).toBeDefined();

    fireEvent.click(within(panel).getByRole('button', { name: 'Add token' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Add administrator token')).toBeDefined();

    const input = within(drawer).getByLabelText('Administrator API token');
    const store = within(drawer).getByRole('button', { name: 'Store token' });

    // A token shorter than eight characters is not a token; the button says so before the API does.
    fireEvent.change(input, { target: { value: 'short' } });
    expect(store).toHaveProperty('disabled', true);

    fireEvent.change(input, { target: { value: 'a-real-product-token' } });
    expect(store).toHaveProperty('disabled', false);
    fireEvent.click(store);

    // A successful write closes the drawer and refetches: the panel now reads the stored version.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(panel).findByText('configured')).toBeDefined();
    expect(within(panel).getByText(/^v\d+$/)).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'Replace token' })).toBeDefined();
    // The value is write-only: the panel never prints it back.
    expect(within(panel).queryByDisplayValue('a-real-product-token')).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'Replace token' }));
    const replace = await screen.findByRole('dialog');
    expect(within(replace).getByText('Replace administrator token')).toBeDefined();
    expect(within(replace).getByLabelText('Administrator API token')).toHaveProperty('value', '');

    fireEvent.click(within(replace).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says a password product needs no token, and offers the pass anyway', async () => {
    const panel = await openPanel('inst-people', 'OrangeHRM');

    expect(await within(panel).findByText(/No API token is needed or read/)).toBeDefined();
    expect(within(panel).queryByRole('button', { name: /Add token|Replace token/ })).toBeNull();
    // The password product still provisions, so the on-demand pass is useful here.
    expect(within(panel).getByRole('button', { name: 'Provision now' })).toBeDefined();
  });

  it('says an entry with no adapter creates no accounts and reads no token', async () => {
    const panel = await openPanel('inst-crm', 'EspoCRM');

    expect(await within(panel).findByText(/registers no provisioning adapter/)).toBeDefined();
    expect(within(panel).queryByRole('button', { name: 'Provision now' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Add token' })).toBeNull();
  });

  it('reports a stored token that carries no version yet', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () =>
        credential({ configured: false, version: null }),
      ),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    expect(await within(panel).findByText('not configured')).toBeDefined();
    expect(within(panel).queryByText(/^v\d+$/)).toBeNull();
    expect(within(panel).getByText(/Until a token is stored/)).toBeDefined();
  });

  it('asks for a token only when the product requires one', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () =>
        credential({ required: false }),
      ),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    expect(await within(panel).findByText('configured')).toBeDefined();
    expect(within(panel).queryByRole('button', { name: /Add token|Replace token/ })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Provision now' })).toBeDefined();
  });
});

describe('provision now', () => {
  it('reports the counts of a pass that created more than one account', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () => credential()),
      http.post('/api/v1/instances/inst-projects/relay/provision', () =>
        report({ considered: 3, provisioned: 2, failed: 1 }),
      ),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Provision now' }));

    expect(await within(panel).findByText('Provisioning pass finished')).toBeDefined();
    expect(
      within(panel).getByText(/2 accounts created or refreshed, 1 failed, out of 3 considered/),
    ).toBeDefined();
  });

  it('uses the singular for a one-account pass', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () => credential()),
      http.post('/api/v1/instances/inst-projects/relay/provision', () => report()),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Provision now' }));
    expect(
      await within(panel).findByText(/1 account created or refreshed, 0 failed, out of 1/),
    ).toBeDefined();
  });

  it('names a disabled relay instead of reporting zeros', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () => credential()),
      http.post('/api/v1/instances/inst-projects/relay/provision', () =>
        report({ enabled: false, considered: 0, provisioned: 0 }),
      ),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Provision now' }));
    expect(
      await within(panel).findByText(/sign-in relay is disabled for this deployment/),
    ).toBeDefined();
  });

  it('names an empty allow-list, which no pass can ever select from', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () => credential()),
      http.post('/api/v1/instances/inst-projects/relay/provision', () =>
        report({ configured: false, considered: 0, provisioned: 0 }),
      ),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Provision now' }));
    expect(await within(panel).findByText(/No entry is allow-listed/)).toBeDefined();
  });

  it('names a correct configuration with nobody eligible as its own outcome', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () => credential()),
      http.post('/api/v1/instances/inst-projects/relay/provision', () =>
        report({ considered: 0, provisioned: 0 }),
      ),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Provision now' }));
    expect(
      await within(panel).findByText(/The configuration is right and nobody was eligible/),
    ).toBeDefined();
  });

  it('reports a pass the platform refused as an error, not as zero accounts', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () => credential()),
      http.post('/api/v1/instances/inst-projects/relay/provision', () => HttpResponse.error()),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Provision now' }));
    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();
    expect(within(panel).queryByText('Provisioning pass finished')).toBeNull();
  });
});

describe('failure states', () => {
  it('reports a credential read that failed and offers a retry', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () => HttpResponse.error()),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'Retry' })).toBeDefined();
    // A read failure is not "no credential": the panel must not claim an unconfigured token.
    expect(within(panel).queryByText('not configured')).toBeNull();
  });

  it('shows the API’s refusal when the token write fails', async () => {
    server.use(
      http.get('/api/v1/instances/inst-projects/admin-credential', () =>
        credential({ configured: false, version: null }),
      ),
      http.put('/api/v1/instances/inst-projects/admin-credential', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/validation-failed',
            title: 'The token is too short',
            status: 422,
            detail: 'A token must be at least 8 characters.',
            code: 'VALIDATION_FAILED',
            fieldErrors: [],
            remediation: 'Paste the value the product issued, without surrounding whitespace.',
          },
          { status: 422 },
        ),
      ),
    );
    const panel = await openPanel(BEARER, 'OpenProject');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Add token' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('Administrator API token'), {
      target: { value: 'a-real-product-token' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Store token' }));

    expect(await within(panel).findByText('The token is too short')).toBeDefined();
    expect(within(panel).queryByText('Token stored')).toBeNull();
  });

  it('renders nothing at all for a role without instance.env', () => {
    // The tab that hosts the panel is already gated on the same capability; this is its own half of
    // that decision, and it must not mount the read either.
    openAs('R1', '/');
    const detail = getState().instanceDetails[BEARER];
    if (detail === undefined) throw new Error('fixture instance inst-projects is missing');

    const { container } = render(
      <ApiProvider>
        <AdminCredentialPanel instance={detail} canEdit={false} />
      </ApiProvider>,
    );

    expect(container.textContent).toBe('');
  });
});
