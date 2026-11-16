import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * FR-1.26 / AC-51 — the profile surface.
 *
 * The screen exists because a profile value is not always honoured: the variable's declaration caps
 * who may set it, and a value above the ceiling is refused rather than applied. Every assertion below
 * is about a fact the operator can act on — which entry declares the variable, which ceiling applies,
 * who may write, and what a delete would break.
 */
describe('environment profiles', () => {
  it('lists the profiles, the declaring entries and the ceiling of a value', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Environment profiles' })).toBeDefined();
    expect(await screen.findByRole('button', { name: /Production/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Staging/ })).toBeDefined();

    // The production profile's relay host is capped at "profile only" by its declaration.
    expect(await screen.findByText('SMTP_HOST')).toBeDefined();
    expect(screen.getAllByText('Profile only').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Declared by D01-01/).length).toBeGreaterThan(0);
  });

  it('marks a value the declaration forbids as inert and says why', async () => {
    const production = getState().profiles.find((profile) => profile.key === 'production');
    if (!production) throw new Error('the production profile fixture is missing');
    // WP_HOME is declared once, at ceiling `none`: a profile may not set it at all.
    production.values = [
      ...production.values,
      { varName: 'WP_HOME', value: 'https://shop', secretRef: null },
    ];

    openAs('R1', '/admin/environment-profiles');
    render(<App />);

    expect(await screen.findByText('WP_HOME')).toBeDefined();
    expect(
      screen.getByText('Declared as not overridable; the API refuses this value.'),
    ).toBeDefined();
    // The row still offers removal, because a stale value must be deletable.
    expect(screen.getByRole('button', { name: 'Remove WP_HOME' })).toBeDefined();
  });

  it('keeps the button busy while a write is in flight, in both dialogs', async () => {
    // A write that looks finished invites a second one. Both dialogs label the button while pending.
    server.use(
      http.post('/api/v1/env-profiles', async () => {
        await delay(200);
        return Response.json({
          key: 'slow',
          name: 'Slow',
          target: 'production',
          updatedBy: 'alice',
          updatedAt: '2026-02-01T00:00:00.000Z',
          values: [],
        });
      }),
      http.post('/api/v1/env-profiles/:key/requests', async () => {
        await delay(200);
        return Response.json({ id: 'ar-slow' });
      }),
    );

    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    fireEvent.change(await screen.findByLabelText(/Key/), { target: { value: 'slow' } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Slow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));

    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDefined();
  });

  it('labels the request action while the approval is being filed', async () => {
    server.use(
      http.post('/api/v1/env-profiles/:key/requests', async () => {
        await delay(200);
        return Response.json({ id: 'ar-slow' });
      }),
    );

    openAs('R3', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(await screen.findByRole('button', { name: 'Request a profile change' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/What should change/), {
      target: { value: 'SMTP_HOST needs the staging relay.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'File request' }));

    expect(await within(dialog).findByRole('button', { name: 'Filing…' })).toBeDefined();
  });

  it('refuses a delete that an instance still depends on, and names them', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(await screen.findByRole('button', { name: /Delete profile/ }));

    // The dialog states the dependency before the operator types the key.
    expect(await screen.findByText(/instance\(s\) still deploy with production/)).toBeDefined();
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/to continue/), {
      target: { value: 'production' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete profile' }));

    expect(
      (await screen.findAllByText(/Instances still deploy with "production"/)).length,
    ).toBeGreaterThan(0);
    expect(getState().profiles.some((profile) => profile.key === 'production')).toBe(true);
  });

  it('deletes a profile no instance uses', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(await screen.findByRole('button', { name: /Staging/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Delete profile/ }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/to continue/), {
      target: { value: 'staging' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete profile' }));

    await waitFor(() =>
      expect(getState().profiles.some((profile) => profile.key === 'staging')).toBe(false),
    );
  });

  it('adds a value through the profile value editor', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(await screen.findByRole('button', { name: 'Add value' }));
    // ADMIN_EMAIL is not yet in the production profile, so the picker offers it.
    fireEvent.change(await screen.findByLabelText('Variable'), {
      target: { value: 'ADMIN_EMAIL' },
    });
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'ops@seamnex.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

    await waitFor(() => {
      const production = getState().profiles.find((profile) => profile.key === 'production');
      expect(production?.values.find((value) => value.varName === 'ADMIN_EMAIL')?.value).toBe(
        'ops@seamnex.example',
      );
    });
  });

  it('creates a profile and selects it', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    fireEvent.change(await screen.findByLabelText(/Key/), { target: { value: 'preview' } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Preview' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));

    expect(await screen.findByRole('heading', { name: 'Preview' })).toBeDefined();
    expect(getState().profiles.some((profile) => profile.key === 'preview')).toBe(true);
  });

  it('offers a request path instead of a dead action for a request-only role', async () => {
    openAs('R3', '/admin/environment-profiles');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Environment profiles' })).toBeDefined();
    // AC-51: the write affordances stay disabled with a reason, and the approval path is offered.
    expect(screen.getByRole('button', { name: 'New profile' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/may read profiles and file a change request/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Request a profile change' })).toBeDefined();
  });

  it('files a change request that an administrator can then decide', async () => {
    openAs('R3', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(await screen.findByRole('button', { name: 'Request a profile change' }));
    const dialog = await screen.findByRole('dialog');
    // A request without a reason cannot be decided, so the action stays closed until one is given.
    expect(
      within(dialog).getByRole('button', { name: 'File request' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/What should change/), {
      target: { value: 'SMTP_HOST must point at the staging relay.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'File request' }));

    // The request lands in the same governance queue a single-instance override uses.
    await waitFor(() => {
      const [filed] = getState().accessRequests;
      expect(filed?.justification).toBe('SMTP_HOST must point at the staging relay.');
      expect(filed?.target).toContain('production');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the target selector and the delete honest for a role that may not write', async () => {
    openAs('R3', '/admin/environment-profiles');
    render(<App />);

    expect(await screen.findByLabelText('Lifecycle target')).toBeDefined();
    const target = screen.getByLabelText('Lifecycle target');
    expect(target.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete profile' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Add value' }).hasAttribute('disabled')).toBe(true);
  });

  it('moves a profile to another lifecycle target', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    const target = await screen.findByLabelText('Lifecycle target');

    fireEvent.change(target, { target: { value: 'staging' } });

    await waitFor(() => {
      const production = getState().profiles.find((profile) => profile.key === 'production');
      expect(production?.target).toBe('staging');
    });
  });

  it('edits a value in place and keeps the other values', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    const row = (await screen.findByText('SMTP_PORT')).closest('tr');
    if (row === null) throw new Error('the SMTP_PORT row is missing');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    // The variable is the row being edited: changing it would be a different write.
    expect((screen.getByLabelText('Variable') as HTMLSelectElement).disabled).toBe(true);
    const value = screen.getByLabelText('Value') as HTMLInputElement;
    expect(value.value).toBe('587');
    fireEvent.change(value, { target: { value: '2525' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

    await waitFor(() => {
      const production = getState().profiles.find((profile) => profile.key === 'production');
      expect(production?.values.find((item) => item.varName === 'SMTP_PORT')?.value).toBe('2525');
      // The replacement is the whole list, so the sibling value must survive it.
      expect(production?.values.some((item) => item.varName === 'SMTP_HOST')).toBe(true);
    });
  });

  it('refuses to save a variable every entry caps at none, and says where to fix it', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(await screen.findByRole('button', { name: 'Add value' }));
    fireEvent.change(await screen.findByLabelText('Variable'), {
      target: { value: 'WP_HOME' },
    });

    expect(await screen.findByText('This variable cannot be set from a profile')).toBeDefined();
    expect(screen.getByText(/Change the declaration in the catalog/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save value' }).hasAttribute('disabled')).toBe(true);
  });

  it('names a value no entry declares instead of inventing a ceiling', async () => {
    const production = getState().profiles.find((profile) => profile.key === 'production');
    if (!production) throw new Error('the production profile fixture is missing');
    production.values = [
      ...production.values,
      { varName: 'LEGACY_FLAG', value: 'on', secretRef: null },
    ];

    openAs('R1', '/admin/environment-profiles');
    render(<App />);

    expect(await screen.findByText('LEGACY_FLAG')).toBeDefined();
    expect(screen.getByText('No entry declares this variable')).toBeDefined();
    expect(screen.getByText('undeclared')).toBeDefined();
  });

  it('removes one value through the same whole-list write', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(await screen.findByRole('button', { name: 'Remove SMTP_PORT' }));

    await waitFor(() => {
      const production = getState().profiles.find((profile) => profile.key === 'production');
      expect(production?.values.some((item) => item.varName === 'SMTP_PORT')).toBe(false);
    });
  });

  it('resets the create form when the dialog is cancelled', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    fireEvent.change(await screen.findByLabelText(/Key/), { target: { value: 'preview' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    // A half-typed key is not a draft: reopening starts from an empty form.
    expect(((await screen.findByLabelText(/Key/)) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Create profile' }).hasAttribute('disabled')).toBe(
      true,
    );

    // Escape is the other way out, and it must drop the draft as well.
    fireEvent.change(screen.getByLabelText(/Key/), { target: { value: 'again' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    expect(((await screen.findByLabelText(/Key/)) as HTMLInputElement).value).toBe('');
  });

  it('asks for a profile when the query returns none, and offers the first one', async () => {
    getState().profiles = [];

    openAs('R1', '/admin/environment-profiles');
    render(<App />);

    expect(await screen.findByText('No environment profile')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Create the first profile' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
  });

  it('selects nothing for a profile key that no longer exists', async () => {
    openAs('R1', '/admin/environment-profiles?profile=deleted-profile');
    render(<App />);

    expect(await screen.findByText('Select a profile')).toBeDefined();
  });

  it('keeps the create dialog open when the key is already taken, and names the conflict', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    fireEvent.change(await screen.findByLabelText(/Key/), { target: { value: 'production' } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Duplicate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));

    // The dialog stays open with the server's reason: the key the operator typed is the thing to change.
    expect((await screen.findAllByText(/already exists/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(getState().profiles.filter((profile) => profile.key === 'production')).toHaveLength(1);
  });

  it('creates a staging profile, because the target decides which lifecycle values apply', async () => {
    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    fireEvent.change(await screen.findByLabelText(/Key/), { target: { value: 'qa-eu' } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'QA EU' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'staging' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));

    await waitFor(() => {
      expect(getState().profiles.find((profile) => profile.key === 'qa-eu')?.target).toBe(
        'staging',
      );
    });
  });

  it('closes the request dialog on escape without keeping the half-written reason', async () => {
    openAs('R3', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(await screen.findByRole('button', { name: 'Request a profile change' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/What should change/), {
      target: { value: 'draft text' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Request a profile change' }));
    // A dismissed draft is not a proposal: the reopened dialog starts empty and unsubmittable.
    const reopened = await screen.findByRole('dialog');
    expect(
      (within(reopened).getByLabelText(/What should change/) as HTMLTextAreaElement).value,
    ).toBe('');
    expect(
      within(reopened).getByRole('button', { name: 'File request' }).hasAttribute('disabled'),
    ).toBe(true);

    // Cancel is the other way out of this dialog, and it drops the text too.
    fireEvent.change(within(reopened).getByLabelText(/What should change/), {
      target: { value: 'abandoned draft' },
    });
    fireEvent.click(within(reopened).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Request a profile change' }));
    const third = await screen.findByRole('dialog');
    expect((within(third).getByLabelText(/What should change/) as HTMLTextAreaElement).value).toBe(
      '',
    );
  });

  it('shows the write in flight, and reports a failed target change in place', async () => {
    // The panel keeps the previous target until the server confirms; a refused patch is a sentence
    // beside the selector, not a silent revert.
    server.use(
      http.patch('/api/v1/env-profiles/:key', async () => {
        await delay(40);
        return new Response(
          JSON.stringify({
            type: 'https://platform.seamnex.local/problems/state_conflict',
            title: 'The target is locked',
            status: 409,
            code: 'STATE_CONFLICT',
            detail: 'The profile has a pending deploy; the target cannot move until it finishes.',
            remediation: 'Wait for the deployment to finish, then change the target.',
          }),
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }),
    );

    openAs('R1', '/admin/environment-profiles');
    render(<App />);
    const target = await screen.findByLabelText('Lifecycle target');

    fireEvent.change(target, { target: { value: 'staging' } });

    expect(await screen.findByText(/The target cannot move|target is locked/)).toBeDefined();
    expect((target as HTMLSelectElement).value).toBe('production');
  });

  it('refuses a justification too short to decide, and keeps the text for editing', async () => {
    openAs('R3', '/admin/environment-profiles');
    render(<App />);
    await screen.findByRole('heading', { name: 'Environment profiles' });

    fireEvent.click(await screen.findByRole('button', { name: 'Request a profile change' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/What should change/), {
      target: { value: 'shorter' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'File request' }));

    expect(
      (await within(dialog).findAllByText(/At least 10 characters|reason to decide/)).length,
    ).toBeGreaterThan(0);
    expect((within(dialog).getByLabelText(/What should change/) as HTMLTextAreaElement).value).toBe(
      'shorter',
    );
  });
});
