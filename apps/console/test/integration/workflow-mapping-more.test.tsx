import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * FR-5.5 — the authoring aids around the ledger.
 *
 * The happy path (pick a field from the last run and save) is covered in
 * `workflow-mapping-workbench.test.tsx`. What is left are the decisions an author makes when the
 * sample is pasted, incomplete or unreadable: matching a whole sample by name, adding a row by hand,
 * switching the node's operation, and refreshing the target schema.
 */
async function openDrawer(
  path: string,
  heading: string,
  nodeName: RegExp,
  button = 'Map fields',
): Promise<HTMLElement> {
  openAs('R1', path);
  render(<App />);
  await screen.findByRole('heading', { name: heading });
  fireEvent.click(await screen.findByRole('button', { name: nodeName }));
  fireEvent.click(await screen.findByRole('button', { name: button }));
  return screen.findByRole('dialog');
}

function writeNode(id: string, nodeId: string) {
  const workflow = getState().workflows.find((item) => item.id === id);
  const node = workflow?.nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) throw new Error(`fixture node ${nodeId} is missing`);
  return node;
}

/**
 * A pasted sample whose leaf names line up with two of EspoCRM's fields, plus one the operation
 * does not accept — the mix "match all by name" has to survive.
 */
const SAMPLE = JSON.stringify({
  lead: { emailAddress: 'ops@northwind.example', lastName: 'Chen', country: 'DE' },
});

describe('mapping workbench aids', () => {
  it('matches every sampled field whose name the product publishes, and saves the list', async () => {
    // Start from an empty ledger so "match all" is the only thing filling it.
    writeNode('wf-lead-capture', 'lead-create').mappings = [];
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    // The paste rail feeds the matcher; the last run is used elsewhere.
    fireEvent.change(within(drawer).getByLabelText('Sample item JSON'), {
      target: { value: SAMPLE },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Match all by name' }));

    // `lead.emailAddress` and `lead.lastName` are the sampled paths EspoCRM names; `lead.country`
    // is not a field the operation accepts, so it is left for the author to name by hand.
    expect(await within(drawer).findByDisplayValue('lead.emailAddress')).toBeDefined();
    expect(
      within(drawer).getByText(/"emailAddress": "\{\{ \$json\.lead\.emailAddress \}\}"/),
    ).toBeDefined();
    expect(within(drawer).getByText(/2 mapped/)).toBeDefined();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Save mapping' }));

    await waitFor(() =>
      expect(writeNode('wf-lead-capture', 'lead-create').mappings.map((row) => row.to)).toEqual([
        'emailAddress',
        'lastName',
      ]),
    );
    expect((await within(drawer).findAllByText('2 mappings saved.')).length).toBe(2);
  });

  it('removes a row, unchecks a mapped field and adds a row by hand', async () => {
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Remove mapping 1' }));
    expect(within(drawer).getByText('No field mapping yet')).toBeDefined();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Add a row manually' }));
    fireEvent.change(within(drawer).getByLabelText('Source path 1'), {
      target: { value: 'lead.email' },
    });
    fireEvent.change(within(drawer).getByLabelText('Target field 1'), {
      target: { value: 'emailAddress' },
    });
    expect(
      within(drawer).getByText(/"emailAddress": "\{\{ \$json\.lead\.email \}\}"/),
    ).toBeDefined();

    // Checking the sampled path again now matches the row that was just typed, so unchecking it
    // removes the row rather than adding a duplicate.
    fireEvent.change(within(drawer).getByLabelText('Sample item JSON'), {
      target: { value: SAMPLE },
    });
    const consent = within(drawer).getByRole('checkbox', { name: /lead\.country/ });
    fireEvent.click(consent);
    expect(within(drawer).getByRole('checkbox', { name: /lead\.country/ })).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(within(drawer).getByRole('checkbox', { name: /lead\.country/ }));
    expect(within(drawer).getByRole('checkbox', { name: /lead\.country/ })).toHaveProperty(
      'checked',
      false,
    );
  });

  it('filters the field list and adds every unmapped field in one click', async () => {
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );
    fireEvent.change(within(drawer).getByLabelText('Sample item JSON'), {
      target: { value: SAMPLE },
    });

    const filter = within(drawer).getByLabelText('Filter fields');
    fireEvent.change(filter, { target: { value: 'country' } });
    expect(within(drawer).getAllByRole('checkbox')).toHaveLength(1);

    fireEvent.change(filter, { target: { value: 'nothing-matches' } });
    expect(within(drawer).getByText(/No field matches/)).toBeDefined();

    fireEvent.change(filter, { target: { value: '' } });
    fireEvent.click(within(drawer).getByRole('button', { name: /Add all 3 unmapped fields/ }));
    // The stored `lead.consentSource` mapping is already checked, so the other three are added.
    expect(within(drawer).getByText(/4 mapped/)).toBeDefined();
  });

  it('says a paste is not JSON, and says when a long sample was cut short', async () => {
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );
    const box = within(drawer).getByLabelText('Sample item JSON');

    fireEvent.change(box, { target: { value: '{ "lead": ' } });
    expect(within(drawer).getByRole('alert')).toHaveProperty(
      'textContent',
      'That is not valid JSON. Paste the item exactly as the run shows it.',
    );

    const wide = Object.fromEntries(
      Array.from({ length: 220 }, (_, index) => [`field${index}`, index]),
    );
    fireEvent.change(box, { target: { value: JSON.stringify(wide) } });
    expect(within(drawer).getByText(/only its first entries are listed/)).toBeDefined();
  });

  it('says a node has no captured sample instead of showing an empty list', async () => {
    const drawer = await openDrawer(
      '/workflows/wf-invoice-archive',
      'Invoice archived → notify finance',
      /Post to #finance/,
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Last run' }));
    expect(
      await within(drawer).findByText(/No sample has been captured for this node yet/),
    ).toBeDefined();
  });

  it('says the last run could not be read rather than "no sample"', async () => {
    server.use(http.get('/api/v1/workflows/:id/nodes/:nodeId/sample', () => HttpResponse.error()));
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Last run' }));
    expect(await within(drawer).findByText(/The last run could not be read/)).toBeDefined();
  });

  it('refreshes the target schema live, then asks again on the second click', async () => {
    server.use(
      http.get('/api/v1/workflows/:id/nodes/:nodeId/fields', async ({ params }) => {
        await delay(120);
        return HttpResponse.json({
          nodeId: String(params.nodeId),
          entryKey: 'D01-01',
          operation: 'contacts.write',
          status: 'available',
          fields: [{ name: 'lastName', label: 'Last name', type: 'string', required: true }],
          fetchedAt: new Date().toISOString(),
          detail: null,
        });
      }),
    );
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    expect(await within(drawer).findByText('schema read')).toBeDefined();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Refresh' }));
    expect(await within(drawer).findByRole('button', { name: 'Refreshing…' })).toBeDefined();
    await within(drawer).findByRole('button', { name: 'Refresh' });

    // The second click is already live for this node, so it re-asks the same question.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Refresh' }));
    expect(await within(drawer).findByRole('button', { name: 'Refreshing…' })).toBeDefined();
  });

  it('rebinds the node to another write operation and explains the missing schema', async () => {
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    const operation = within(drawer).getByLabelText('Write operation');
    // The current operation is already selected; changing to it must not write a no-op patch.
    fireEvent.change(operation, { target: { value: 'contacts.write' } });
    expect(writeNode('wf-lead-capture', 'lead-create').operation).toBe('contacts.write');

    await within(drawer).findByText(/Upsert a contact/);
    fireEvent.change(operation, { target: { value: 'opportunities.write' } });

    await waitFor(() =>
      expect(writeNode('wf-lead-capture', 'lead-create').operation).toBe('opportunities.write'),
    );
    expect(writeNode('wf-lead-capture', 'lead-create').label).toBe('Update opportunity stage');
    expect(await within(drawer).findByText(/was not asked for a schema/)).toBeDefined();
  });

  it('uses the workflow-provided target names when the product publishes no schema', async () => {
    // The mapping node has no product, so the rail offers no operations: it names the field list
    // fallback instead of printing "null".
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Normalise lead fields/,
    );

    expect(
      await within(drawer).findByText(/Platform · Platform — reads from the product/),
    ).toBeDefined();
    expect(within(drawer).getByText('field mapping')).toBeDefined();
  });

  it('warns that saving disables an active workflow', async () => {
    const drawer = await openDrawer(
      '/workflows/wf-won-to-project',
      'Won opportunity → project kickoff',
      /Create work package/,
    );

    expect(
      await within(drawer).findByText(/Saving a mapping disables this active workflow/),
    ).toBeDefined();
  });

  it('reports a mapping save and an operation change that the platform refused', async () => {
    server.use(
      http.put('/api/v1/workflows/:id/nodes/:nodeId/mappings', () => HttpResponse.error()),
      http.patch('/api/v1/workflows/:id/nodes/:nodeId', () => HttpResponse.error()),
    );
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Add row' }));
    fireEvent.change(within(drawer).getByLabelText('Source path 2'), {
      target: { value: 'lead.email' },
    });
    fireEvent.change(within(drawer).getByLabelText('Target field 2'), {
      target: { value: 'emailAddress' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save mapping' }));

    await waitFor(() =>
      expect(within(drawer).getAllByText('The platform API could not be reached').length).toBe(1),
    );

    fireEvent.change(within(drawer).getByLabelText('Write operation'), {
      target: { value: 'opportunities.write' },
    });
    await waitFor(() =>
      expect(within(drawer).getAllByText('The platform API could not be reached').length).toBe(2),
    );
  });
});

describe('read-only mapping without rows', () => {
  it('shows an empty ledger and an empty body to a reviewer', async () => {
    openAs('R2', '/workflows/wf-won-to-project');
    render(<App />);
    await screen.findByRole('heading', { name: 'Won opportunity → project kickoff' });
    fireEvent.click(await screen.findByRole('button', { name: /Deal value/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'View mapping' }));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('No field mapping on this node yet.')).toBeDefined();
    expect(within(drawer).getByText('0 mapped')).toBeDefined();
    expect(within(drawer).getByText('{}')).toBeDefined();
  });
});

describe('sample provenance', () => {
  it('says a node with no inbound edge reads its own output', async () => {
    const workflow = getState().workflows.find((item) => item.id === 'wf-lead-capture');
    if (workflow === undefined) throw new Error('fixture workflow wf-lead-capture is missing');
    workflow.edges = workflow.edges.filter((edge) => edge.target !== 'lead-create');

    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    expect(
      await within(drawer).findByText(/No upstream step: the sample is this node's own output/),
    ).toBeDefined();
  });

  it('says nothing about the step when the inbound edge points at a node that is gone', async () => {
    const workflow = getState().workflows.find((item) => item.id === 'wf-lead-capture');
    if (workflow === undefined) throw new Error('fixture workflow wf-lead-capture is missing');
    workflow.edges = workflow.edges.map((edge) =>
      edge.target === 'lead-create' ? { ...edge, source: 'node-that-is-gone' } : edge,
    );

    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    expect(await within(drawer).findByText(/No upstream step/)).toBeDefined();
  });

  it('names the upstream product step that shapes the sample', async () => {
    const drawer = await openDrawer(
      '/workflows/wf-won-to-project',
      'Won opportunity → project kickoff',
      /Post to #delivery/,
    );

    expect(
      await within(drawer).findByText(
        /Sample comes from Create work package \(D09-01 · work_packages\.write\)/,
      ),
    ).toBeDefined();
  });
});

describe('target coverage', () => {
  it('says a schema is being read before claiming it is unavailable', async () => {
    server.use(
      http.get('/api/v1/workflows/:id/nodes/:nodeId/fields', async ({ params }) => {
        await delay(1000);
        return HttpResponse.json({
          nodeId: String(params.nodeId),
          entryKey: 'D01-01',
          operation: 'contacts.write',
          status: 'available',
          fields: [{ name: 'lastName', label: 'Last name', type: 'string', required: true }],
          fetchedAt: new Date().toISOString(),
          detail: null,
        });
      }),
    );
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    expect(await within(drawer).findByText('reading schema…')).toBeDefined();
    expect(await within(drawer).findByText('schema read')).toBeDefined();
  });

  it('reports a field count, not a coverage fraction, if nothing is required', async () => {
    server.use(
      http.get('/api/v1/workflows/:id/nodes/:nodeId/fields', ({ params }) =>
        HttpResponse.json({
          nodeId: String(params.nodeId),
          entryKey: 'D01-01',
          operation: 'contacts.write',
          status: 'available',
          fields: [{ name: 'description', label: 'Description', type: 'string', required: false }],
          fetchedAt: new Date().toISOString(),
          detail: null,
        }),
      ),
    );
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    expect(
      await within(drawer).findByText('1 field mapped. This operation marks no field as required.'),
    ).toBeDefined();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Add row' }));
    expect(
      within(drawer).getByText('2 fields mapped. This operation marks no field as required.'),
    ).toBeDefined();
  });

  it('explains a missing schema when the product gave no detail of its own', async () => {
    server.use(
      http.get('/api/v1/workflows/:id/nodes/:nodeId/fields', ({ params }) =>
        HttpResponse.json({
          nodeId: String(params.nodeId),
          entryKey: 'D01-01',
          operation: 'contacts.write',
          status: 'unsupported',
          fields: [],
          fetchedAt: new Date().toISOString(),
          detail: null,
        }),
      ),
    );
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    expect(
      await within(drawer).findByText(
        'Bind an operation to this node before its fields can be read.',
      ),
    ).toBeDefined();
  });

  it('reports a schema read that failed instead of falling back silently', async () => {
    server.use(
      http.get('/api/v1/workflows/:id/nodes/:nodeId/fields', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/schema-unavailable',
            title: 'Schema unavailable',
            status: 503,
            detail: 'The product did not answer.',
            code: 'SCHEMA_UNAVAILABLE',
            fieldErrors: [],
            remediation: 'Type the target names by hand.',
          },
          { status: 503 },
        ),
      ),
    );
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    expect(await within(drawer).findByText('Schema unavailable')).toBeDefined();
  });

  it('adds an index path whose leaf is not a name, leaving the target to the author', async () => {
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    fireEvent.change(within(drawer).getByLabelText('Sample item JSON'), {
      target: { value: JSON.stringify({ tags: [] }) },
    });
    fireEvent.click(await within(drawer).findByRole('checkbox', { name: /tags\[0\]/ }));

    // `tags[0]` has no leaf name to guess, so the target stays empty rather than inventing one.
    expect(within(drawer).getByDisplayValue('tags[0]')).toBeDefined();
    expect(within(drawer).queryByDisplayValue('0')).toBeNull();
  });

  it('takes the target guess from the sample when the product publishes no schema', async () => {
    server.use(
      http.get('/api/v1/workflows/:id/nodes/:nodeId/fields', ({ params }) =>
        HttpResponse.json({
          nodeId: String(params.nodeId),
          entryKey: 'D01-01',
          operation: 'contacts.write',
          status: 'unsupported',
          fields: [],
          fetchedAt: new Date().toISOString(),
          detail: 'EspoCRM did not answer.',
        }),
      ),
    );
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    fireEvent.change(within(drawer).getByLabelText('Sample item JSON'), {
      target: { value: JSON.stringify({ lead: { emailAddress: 'ops@northwind.example' } }) },
    });
    fireEvent.click(await within(drawer).findByRole('checkbox', { name: /lead\.emailAddress/ }));

    expect(within(drawer).getByDisplayValue('emailAddress')).toBeDefined();
  });
});

describe('run sample', () => {
  const RUN_SAMPLE = {
    lead: {
      id: 'lead-8841',
      email: 'ops@northwind.example',
      company: 'Northwind',
      consentSource: 'webinar-2026-03',
      fullName: 'Mei Chen',
      country: 'DE',
    },
    event: { type: 'segment.member.added', occurredAt: '2026-11-12T08:41:00Z' },
  };

  it('offers every unmapped field of a truncated run, without inventing a run id', async () => {
    server.use(
      http.get('/api/v1/workflows/:id/nodes/:nodeId/sample', () =>
        HttpResponse.json({
          nodeId: 'lead-create',
          sourceNodeId: 'lead-map',
          runId: null,
          capturedAt: new Date().toISOString(),
          item: RUN_SAMPLE,
          truncated: true,
        }),
      ),
    );
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Last run' }));
    expect(await within(drawer).findByText(/^Captured /)).toBeDefined();
    expect(within(drawer).getByText(/and capped at the size limit/)).toBeDefined();
    expect(within(drawer).queryByText(/· run /)).toBeNull();

    fireEvent.click(
      within(drawer).getByRole('button', { name: /Use all \d+ fields from this run/ }),
    );
    expect(within(drawer).getByText(/^8 mapped/)).toBeDefined();
  });

  it('says a captured item held nothing it could list', async () => {
    server.use(
      http.get('/api/v1/workflows/:id/nodes/:nodeId/sample', () =>
        HttpResponse.json({
          nodeId: 'lead-create',
          sourceNodeId: 'lead-map',
          runId: 'run-2041',
          capturedAt: new Date().toISOString(),
          item: null,
          truncated: false,
        }),
      ),
    );
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Last run' }));
    expect(
      await within(drawer).findByText('Fields appear here once a sample is available.'),
    ).toBeDefined();
  });
});

describe('single-row save', () => {
  it('uses the singular in the confirmation for a one-row ledger', async () => {
    const drawer = await openDrawer(
      '/workflows/wf-lead-capture',
      'Lead captured → CRM contact',
      /Create contact/,
    );

    fireEvent.change(within(drawer).getByLabelText('Target field 1'), {
      target: { value: 'description' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save mapping' }));

    await waitFor(() =>
      expect(writeNode('wf-lead-capture', 'lead-create').mappings).toEqual([
        { from: 'lead.consentSource', to: 'description', transform: null },
      ]),
    );
    expect((await within(drawer).findAllByText('1 mapping saved.')).length).toBe(2);
  });
});
