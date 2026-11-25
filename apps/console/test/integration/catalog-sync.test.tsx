import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * ADR-BE-42 §10.4 — the dialog's own states, beyond the happy path.
 *
 * The page-level tests cover "a sync happened" and "a refusal was reported". What is left is the
 * confirmation gate: a sync can remove entries, so the primary action must stay disabled until the
 * operator has acknowledged that, and the dialog must not invent a commit it has never recorded.
 */
async function openDialog(mutate?: () => void) {
  openAs('R1', '/catalog');
  // The fixture store is the mock platform's state, so a case adjusts the tree the way an operator
  // would find it — after the session is set up, before the page reads it.
  mutate?.();
  render(<App />);
  await screen.findByText('Domain catalog');
  const trigger = await screen.findByRole('button', { name: 'Sync from source' });
  // The action stays disabled until the checkout view has loaded, so the click has to wait for it:
  // a click on a still-disabled button is silently dropped and the dialog never opens.
  await waitFor(() => {
    expect(trigger.hasAttribute('disabled')).toBe(false);
  });
  fireEvent.click(trigger);
  return screen.findByRole('dialog');
}

describe('catalogue sync dialog', () => {
  it('keeps the primary action disabled until the removal is acknowledged', async () => {
    const dialog = await openDialog();
    const submit = within(dialog).getByRole('button', { name: 'Sync now' });
    const acknowledge = within(dialog).getByRole('checkbox', {
      name: /I understand a sync can remove entries/i,
    });

    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.click(acknowledge);
    expect(submit.hasAttribute('disabled')).toBe(false);

    // Un-ticking withdraws the confirmation, and with it the action.
    fireEvent.click(acknowledge);
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('will not send an empty ref', async () => {
    // The server would refuse it with SOURCE_REF_REQUIRED, but the operator should not have to learn
    // that from a round trip: the field is the input, so emptying it withdraws the action.
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/Tag or commit/i), { target: { value: '   ' } });
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /I understand a sync can remove entries/i }),
    );

    expect(within(dialog).getByRole('button', { name: 'Sync now' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('normalises a gateway error that is not a problem document', async () => {
    // A proxy in front of the API answers with its own HTML or plain-text page. The transport turns
    // that into a problem so the dialog still renders a title, a detail and a repair.
    server.use(
      http.post('/api/v1/catalog/sync', () => HttpResponse.text('Bad Gateway', { status: 502 })),
    );

    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /I understand a sync can remove entries/i }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync now' }));

    // The transport keeps the gateway's own status text as the title, so the operator sees the
    // reason the proxy gave instead of a generic platform message.
    expect(await screen.findByText('Bad Gateway')).toBeDefined();
    expect(screen.getByText(/HTTP 502 without a problem\+json body/)).toBeDefined();
    expect(screen.getByText(/Retry the action\. If it persists/i)).toBeDefined();
  });

  it('closes on cancel without sending anything', async () => {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // No receipt: a cancelled dialog is not a sync, and the page must not imply one.
    expect(screen.queryByText(/Catalogue synced at revision/i)).toBeNull();
  });

  it('says so when no sync has ever been recorded for the tree', async () => {
    // A hand-placed checkout has a revision but no `catalog_commit` row; the dialog must not show a
    // date it does not have.
    const dialog = await openDialog(() => {
      getState().catalogRepository = { ...getState().catalogRepository, commit: null };
    });

    expect(within(dialog).getByText(/No sync has been recorded for this tree/i)).toBeDefined();
  });

  it('accepts a hand-typed ref and reports the receipt for it', async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/Tag or commit/i), {
      target: { value: 'catalog-2026.11.0' },
    });
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /I understand a sync can remove entries/i }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync now' }));

    expect(await screen.findByText(/Catalogue synced at revision/i)).toBeDefined();
  });

  it('reports the fetch as in flight and refuses a second submit until it lands', async () => {
    // A clone can take the better part of a minute, so the dialog has to say it is working and the
    // primary action has to close while it does: two clicks must not queue two fetches.
    let release!: () => void;
    const landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/catalog/sync', async () => {
        await landed;
        // Only the fields the receipt needs; the optional blocks are the mock platform's business.
        return HttpResponse.json({
          reloadedAt: '2026-11-25T00:00:00.000Z',
          revision: '4c1f0d2ab9e7',
          entries: 6,
          added: 0,
          changed: 0,
          removed: 0,
          reconciled: [],
          source: {
            url: 'github.com/orbivort/seamnex-catalog',
            ref: 'catalog-2026.11.0',
            commit: '4c1f0d2ab9e7',
          },
          staged: { pending: [] },
        });
      }),
    );

    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /I understand a sync can remove entries/i }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync now' }));

    const pending = await within(dialog).findByRole('button', { name: 'Syncing…' });
    expect(pending.hasAttribute('disabled')).toBe(true);

    release();
    expect(await screen.findByText(/Catalogue synced at revision/i)).toBeDefined();
  });

  it('replaces a sync receipt with the reload receipt when the operator reloads', async () => {
    // Two actions, one receipt slot: leaving the sync receipt on screen after a reload would
    // describe a tree the last request never touched.
    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /I understand a sync can remove entries/i }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync now' }));
    await screen.findByText(/Catalogue synced at revision/i);

    fireEvent.click(await screen.findByRole('button', { name: 'Reload from repository' }));

    expect(await screen.findByText(/Repository reloaded at revision/i)).toBeDefined();
    expect(screen.queryByText(/Catalogue synced at revision/i)).toBeNull();
  });
});
