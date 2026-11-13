import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * FR-4.4 / FR-2.4. The directory mirror is read-only evidence for an auditor and a write surface
 * only for the platform administrator: disabling a user is a typed confirmation, and a group's
 * durable mapping is never rewritten by a sync cycle.
 */
describe('user inventory', () => {
  it('counts the directory and searches it on the server', async () => {
    openAs('R2', '/admin/users');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Users' })).toBeDefined();
    const users = getState().users;
    expect(await screen.findByText(`${users.length} users`)).toBeDefined();
    expect(
      screen.getByText(`${users.filter((user) => !user.enabled).length} disabled`),
    ).toBeDefined();
    expect(
      screen.getByText(`${users.filter((user) => !user.mfaEnrolled).length} without MFA`),
    ).toBeDefined();

    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'vogel' } });

    await waitFor(() => expect(screen.queryByText('Sofia Almeida')).toBeNull());
    expect(await screen.findByText('Mara Vogel')).toBeDefined();
  });

  it('explains a search that matches nobody', async () => {
    openAs('R1', '/admin/users');
    render(<App />);
    await screen.findByRole('heading', { name: 'Users' });

    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'zzz' } });

    expect(await screen.findByText('No directory users match')).toBeDefined();
  });

  it('reports an unreadable directory instead of an empty list', async () => {
    server.use(http.get('/api/v1/admin/users', () => HttpResponse.error()));

    openAs('R1', '/admin/users');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
    expect(screen.queryByText('No directory users match')).toBeNull();
  });

  it('marks a disabled account and one without MFA', async () => {
    openAs('R1', '/admin/users');
    render(<App />);
    await screen.findByRole('heading', { name: 'Users' });

    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getByText('Mila Novak')).toBeDefined());
    expect(within(table).getAllByText('Disabled').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('not enrolled').length).toBeGreaterThan(0);
  });

  it('opens a user from the row link', async () => {
    openAs('R1', '/admin/users');
    render(<App />);
    await screen.findByRole('heading', { name: 'Users' });
    await screen.findByText('Sofia Almeida');

    const link = present(
      screen.getAllByRole('link', { name: /sofia\.almeida@seamnex\.local/ })[0],
      'the row link for Sofia Almeida',
    );
    expect(link.getAttribute('href')).toBe('/admin/users/usr-sofia');
  });

  it('keeps the directory out of a role without identity.view_users', async () => {
    openAs('R3', '/admin/users');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });
});

describe('user detail and offboarding', () => {
  it('enumerates the provider record and the product entitlements', async () => {
    openAs('R1', '/admin/users/usr-sofia');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Sofia Almeida' })).toBeDefined();
    expect(screen.getByText('Provider record')).toBeDefined();
    expect(screen.getByText('sofia.almeida')).toBeDefined();
    expect(screen.getByText('Product entitlements')).toBeDefined();
    expect(
      await screen.findByText('Enumerated before disabling, so nothing is revoked silently.'),
    ).toBeDefined();
  });

  it('requires the username to be typed before disabling', async () => {
    openAs('R1', '/admin/users/usr-sofia');
    render(<App />);
    await screen.findByRole('heading', { name: 'Sofia Almeida' });

    fireEvent.click(screen.getByRole('button', { name: 'Disable user' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Disable Sofia Almeida?')).toBeDefined();
    expect(within(dialog).getByText(/product entitlements will be revoked/)).toBeDefined();

    const confirm = within(dialog).getByRole('button', { name: 'Disable user' });
    expect(confirm.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Type sofia\.almeida to continue/), {
      target: { value: 'sofia.almeida' },
    });
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
    fireEvent.click(confirm);

    expect(await screen.findByText(/Disabled at /)).toBeDefined();
    expect(screen.getByText(/platform sessions terminated/)).toBeDefined();
    expect(getState().users.find((user) => user.id === 'usr-sofia')?.enabled).toBe(false);
  });

  it('cannot disable an already disabled account', async () => {
    openAs('R1', '/admin/users/usr-mila-novak');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Mila Novak' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Disable user' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('offers no disable action to an auditor and says why', async () => {
    openAs('R2', '/admin/users/usr-sofia');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Sofia Almeida' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Disable user' })).toBeNull();
    expect(screen.getByText(/R2 can read this evidence but cannot disable a user/)).toBeDefined();
  });

  it('explains a user that does not exist', async () => {
    openAs('R1', '/admin/users/usr-unknown');
    render(<App />);

    expect(await screen.findByText('User not found')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('reports a refused disable without losing the evidence', async () => {
    server.use(
      http.post('/api/v1/admin/users/:id/disable', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Disabling a user needs the platform administrator',
            status: 403,
            detail: 'identity.manage_users must be held outright.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the platform administrator.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/admin/users/usr-sofia');
    render(<App />);
    await screen.findByRole('heading', { name: 'Sofia Almeida' });

    fireEvent.click(screen.getByRole('button', { name: 'Disable user' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Type sofia\.almeida to continue/), {
      target: { value: 'sofia.almeida' },
    });
    const confirm = within(dialog).getByRole('button', { name: 'Disable user' });
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
    fireEvent.click(confirm);

    expect(
      await screen.findByText('Disabling a user needs the platform administrator'),
    ).toBeDefined();
  });
});

describe('group mappings', () => {
  it('states each durable mapping and flags propagation', async () => {
    openAs('R1', '/admin/groups');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Groups and role mappings' })).toBeDefined();
    expect(await screen.findByText('/domain/revenue-owners')).toBeDefined();
    expect(screen.getAllByText('propagates').length).toBeGreaterThan(0);
    expect(screen.getAllByText('R3').length).toBeGreaterThan(0);
  });

  it('saves a changed mapping and closes the editor', async () => {
    openAs('R1', '/admin/groups');
    render(<App />);
    await screen.findByText('/domain/revenue-owners');

    const row = present(
      screen.getByText('/domain/revenue-owners').closest('tr'),
      'the mapping row for /domain/revenue-owners',
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Edit mapping' }));

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/^Mapping · /)).toBeDefined();

    fireEvent.change(within(drawer).getByLabelText('Platform role'), {
      target: { value: 'R2' },
    });
    fireEvent.change(within(drawer).getByLabelText('Scope label'), {
      target: { value: 'Core Operations' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save mapping' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const updated = getState().groups.find((group) => group.path === '/domain/revenue-owners');
    expect(updated?.mapping?.role).toBe('R2');
    expect(updated?.mapping?.scopeLabel).toBe('Core Operations');
  });

  it('reports a refused mapping update inside the drawer', async () => {
    server.use(
      http.put('/api/v1/admin/groups/:id/mapping', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/forbidden',
            title: 'Changing a mapping needs the platform administrator',
            status: 403,
            detail: 'identity.manage_groups must be held outright.',
            code: 'FORBIDDEN',
            fieldErrors: [],
            remediation: 'Ask the platform administrator.',
          },
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/admin/groups');
    render(<App />);
    await screen.findByText('/domain/revenue-owners');

    const row = present(
      screen.getByText('/domain/revenue-owners').closest('tr'),
      'the mapping row for /domain/revenue-owners',
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Edit mapping' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save mapping' }));

    expect(
      await within(drawer).findByText('Changing a mapping needs the platform administrator'),
    ).toBeDefined();
  });

  it('marks a group without a durable mapping', async () => {
    const group = present(getState().groups[0], 'a directory group');
    group.mapping = null;

    openAs('R1', '/admin/groups');
    render(<App />);

    expect(await screen.findByText('unmapped')).toBeDefined();
  });

  it('offers a refresh when the directory mirrored nothing', async () => {
    getState().groups = [];

    openAs('R1', '/admin/groups');
    render(<App />);

    expect(await screen.findByText('No directory groups')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Refresh groups' })).toBeDefined();
  });

  it('reports unreadable groups as a problem panel', async () => {
    server.use(http.get('/api/v1/admin/groups', () => HttpResponse.error()));

    openAs('R1', '/admin/groups');
    render(<App />);

    expect(await screen.findByText('The platform API could not be reached')).toBeDefined();
  });

  it('is restricted to an outright grant of identity.manage_groups', async () => {
    openAs('R3', '/admin/groups');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
    expect(screen.getByText(/capability: identity\.manage_groups/)).toBeDefined();
  });
});
