import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReadOnlyMapping } from '../../src/features/workflows/field-mapping/read-only-mapping';
import type { DraftRow } from '../../src/features/workflows/field-mapping/use-mapping-draft';

/**
 * FR-5.5 — the mapping of one node for a reviewer.
 *
 * The ledger itself is rendered by `MappingTable`, which is exercised through the app elsewhere. What
 * belongs here is the contract this component has with it: a viewer gets every handler as an inert
 * function, so a future edit cannot reintroduce an editor by wiring a real one.
 */
const invocations: string[] = [];

vi.mock('../../src/features/workflows/field-mapping/mapping-table', () => ({
  MappingTable: (props: Record<string, unknown>) => {
    for (const name of ['onChange', 'onRemove', 'onAddEmpty', 'onPaste', 'onUseRun'] as const) {
      const handler = props[name];
      if (typeof handler === 'function') {
        (handler as (index: number, patch: object) => void)(0, {});
        invocations.push(name);
      }
    }
    return null;
  },
}));

function row(from: string, to: string): DraftRow {
  return { id: `${from}-${to}`, from, to, transform: null };
}

describe('ReadOnlyMapping', () => {
  it('hands the table inert handlers, so a viewer has nothing to press', () => {
    invocations.length = 0;
    render(
      <ReadOnlyMapping
        rows={[row('lead.email', 'emailAddress')]}
        issues={[null]}
        preview={'{\n  "emailAddress": "{{ $json.lead.email }}"\n}'}
      />,
    );

    expect(invocations).toEqual(['onChange', 'onRemove', 'onAddEmpty', 'onPaste', 'onUseRun']);
    expect(screen.getByText('1 mapped')).toBeDefined();
  });

  it('shows the compiled body and says why the target names are unchecked', () => {
    render(
      <ReadOnlyMapping
        rows={[row('lead.email', 'emailAddress')]}
        issues={[null]}
        preview={'{\n  "emailAddress": "{{ $json.lead.email }}"\n}'}
      />,
    );

    expect(screen.getByText('Request body preview')).toBeDefined();
    expect(screen.getByText(/"emailAddress": "\{\{ \$json\.lead\.email \}\}"/)).toBeDefined();
    expect(screen.getByText(/editing this mapping needs the workflow author/)).toBeDefined();
  });

  it('prints an empty body when the node has no row yet', () => {
    render(<ReadOnlyMapping rows={[]} issues={[]} preview="{}" />);

    expect(screen.getByText('0 mapped')).toBeDefined();
    expect(screen.getByText('{}')).toBeDefined();
  });
});
