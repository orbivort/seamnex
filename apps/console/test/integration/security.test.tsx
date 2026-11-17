import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * NFR-4.16 / NFR-4.6 — the two surfaces the controls are read from.
 *
 * The allow-list panel is the one place a platform owner can see and change what the pull guard
 * enforces, so three things are asserted: the list is shown with the revision that produced it, a
 * change is refused until it carries a reason, and removing a namespace names the products that lose
 * their image rather than warning about "affected deployments" in the abstract.
 *
 * The instance tab exists to keep four states apart — passed, blocked, failed and never scanned — and
 * to show the findings behind a count without fetching every report on mount.
 */
/** `Panel` is a plain `<section>`, so the heading is the handle; only a labelled section is a region. */
async function panelByTitle(title: string): Promise<HTMLElement> {
  // `heading`, not `text`: the tab strip carries the same words, and the tab is not the panel.
  const heading = await screen.findByRole('heading', { name: title });
  const section = heading.closest('section');
  if (section === null) throw new Error(`no panel headed "${title}"`);
  return section;
}

/** The nearest ancestor that holds both the namespace and its action, whatever the table markup is. */
function rowOf(namespace: string): HTMLElement {
  let node: HTMLElement | null = screen.getByText(namespace).parentElement;
  while (node !== null && within(node).queryByRole('button', { name: 'Remove' }) === null) {
    node = node.parentElement;
  }
  if (node === null) throw new Error(`no row holding "${namespace}"`);
  return node;
}

describe('trusted-registry panel (NFR-4.16)', () => {
  it('shows the revision in force, its entries and the documented images that depend on them', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    // The header states the revision in force, broken across text nodes, so the assertion is on the
    // concatenated content of one element.
    expect(await within(panel).findByText(/Revision 4, 9 entries/)).toBeDefined();
    // The entry table, not a comma-separated blob: an operator reads it row by row.
    expect(await within(panel).findByText('docker.io/mautic')).toBeDefined();
    expect(await within(panel).findByText(/History: 4 recorded revisions/)).toBeDefined();
  });

  it('refuses a change with no namespaces and no reason, naming both', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    fireEvent.click(within(panel).getByRole('button', { name: 'Add namespaces' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Record revision' }));

    const alerts = await screen.findAllByRole('alert');
    const text = alerts.map((alert) => alert.textContent).join(' ');
    expect(text).toContain('Enter at least one namespace.');
    expect(text).toContain('State why the allow-list is changing.');
    // Nothing was sent: the store still holds revision 4.
    expect(getState().trustedRegistries.current.version).toBe(4);
  });

  it('records a revision with the reason the operator typed', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    fireEvent.click(within(panel).getByRole('button', { name: 'Add namespaces' }));
    fireEvent.change(await screen.findByLabelText(/^Namespaces/), {
      target: { value: 'ghcr.io/acme\ndocker.io/acme' },
    });
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: 'Adding the Acme namespaces for the pilot catalogue entry.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record revision' }));

    expect(await screen.findByText(/rev 5 · 11 entries/)).toBeDefined();
    expect(getState().trustedRegistries.current.entries).toContain('ghcr.io/acme');
    // The revision carries the reason, which is what makes it evidence rather than a diff.
    expect(getState().trustedRegistries.history[0]?.note).toContain('Acme namespaces');
  });

  it('names the products a removal would cost their image', async () => {
    // The attribution comes from the catalogue, so the case states the one entry it needs rather than
    // depending on how many fixture entries happen to carry an `imageRef`.
    const template = getState().catalog.find((entry) => entry.key === 'D01-01');
    if (template === undefined) throw new Error('the mock catalogue has no D01-01 to derive from');
    server.use(
      http.get('/api/v1/catalog', () =>
        HttpResponse.json([
          { ...template, key: 'D02-01', product: 'Mautic', imageRef: 'mautic/mautic:5.1.1' },
        ]),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    await within(panel).findByText('docker.io/mautic');
    await within(panel).findByText(/D02-01 Mautic/);
    fireEvent.click(within(rowOf('docker.io/mautic')).getByRole('button', { name: 'Remove' }));

    // Named, not counted: "1 product affected" sends the operator hunting for which one, and the next
    // deploy is the thing that fails.
    expect(await screen.findByText(/These products would lose their image/)).toBeDefined();
    // The callout names the product; the table above it already showed the same words.
    expect(screen.getAllByText(/D02-01 Mautic/).length).toBeGreaterThan(1);
  });
});

/**
 * The allow-list panel's other states: the reader who may not change it, a revision the platform
 * refused, a removal, and the two ways a dialog is dismissed. Each is a place where an operator can
 * come away believing something the platform did not do — the reason the panel is a control and not
 * a view.
 */
describe('trusted-registry panel: who may change it, and what a change costs', () => {
  it('gives a reader the list without either write control', async () => {
    openAs('R2', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    expect(await within(panel).findByText('docker.io/mautic')).toBeDefined();
    // R2 holds `settings.view` and not `settings.manage`: showing a disabled Remove button would
    // suggest the refusal is a state to be worked around rather than a boundary.
    expect(within(panel).queryByRole('button', { name: 'Add namespaces' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('re-reads the allow-list when the operator asks it to', async () => {
    const seeded = getState().trustedRegistries;
    const grown = {
      ...seeded,
      current: {
        ...seeded.current,
        version: 5,
        entries: [...seeded.current.entries, 'ghcr.io/acme'],
      },
    };
    let served = seeded;
    server.use(
      http.get('/api/v1/security/trusted-registries', () => {
        const body = served;
        served = grown;
        return HttpResponse.json(body);
      }),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    expect(await within(panel).findByText(/Revision 4, 9 entries/)).toBeDefined();

    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh the allow-list' }));

    // The revision in force, and the entries it carries: a refresh that re-read only one of them
    // would leave the table and its header disagreeing.
    expect(await within(panel).findByText(/Revision 5, 10 entries/)).toBeDefined();
    expect(await within(panel).findByText('ghcr.io/acme')).toBeDefined();
  });

  it('shows a refused revision as a problem and keeps the dialog open', async () => {
    server.use(
      http.post('/api/v1/security/trusted-registries', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/validation',
            title: 'The allow-list already matches that change',
            status: 422,
            detail: 'Version 4 already holds every entry in the request.',
            code: 'VALIDATION_FAILED',
            fieldErrors: [],
            remediation: 'Add an entry that is not present, or remove one that is.',
          },
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    fireEvent.click(within(panel).getByRole('button', { name: 'Add namespaces' }));
    fireEvent.change(await screen.findByLabelText(/^Namespaces/), {
      target: { value: 'docker.io/mautic' },
    });
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: 'Re-stating a namespace that is already trusted.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record revision' }));

    // A dialog that closed on a refusal would read as a recorded revision; the reason the platform
    // gave is what the operator acts on.
    expect(await screen.findByText('The allow-list already matches that change')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(getState().trustedRegistries.current.version).toBe(4);
  });

  it('records a removal as a new revision that no longer trusts the namespace', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    await within(panel).findByText('docker.io/mautic');
    fireEvent.click(within(rowOf('docker.io/mautic')).getByRole('button', { name: 'Remove' }));

    const dialog = await screen.findByRole('dialog');
    // Removing arms the dialog with the namespace it is about, so the operator cannot have to retype
    // the value the row already named — and cannot remove a different one by mistyping it.
    expect(within(dialog).getByLabelText(/^Namespaces/)).toHaveProperty(
      'value',
      'docker.io/mautic',
    );
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: 'Mautic was republished under a private registry; nothing pulls this one.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record revision' }));

    expect(await screen.findByText(/rev 5 · 8 entries/)).toBeDefined();
    expect(getState().trustedRegistries.current.entries).not.toContain('docker.io/mautic');
    // The removal is a revision like any other, and it carries the reason it was made.
    expect(getState().trustedRegistries.history[0]?.note).toContain('private registry');
  });

  it('closes the dialog from its own control and from Cancel', async () => {
    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    await within(panel).findByText('docker.io/mautic');

    fireEvent.click(within(panel).getByRole('button', { name: 'Add namespaces' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Dismissing an armed revision must not record it: the panel still shows revision 4.
    fireEvent.click(within(panel).getByRole('button', { name: 'Add namespaces' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getState().trustedRegistries.current.version).toBe(4);
  });

  it('attributes a namespace once even when the catalog lists the same entry twice', async () => {
    const template = getState().catalog.find((entry) => entry.key === 'D02-01');
    if (template === undefined) throw new Error('the mock catalogue has no D02-01 to derive from');
    const entry = { ...template, imageRef: 'mautic/mautic:5.1.1' };
    server.use(http.get('/api/v1/catalog', () => HttpResponse.json([entry, entry])));

    openAs('R1', '/governance/posture');
    render(<App />);

    // A repeated catalogue row must not read as two products: the cell names what depends on the
    // namespace, and the same entry appearing twice is one dependency.
    const panel = await panelByTitle('Trusted registry allow-list');
    await within(panel).findByText('docker.io/mautic');
    const cell = await within(rowOf('docker.io/mautic')).findByText('D02-01 Mautic');
    expect(cell).toBeDefined();
  });
});

describe('image security tab (NFR-4.6, S-10)', () => {
  it('reports a blocked image with its severity counts', async () => {
    openAs('R1', '/instances/inst-collab');
    render(<App />);

    // The tab strip activates on mousedown (the house `Tabs` primitive), not on click.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Image security' }));

    const panel = await panelByTitle('Image security');
    expect(await within(panel).findByText('blocked')).toBeDefined();
    // A blocking severity is counted, not summarised: two critical findings read differently from two
    // hundred mediums.
    expect(await within(panel).findByTitle('2 critical')).toBeDefined();
    expect(within(panel).getByTitle('7 high')).toBeDefined();
  });

  it('shows the findings of the image whose drawer is open, and only then', async () => {
    openAs('R1', '/instances/inst-collab');
    render(<App />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Image security' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Findings' }));

    expect(await screen.findByText('CVE-2026-31884')).toBeDefined();
    expect(screen.getByText('libxml2')).toBeDefined();
    expect(screen.getByText(/This image blocked a deployment/)).toBeDefined();
  });

  it('gives a scoped reader the tab, because a scoped grant is still a grant', async () => {
    openAs('R3', '/instances/inst-collab');
    render(<App />);

    // R3 holds `instance.view_logs` scoped, and the report binds to that same capability. A tab
    // hidden from a role the API would answer is the other half of the defect: the operator reads
    // "no findings" where the platform has a report.
    expect(await screen.findByRole('tab', { name: 'Image security' })).toBeDefined();
  });
});
