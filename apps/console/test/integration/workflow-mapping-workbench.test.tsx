import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The end-to-end authoring path, as an operator walks it: open the workflow, select the write node,
 * open the workbench, take the sample the last run captured, pick a field, save, and find the
 * mapping still there after reopening.
 *
 * This is the closest thing to an e2e run this repository has (there is no browser suite): the
 * console talks to the MSW handlers over HTTP, and those handlers write to the same store the
 * workflow detail endpoint reads, so a save that only looked successful fails here.
 */
function writeNode() {
  const workflow = getState().workflows.find((item) => item.id === 'wf-lead-capture');
  if (workflow === undefined) throw new Error('fixture workflow wf-lead-capture is missing');
  const node = workflow.nodes.find((entry) => entry.id === 'lead-create');
  if (node === undefined) throw new Error('fixture write node is missing');
  return node;
}

async function openWorkbench() {
  openAs('R1', '/workflows/wf-lead-capture');
  render(<App />);
  await screen.findByRole('heading', { name: 'Lead captured → CRM contact' });
  fireEvent.click(await screen.findByRole('button', { name: /Create contact/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Map fields' }));
  return screen.findByRole('dialog');
}

describe('mapping workbench end to end', () => {
  it('maps a field from the last run, saves it, and keeps it after reopening', async () => {
    const drawer = await openWorkbench();

    // The sample the mirror captured is offered as-is: no paste, no lookup in n8n.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Last run' }));
    expect(await within(drawer).findByText(/^Captured /)).toBeDefined();

    fireEvent.click(await within(drawer).findByRole('checkbox', { name: /lead\.email/ }));
    fireEvent.change(within(drawer).getByLabelText('Target field 2'), {
      target: { value: 'emailAddress' },
    });

    // The body preview is the compiled request, not a description of it.
    expect(
      within(drawer).getByText(/"emailAddress": "\{\{ \$json\.lead\.email \}\}"/),
    ).toBeDefined();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Save mapping' }));

    await waitFor(() =>
      expect(writeNode().mappings.map((row) => row.to)).toEqual(['consentSource', 'emailAddress']),
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(await screen.findByRole('button', { name: 'Map fields' }));
    const reopened = await screen.findByRole('dialog');
    expect(await within(reopened).findByDisplayValue('lead.email')).toBeDefined();
  });

  it('keeps the caret in the row being typed, so a manual row can be filled in', async () => {
    /*
     * The row key was derived from `from`/`to`, so the first keystroke changed the key and React
     * remounted the `<tr>` — the input the operator was typing into was replaced, focus fell to
     * `<body>`, and "Add row" could not be filled in at all.
     */
    const drawer = await openWorkbench();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Add row' }));
    const source = within(drawer).getByLabelText('Source path 2');
    source.focus();
    expect(document.activeElement).toBe(source);

    fireEvent.change(source, { target: { value: 'd' } });
    expect(document.activeElement).toBe(source);
    fireEvent.change(source, { target: { value: 'ddd' } });
    expect(document.activeElement).toBe(source);

    const target = within(drawer).getByLabelText('Target field 2');
    target.focus();
    fireEvent.change(target, { target: { value: 'l' } });
    expect(document.activeElement).toBe(target);
    fireEvent.change(target, { target: { value: 'lastName' } });
    expect(document.activeElement).toBe(target);
  });

  it('warns that the drawer holds unsaved rows and discards on request', async () => {
    const before = writeNode().mappings.length;
    const drawer = await openWorkbench();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Add row' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Discard' }));

    expect(await screen.findByText('Discard unsaved mappings?')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writeNode().mappings).toHaveLength(before);
  });
});
