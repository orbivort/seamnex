import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The edge of the directory evidence: what the screens say about a record that is missing the
 * ordinary parts (a group list, a login, an entitlement), and what an editor does when a group has
 * no durable mapping yet. None of it may read as "nothing is wrong" — an empty cell and an unmapped
 * group are both statements the operator acts on.
 */
function user(id: string) {
  const found = getState().users.find((item) => item.id === id);
  if (!found) throw new Error(`fixture ${id} is missing`);
  return found;
}

/** The table row that renders a group's directory path — where its editor button lives. */
async function rowFor(path: string) {
  const cell = await screen.findByText(path);
  const row = cell.closest('tr');
  if (row === null) throw new Error(`${path} is not rendered in a table row`);
  return row;
}

describe('user inventory edges', () => {
  it('prints a dash and "never" for a user with no groups and no login', async () => {
    // `groups.join(', ')` returns an empty string for an empty list, which would leave a blank cell
    // that looks like a rendering bug rather than "this account is in no group".
    const sofia = user('usr-sofia');
    sofia.groups = [];
    sofia.lastLoginAt = null;

    openAs('R1', '/admin/users');
    render(<App />);

    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getByText('Sofia Almeida')).toBeDefined());
    expect(within(table).getByText('—')).toBeDefined();
    expect(within(table).getByText('never')).toBeDefined();
  });
});

describe('user detail edges', () => {
  it('states an empty group list and a login that never happened', async () => {
    const sofia = user('usr-sofia');
    sofia.groups = [];
    sofia.lastLoginAt = null;

    openAs('R1', '/admin/users/usr-sofia');
    render(<App />);

    await screen.findByRole('heading', { name: 'Sofia Almeida' });
    expect(screen.getByText('—')).toBeDefined();
    expect(screen.getByText('Never')).toBeDefined();
  });

  it('says disabling revokes nothing when no product entitlement is enumerated', async () => {
    // The offboarding screen is evidence: "0 entitlements" must be said out loud, because the
    // operator is about to disable the account believing it will cut access.
    user('usr-sofia').entitlementCount = 0;

    openAs('R1', '/admin/users/usr-sofia');
    render(<App />);

    expect(await screen.findByText('No product entitlements')).toBeDefined();
    expect(screen.getByText(/revokes nothing in the products/)).toBeDefined();
  });

  it('re-reads the provider record when the reader asks it to retry', async () => {
    // A refused read is a whole-screen return, so the only way out has to be that retry control.
    let attempts = 0;
    server.use(
      http.get('/api/v1/admin/users/:id', () => {
        attempts += 1;
        return HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/not-found',
            title: 'User not found',
            status: 404,
            detail: 'The identity-provider user no longer exists.',
            code: 'USER_NOT_FOUND',
            fieldErrors: [],
            remediation: 'Refresh the user list.',
          },
          { status: 404 },
        );
      }),
    );

    openAs('R1', '/admin/users/usr-sofia');
    render(<App />);

    expect(await screen.findByText('User not found')).toBeDefined();
    // A 4xx is a decision, so the query does not retry it on its own.
    expect(attempts).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(attempts).toBe(2));
  });
});

describe('group mapping editor', () => {
  it('starts an unmapped group at the baseline role and scope', async () => {
    // A group with no mapping is the case an administrator opens the editor for; the form must
    // offer sane defaults instead of rendering `undefined` into the select and the text field.
    const [group] = getState().groups;
    if (group === undefined) throw new Error('the fixture has no directory groups');
    group.mapping = null;

    openAs('R1', '/admin/groups');
    render(<App />);

    const row = await rowFor('/platform-admins');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit mapping' }));
    const drawer = await screen.findByRole('dialog');

    expect(within(drawer).getByText('Mapping · Platform administrators')).toBeDefined();
    expect((within(drawer).getByLabelText('Platform role') as HTMLSelectElement).value).toBe('R5');
    expect((within(drawer).getByLabelText('Scope type') as HTMLSelectElement).value).toBe(
      'platform',
    );
    expect((within(drawer).getByLabelText('Scope label') as HTMLInputElement).value).toBe(
      'Platform',
    );
    expect(
      (within(drawer).getByLabelText(/Propagate the role into the product/) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it('abandons a half-edited mapping without writing it', async () => {
    // Cancel is the only way out that keeps a durable mapping intact; it must not save what the
    // form currently shows.
    openAs('R1', '/admin/groups');
    render(<App />);

    const row = await rowFor('/domain/revenue-owners');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit mapping' }));
    const drawer = await screen.findByRole('dialog');

    fireEvent.change(within(drawer).getByLabelText('Scope type'), {
      target: { value: 'instance' },
    });
    fireEvent.click(within(drawer).getByLabelText(/Propagate the role into the product/));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const stored = getState().groups.find((item) => item.path === '/domain/revenue-owners');
    expect(stored?.mapping?.scopeType).toBe('domain');
    expect(stored?.mapping?.propagateToProduct).toBe(true);
  });

  it('closes on its own close control and reopens on the stored mapping', async () => {
    // The close control and Escape go through the same `onOpenChange`; a drawer that kept its draft
    // would show the abandoned edit the next time the row is opened.
    openAs('R1', '/admin/groups');
    render(<App />);

    const row = await rowFor('/domain/revenue-owners');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit mapping' }));
    const drawer = await screen.findByRole('dialog');

    fireEvent.change(within(drawer).getByLabelText('Platform role'), { target: { value: 'R2' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close panel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(row).getByRole('button', { name: 'Edit mapping' }));
    const reopened = await screen.findByRole('dialog');
    expect((within(reopened).getByLabelText('Platform role') as HTMLSelectElement).value).toBe(
      'R3',
    );
  });

  it('re-reads the directory from the empty state instead of reloading', async () => {
    // "No directory groups" is a statement about the sync, so the only action that helps is another
    // read of the same query — not a page reload that loses the operator's place.
    const mirrored = getState().groups;
    getState().groups = [];

    openAs('R1', '/admin/groups');
    render(<App />);
    expect(await screen.findByText('No directory groups')).toBeDefined();

    getState().groups = mirrored;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh groups' }));

    expect(await screen.findByText('/platform-admins')).toBeDefined();
    expect(screen.queryByText('No directory groups')).toBeNull();
  });
});
