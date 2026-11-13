import type { FieldMapping } from '@seamnex/domain';
import { Button } from '@seamnex/ui';
import { X } from 'lucide-react';
import { FieldCombobox, type ComboOption } from './field-combobox';
import type { DraftRow, RowIssue } from './use-mapping-draft';

/**
 * The ledger: one row per field, with the product's own names on both sides.
 *
 * Column headers appear once instead of a label per row, which is what made the old editor read as
 * a form inside a form. Errors sit directly under the input they belong to and are programmatically
 * associated, so a screen reader announces them with the field rather than at the end of the panel.
 */
export function MappingTable({
  rows,
  issues,
  sourceOptions,
  targetOptions,
  sampleValues,
  onChange,
  onRemove,
  onAddEmpty,
  onPaste,
  onUseRun,
  canAuthor,
}: {
  rows: readonly DraftRow[];
  issues: readonly (RowIssue | null)[];
  sourceOptions: readonly ComboOption[];
  targetOptions: readonly ComboOption[];
  sampleValues: ReadonlyMap<string, string>;
  onChange: (index: number, patch: Partial<FieldMapping>) => void;
  onRemove: (index: number) => void;
  onAddEmpty: () => void;
  onPaste: () => void;
  onUseRun: () => void;
  canAuthor: boolean;
}) {
  if (!canAuthor) {
    /*
     * The read-only ledger. A viewer without `workflow.author` still needs to answer "what does this
     * node send, and is anything wrong with it" — the mapping is part of the definition they are
     * reviewing — so the rows and their structural issues are shown as text, with no input, no
     * remove control and no add affordance.
     */
    if (rows.length === 0) {
      return <p className="text-meta text-faint">No field mapping on this node yet.</p>;
    }
    return (
      <table className="w-full table-fixed border-separate border-spacing-y-1 text-left">
        <caption className="sr-only">
          Field mappings from the previous step to this operation
        </caption>
        <thead>
          <tr className="text-faint">
            <th scope="col" className="w-[42%] px-1 font-mono text-micro font-medium label-caps">
              Source path
            </th>
            <th
              scope="col"
              className="hidden w-[22%] px-1 font-mono text-micro font-medium label-caps sm:table-cell"
            >
              Sample
            </th>
            <th scope="col" className="w-[36%] px-1 font-mono text-micro font-medium label-caps">
              Target field
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id} className="align-top">
              <td className="px-1">
                <span className="block truncate font-mono text-micro text-text">
                  {row.from.length === 0 ? '—' : row.from}
                </span>
                <RowIssueText text={issues[index]?.from ?? null} />
              </td>
              <td className="hidden px-1 sm:table-cell">
                <span className="block truncate font-mono text-micro text-faint">
                  {sampleValues.get(row.from) ?? '—'}
                </span>
              </td>
              <td className="px-1">
                <span className="block truncate font-mono text-micro text-text">
                  {row.to.length === 0 ? '—' : row.to}
                </span>
                <RowIssueText text={issues[index]?.to ?? null} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-sm border border-dashed border-line-strong bg-panel-soft p-4">
        <p className="text-body font-semibold text-text">No field mapping yet</p>
        <p className="text-meta leading-relaxed text-muted">
          Pick fields from a sample to fill the ledger, or add a row and name both sides yourself.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={onPaste}>
            Paste a sample
          </Button>
          <Button size="sm" variant="ghost" onClick={onUseRun}>
            Use last run
          </Button>
          <Button size="sm" variant="quiet" onClick={onAddEmpty}>
            Add a row manually
          </Button>
        </div>
      </div>
    );
  }

  return (
    <table className="w-full table-fixed border-separate border-spacing-y-1 text-left">
      <caption className="sr-only">Field mappings from the previous step to this operation</caption>
      <thead>
        <tr className="text-faint">
          <th scope="col" className="w-[42%] px-1 font-mono text-micro font-medium label-caps">
            Source path
          </th>
          <th
            scope="col"
            className="hidden w-[22%] px-1 font-mono text-micro font-medium label-caps sm:table-cell"
          >
            Sample
          </th>
          <th scope="col" className="w-[36%] px-1 font-mono text-micro font-medium label-caps">
            Target field
          </th>
          <th scope="col" className="w-8">
            <span className="sr-only">Remove</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const fromIssue = issues[index]?.from ?? null;
          const toIssue = issues[index]?.to ?? null;
          const sourceId = `mapping-source-${row.id}`;
          const targetId = `mapping-target-${row.id}`;
          return (
            /*
             * The row's own id, never `from`/`to` and never the index. A value-derived key changed on
             * the first keystroke, so React remounted the row, the focused `<input>` was replaced and
             * the caret fell to `<body>` — "Add row" could not be filled in at all. An index key
             * survives typing but reuses the wrong element once a row above is removed.
             */
            <tr key={row.id} className="align-top">
              <td className="px-1">
                <FieldCombobox
                  value={row.from}
                  onChange={(value) => onChange(index, { from: value })}
                  options={sourceOptions}
                  ariaLabel={`Source path ${index + 1}`}
                  placeholder="data[0].lastName"
                  invalid={fromIssue !== null}
                  describedBy={fromIssue === null ? undefined : `${sourceId}-error`}
                />
                {fromIssue === null ? null : (
                  <p
                    id={`${sourceId}-error`}
                    role="alert"
                    className="mt-0.5 text-micro text-danger"
                  >
                    {fromIssue}
                  </p>
                )}
              </td>
              <td className="hidden px-1 sm:table-cell">
                <span className="block truncate font-mono text-micro text-faint">
                  {sampleValues.get(row.from) ?? '—'}
                </span>
              </td>
              <td className="px-1">
                <FieldCombobox
                  value={row.to}
                  onChange={(value) => onChange(index, { to: value })}
                  options={targetOptions}
                  ariaLabel={`Target field ${index + 1}`}
                  placeholder="lastName"
                  invalid={toIssue !== null}
                  describedBy={toIssue === null ? undefined : `${targetId}-error`}
                />
                {toIssue === null ? null : (
                  <p
                    id={`${targetId}-error`}
                    role="alert"
                    className="mt-0.5 text-micro text-danger"
                  >
                    {toIssue}
                  </p>
                )}
              </td>
              <td className="px-1">
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={`Remove mapping ${index + 1}`}
                  onClick={() => onRemove(index)}
                >
                  <X />
                </Button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The same sentence the editor shows under an input, without an input to attach it to.
 *
 * Deliberately not `role="alert"`: nothing is being edited, so a read-only table of ten rows would
 * announce ten errors at once when the drawer opens.
 */
function RowIssueText({ text }: { text: string | null }) {
  if (text === null) return null;
  return <p className="mt-0.5 text-micro text-danger">{text}</p>;
}
