import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiProvider } from '@seamnex/api-client';
import type { InstanceDetail } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { EnvironmentTab } from '../../src/features/instances/tabs/EnvironmentTab';
import { openAs, present } from '../helpers';

/**
 * The environment panel is the only screen that both projects a resolved value and owns a write.
 *
 * The tab suites (`test/integration/instance-tabs*.test.tsx`) drive it through the route, which is
 * where the discard guard and the reconfigure callout were first described. What those suites cannot
 * vary cheaply is the *server's answer*: the mock platform always queues a reconfigure when a diff
 * exists, so the "stored but not applied" branch — the one that must not tell an operator the change
 * is live — has no fixture. The component is mounted directly here so each answer, each capability
 * and each fixture can be chosen per case without walking the app to the tab first.
 */

function detailOf(id: string): InstanceDetail {
  return present(getState().instanceDetails[id], `the ${id} instance detail`);
}

function renderTab(id: string, canEdit = true) {
  openAs('R1', `/instances/${id}`);
  render(
    <ApiProvider>
      <EnvironmentTab instance={detailOf(id)} canEdit={canEdit} />
    </ApiProvider>,
  );
}

/** The row that carries the variable name; a missing row must fail, not resolve to `null.closest`. */
function rowOf(variable: string): HTMLTableRowElement {
  const row = screen.getByText(variable).closest('tr');
  if (row === null) throw new Error(`the ${variable} row is not rendered inside a table`);
  return row;
}

async function openChangeDrawer(id: string, variable: string): Promise<HTMLElement> {
  renderTab(id);
  await screen.findByText(variable);
  fireEvent.click(within(rowOf(variable)).getByRole('button', { name: 'Change' }));
  return screen.findByRole('dialog');
}

describe('EnvironmentTab', () => {
  it('renders the resolved value with its source, ceiling and apply advice', async () => {
    renderTab('inst-crm');
    await screen.findByText('ADMIN_EMAIL');

    // A profile-supplied value is overridable, so it carries the only "Change" affordance in the row.
    const email = rowOf('ADMIN_EMAIL');
    expect(within(email).getByText('portal-admin@seamnex.local')).toBeDefined();
    expect(within(email).getByText('Environment profile')).toBeDefined();
    expect(within(email).getByText('Profile + instance')).toBeDefined();
    // The action that reaches a container, not the one the Restart button performs: a restart keeps
    // the environment the container was created with, so `restart` here was advice that could not work.
    expect(within(email).getByText('reconfigure')).toBeDefined();
    expect(within(email).queryByText('restart')).toBeNull();
    expect(within(email).getByRole('button', { name: 'Change' })).toBeDefined();

    // A resolved-but-empty variable must not look like an empty secret cell.
    expect(within(rowOf('ADMIN_DISPLAY_NAME')).getByText('—')).toBeDefined();

    // A secret is masked, and its ceiling is the reason there is no control at all.
    const secret = rowOf('DB_PASSWORD');
    expect(within(secret).getByText('••••••••')).toBeDefined();
    expect(within(secret).getByText('Secret store')).toBeDefined();
    expect(within(secret).getByText('Locked')).toBeDefined();
    expect(within(secret).getByText('locked')).toBeDefined();
    expect(within(secret).queryByRole('button', { name: 'Change' })).toBeNull();

    // A profile-only variable is readable here and changeable in the profile, not on the row.
    const profileOnly = rowOf('SMTP_HOST');
    expect(within(profileOnly).getByText('Profile only')).toBeDefined();
    expect(within(profileOnly).getByText('read-only')).toBeDefined();
    expect(within(profileOnly).queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('flags a row whose observed value drifted from the declaration', async () => {
    renderTab('inst-documents');
    await screen.findByText('PAPERLESS_OCR_LANGUAGE');

    expect(within(rowOf('PAPERLESS_OCR_LANGUAGE')).getByText('drift')).toBeDefined();
  });

  it('offers no override control to an operator who may not edit', async () => {
    renderTab('inst-collab', false);
    await screen.findByText('ADMIN_EMAIL');

    expect(screen.queryAllByRole('button', { name: 'Change' })).toHaveLength(0);
    expect(screen.getAllByText('read-only').length).toBeGreaterThan(0);
    expect(screen.getAllByText('locked').length).toBeGreaterThan(0);
    // The credential panel shares the capability, so it is absent for the same reason.
    expect(screen.queryByText('Product administrator token')).toBeNull();
  });

  it('explains an entry that declares no variables instead of drawing an empty table', async () => {
    getState().envValues['inst-marketing'] = [];

    renderTab('inst-marketing');

    expect(await screen.findByText('This entry declares no variables')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('reports an unreadable environment without inventing rows', async () => {
    server.use(http.get('/api/v1/instances/:id/env', () => HttpResponse.error()));

    renderTab('inst-documents');

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
  });

  it('sends the override and reports the reconfigure the server queued', async () => {
    const received: Record<string, string>[] = [];
    server.use(
      http.put('/api/v1/instances/:id/env', async ({ request }) => {
        const body = (await request.json()) as { values: Record<string, string> };
        received.push(body.values);
        return HttpResponse.json({
          diff: [{ name: 'SITE_NAME', from: null, to: 'ERPNext HQ', requiresRecreate: false }],
          requiresRecreate: false,
          applied: true,
          note: 'Stored and queued as a reconfigure job: the containers are recreated with these values.',
        });
      }),
    );

    const drawer = await openChangeDrawer('inst-erp', 'SITE_NAME');
    fireEvent.change(within(drawer).getByLabelText('New value'), {
      target: { value: 'ERPNext HQ' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save and render diff' }));

    expect(await screen.findByText('Reconfigure queued')).toBeDefined();
    expect(screen.getByText(/1 variable\(s\) changed/)).toBeDefined();
    expect(received).toEqual([{ SITE_NAME: 'ERPNext HQ' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not call a stored-but-unapplied change "queued"', async () => {
    // The API can store a value without re-rendering the definition (an apply that was refused or
    // deferred). The callout must follow `applied`, not the presence of a diff, or an operator is
    // told a change reached a container it never reached.
    server.use(
      http.put('/api/v1/instances/:id/env', () =>
        HttpResponse.json({
          diff: [{ name: 'SITE_NAME', from: null, to: 'ERPNext HQ', requiresRecreate: false }],
          requiresRecreate: false,
          applied: false,
          note: 'Stored; the reconfigure job was not queued.',
        }),
      ),
    );

    const drawer = await openChangeDrawer('inst-erp', 'SITE_NAME');
    fireEvent.change(within(drawer).getByLabelText('New value'), {
      target: { value: 'ERPNext HQ' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save and render diff' }));

    expect(await screen.findByText('Stored — reconfigure required')).toBeDefined();
    expect(screen.getByText(/the reconfigure job was not queued/)).toBeDefined();
    expect(screen.getByText(/1 variable\(s\) changed/)).toBeDefined();
    expect(screen.queryByText('Reconfigure queued')).toBeNull();
  });

  it('reports a refused override next to the panel', async () => {
    server.use(
      http.put('/api/v1/instances/:id/env', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/invalid',
            title: 'That value is not allowed',
            status: 422,
            detail: 'SITE_NAME must be between 1 and 60 characters.',
            code: 'ENV_INVALID',
            fieldErrors: [],
            remediation: 'Correct the value.',
          },
          { status: 422 },
        ),
      ),
    );

    const drawer = await openChangeDrawer('inst-erp', 'SITE_NAME');
    fireEvent.change(within(drawer).getByLabelText('New value'), { target: { value: '' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save and render diff' }));

    expect(await screen.findByText('That value is not allowed')).toBeDefined();
  });

  it('shows no callout when the save changed nothing', async () => {
    // "0 variable(s) changed" under a success tone was read as a silent failure; the panel stays
    // quiet instead, and the drawer still closes because the write succeeded.
    const drawer = await openChangeDrawer('inst-erp', 'ADMIN_EMAIL');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save and render diff' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(/variable\(s\) changed/)).toBeNull();
  });

  it('edits a boolean with a checkbox and stores the literal the product compares', async () => {
    const received: Record<string, string>[] = [];
    server.use(
      http.put('/api/v1/instances/:id/env', async ({ request }) => {
        const body = (await request.json()) as { values: Record<string, string> };
        received.push(body.values);
        return HttpResponse.json({
          diff: [
            {
              name: 'ESPOCRM_CONFIG_OIDC_SYNC_TEAMS',
              from: 'true',
              to: 'false',
              requiresRecreate: false,
            },
          ],
          requiresRecreate: false,
          applied: true,
          note: 'Stored and queued as a reconfigure job.',
        });
      }),
    );

    const drawer = await openChangeDrawer('inst-crm', 'ESPOCRM_CONFIG_OIDC_SYNC_TEAMS');
    const toggle = within(drawer).getByRole('checkbox', { name: 'Enabled' });
    expect(within(drawer).queryByLabelText('New value')).toBeNull();

    // false → true → false: both spellings the checkbox can produce have to be sendable.
    fireEvent.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(within(drawer).getByRole('button', { name: 'Save and render diff' }));

    await waitFor(() => expect(received).toEqual([{ ESPOCRM_CONFIG_OIDC_SYNC_TEAMS: 'false' }]));
  });

  it('asks before discarding an unapplied value and keeps it on "Keep editing"', async () => {
    const drawer = await openChangeDrawer('inst-helpdesk', 'TZ');
    fireEvent.change(within(drawer).getByLabelText('New value'), { target: { value: 'UTC' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(/Discard the unapplied value for TZ\?/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(screen.queryByText(/Discard the unapplied value/)).toBeNull());
    // Returning to the drawer must not cost the operator the value they already typed.
    expect((within(drawer).getByLabelText('New value') as HTMLInputElement).value).toBe('UTC');

    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes without a confirmation when nothing was typed', async () => {
    const drawer = await openChangeDrawer('inst-collab', 'ADMIN_EMAIL');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(/Discard the unapplied value/)).toBeNull();
  });

  it('keeps a half-typed override when a tab switch unmounts the panel', async () => {
    // PERF-08: a Radix tab panel unmounts when another tab is selected. The draft lives outside the
    // tree, keyed per instance, precisely so an accidental tab switch cannot discard it.
    openAs('R1', '/instances/inst-collab');
    const instance = detailOf('inst-collab');
    const view = render(
      <ApiProvider>
        <EnvironmentTab instance={instance} canEdit />
      </ApiProvider>,
    );

    await screen.findByText('ADMIN_EMAIL');
    fireEvent.click(within(rowOf('ADMIN_EMAIL')).getByRole('button', { name: 'Change' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('New value'), {
      target: { value: 'half-typed@seamnex.local' },
    });

    view.unmount();
    render(
      <ApiProvider>
        <EnvironmentTab instance={instance} canEdit />
      </ApiProvider>,
    );

    const reopened = await screen.findByRole('dialog');
    expect((within(reopened).getByLabelText('New value') as HTMLInputElement).value).toBe(
      'half-typed@seamnex.local',
    );

    // Leave the module-scope draft map empty for the next case in this file.
    fireEvent.click(within(reopened).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
