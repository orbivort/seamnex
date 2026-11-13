import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { WorkflowNode } from '@seamnex/domain';
import {
  serializeRows,
  toFieldMappings,
  useMappingDraft,
} from '../../src/features/workflows/field-mapping/use-mapping-draft';

/**
 * FR-5.5 — the draft behind the ledger.
 *
 * `validateRows` is covered next to its rules in `mapping-draft.test.ts`; this file covers the state:
 * which rows exist, whether they are dirty, and what a refetch of the node does to them. The node's
 * mappings are the baseline, so a save that lands and refetches must not leave the empty draft the
 * drawer opened with.
 */
function node(mappings: WorkflowNode['mappings']): WorkflowNode {
  return {
    id: 'lead-create',
    kind: 'action',
    label: 'Create contact',
    product: 'EspoCRM',
    entryKey: 'D01-01',
    operation: 'contacts.write',
    mode: 'write',
    x: 0,
    y: 0,
    summary: '',
    mappings,
  };
}

const STORED = node([{ from: 'lead.consentSource', to: 'consentSource', transform: null }]);

describe('useMappingDraft', () => {
  it('starts clean, with the stored mappings in the ledger', () => {
    const { result } = renderHook(() => useMappingDraft(STORED));

    expect(result.current.rows.map((row) => row.from)).toEqual(['lead.consentSource']);
    expect(result.current.dirty).toBe(false);
  });

  it('adds, replaces and removes rows and reports the draft as dirty', () => {
    const { result } = renderHook(() => useMappingDraft(STORED));

    act(() => result.current.add('lead.email', 'emailAddress'));
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.dirty).toBe(true);

    act(() => result.current.replace(1, { to: 'emailAddress ' }));
    expect(result.current.rows[1]?.to).toBe('emailAddress ');

    act(() => result.current.remove(0));
    expect(result.current.rows.map((row) => row.from)).toEqual(['lead.email']);

    act(() => result.current.clear());
    expect(result.current.rows).toEqual([]);
  });

  it('adds many rows at once, and ignores an empty batch', () => {
    const { result } = renderHook(() => useMappingDraft(STORED));

    act(() => result.current.addMany([]));
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.dirty).toBe(false);

    act(() =>
      result.current.addMany([
        { from: 'lead.email', to: 'emailAddress' },
        { from: 'lead.lastName', to: 'lastName' },
      ]),
    );
    expect(result.current.rows.map((row) => row.from)).toEqual([
      'lead.consentSource',
      'lead.email',
      'lead.lastName',
    ]);
  });

  it('stops reporting dirty once the saved rows are marked stored', () => {
    const { result } = renderHook(() => useMappingDraft(STORED));

    act(() => result.current.add('lead.email', 'emailAddress'));
    expect(result.current.dirty).toBe(true);

    act(() => result.current.markSaved(serializeRows(result.current.rows)));
    expect(result.current.dirty).toBe(false);
  });

  it('shows the refetched node instead of the draft it replaced', () => {
    // A save refetches the workflow; a draft keyed only by its initial state kept rendering the
    // rows the drawer opened with, which reads as a failed save.
    const { result, rerender } = renderHook(({ value }) => useMappingDraft(value), {
      initialProps: { value: STORED },
    });

    const refetched = node([
      { from: 'lead.consentSource', to: 'consentSource', transform: null },
      { from: 'lead.email', to: 'emailAddress', transform: null },
    ]);
    rerender({ value: refetched });

    expect(result.current.rows.map((row) => row.from)).toEqual([
      'lead.consentSource',
      'lead.email',
    ]);
    expect(result.current.dirty).toBe(false);
  });
});

describe('toFieldMappings', () => {
  it('drops the rendering id from the rows that go to the API', () => {
    const { result } = renderHook(() => useMappingDraft(STORED));

    expect(toFieldMappings(result.current.rows)).toEqual([
      { from: 'lead.consentSource', to: 'consentSource', transform: null },
    ]);
    expect(Object.hasOwn(result.current.rows[0] ?? {}, 'id')).toBe(true);
  });
});
