import { useMemo, useState } from 'react';
import { mappingExpression } from '@seamnex/domain';
import type { FieldDescriptor, FieldMapping, WorkflowNode } from '@seamnex/domain';

export type RowIssue = { readonly from: string | null; readonly to: string | null };

/**
 * A draft row: the mapping the API stores, plus the identity the ledger renders.
 *
 * The identity cannot be derived from `from`/`to` — those change on every keystroke, so a row keyed
 * by them was remounted per character and the caret was lost mid-word. It also cannot be the array
 * index: removing row 2 would leave the element of row 3 under the wrong key. The wire type stays
 * `FieldMapping`; this id never leaves the drawer.
 */
export type DraftRow = FieldMapping & { readonly id: string };

let rowSeq = 0;
const nextRowId = (): string => {
  rowSeq += 1;
  return `row-${rowSeq}`;
};

const toDraftRow = (mapping: FieldMapping): DraftRow => ({ ...mapping, id: nextRowId() });
const toDraftRows = (mappings: readonly FieldMapping[]): DraftRow[] => mappings.map(toDraftRow);

/** The rows as the API stores them: the id is a rendering concern, not part of the definition. */
export function toFieldMappings(rows: readonly DraftRow[]): FieldMapping[] {
  return rows.map(({ from, to, transform }) => ({ from, to, transform }));
}

/**
 * What a save would store, as text.
 *
 * Both the "dirty" comparison and the confirmation message go through it, so an id — or the key
 * order of the object the API returned — can never make an unchanged draft look edited.
 */
export function serializeRows(rows: readonly DraftRow[] | readonly FieldMapping[]): string {
  return JSON.stringify(rows.map(({ from, to, transform }) => ({ from, to, transform })));
}

/**
 * The draft and its validation, kept out of the component so the rules can be tested without a
 * render.
 *
 * The draft is keyed by the value it was taken from. A save refetches the workflow, and a plain
 * `useState(node.mappings)` kept showing the empty draft the editor opened with — "No field mapping
 * yet" on a node that had two, which reads as if the save had failed.
 */
export function useMappingDraft(node: WorkflowNode) {
  const baseline = serializeRows(node.mappings);
  const [draft, setDraft] = useState<{ key: string; rows: DraftRow[] }>(() => ({
    key: baseline,
    rows: toDraftRows(node.mappings),
  }));
  /*
   * What the last save sent. Without it the drawer stayed "dirty" until the refetch landed, so a
   * second click on Close asked to discard mappings that had just been saved.
   */
  const [saved, setSaved] = useState<string | null>(null);
  /*
   * The rows of a refetched node, given ids once per version of its mappings. Rebuilding them on
   * every render would give each row a new id each time and remount the inputs the same way the
   * value-derived key did.
   */
  const refetched = useMemo(() => toDraftRows(node.mappings), [node.mappings]);
  const rows = draft.key === baseline ? draft.rows : refetched;
  const setRows = (next: DraftRow[] | ((current: DraftRow[]) => DraftRow[])) => {
    setDraft({ key: baseline, rows: typeof next === 'function' ? next(rows) : next });
  };

  return {
    rows,
    dirty: serializeRows(rows) !== (saved ?? baseline),
    markSaved: (value: string) => setSaved(value),
    replace: (index: number, patch: Partial<FieldMapping>) => {
      setRows((current) =>
        current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
      );
    },
    remove: (index: number) => {
      setRows((current) => current.filter((_, position) => position !== index));
    },
    add: (from: string, to: string) => {
      setRows((current) => [...current, { id: nextRowId(), from, to, transform: null }]);
    },
    addMany: (pairs: readonly { from: string; to: string }[]) => {
      if (pairs.length === 0) return;
      setRows((current) => [
        ...current,
        ...pairs.map((pair) => ({
          id: nextRowId(),
          from: pair.from,
          to: pair.to,
          transform: null,
        })),
      ]);
    },
    clear: () => setRows([]),
  };
}

/**
 * One issue per side, because an empty target and a duplicate source need different corrections.
 * `knownFields` is `null` whenever the product did not publish a schema — the absence of knowledge
 * is not a reason to report an error.
 */
export function validateRows(
  rows: readonly FieldMapping[],
  knownFields: ReadonlySet<string> | null,
): (RowIssue | null)[] {
  /*
   * Counted on the trimmed values, because `save` sends trimmed values: `' lead.email'` and
   * `'lead.email'` looked like two sources here and arrived at the product as one field written
   * twice — the duplicate the ledger exists to prevent.
   */
  const fromCounts = new Map<string, number>();
  const toCounts = new Map<string, number>();
  for (const row of rows) {
    const from = row.from.trim();
    const to = row.to.trim();
    if (from.length > 0) fromCounts.set(from, (fromCounts.get(from) ?? 0) + 1);
    if (to.length > 0) toCounts.set(to, (toCounts.get(to) ?? 0) + 1);
  }

  return rows.map((row) => {
    const from = row.from.trim();
    const to = row.to.trim();
    const fromIssue =
      from.length === 0
        ? 'Source path is required.'
        : (fromCounts.get(from) ?? 0) > 1
          ? 'Another row already uses this source path.'
          : null;
    const toIssue =
      to.length === 0
        ? 'Target field is required.'
        : (toCounts.get(to) ?? 0) > 1
          ? 'Another row already writes this field.'
          : knownFields !== null && !knownFields.has(to)
            ? `Not a field this operation accepts.`
            : null;
    return fromIssue === null && toIssue === null ? null : { from: fromIssue, to: toIssue };
  });
}

/** How many of the product's required fields are covered by the draft. */
export function requiredCoverage(
  rows: readonly FieldMapping[],
  fields: readonly FieldDescriptor[],
): { required: number; covered: number; missing: readonly string[] } {
  const written = new Set(rows.map((row) => row.to.trim()));
  const required = fields.filter((field) => field.required);
  const missing = required.filter((field) => !written.has(field.name)).map((field) => field.name);
  return { required: required.length, covered: required.length - missing.length, missing };
}

/**
 * The compiled body, as the platform will send it: the compiler turns each mapping into
 * `{{ $json.<from> }}` and the product receives it under `<to>`.
 *
 * A row with one side still empty is left out: the preview is a claim about what will be sent, and
 * `{{ $json. }}` is neither what the author means nor something the save would accept.
 */
export function bodyPreview(rows: readonly FieldMapping[]): string {
  const body: Record<string, string> = {};
  for (const row of rows) {
    const to = row.to.trim();
    const from = row.from.trim();
    if (to.length === 0 || from.length === 0) continue;
    body[to] = mappingExpression(from);
  }
  return JSON.stringify(body, null, 2);
}
