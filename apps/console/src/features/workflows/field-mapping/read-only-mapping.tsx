import { InlineNote } from '@seamnex/ui';
import { MappingTable } from './mapping-table';
import type { DraftRow, RowIssue } from './use-mapping-draft';

/** A viewer cannot edit anything, so every handler the table accepts is inert. */
const NOOP = () => undefined;

/**
 * FR-5.5 — the mapping of one node, for a reader without `workflow.author`.
 *
 * The mapping is part of the definition a reviewer is accountable for, so it is visible: the rows,
 * the structural problems with them, and the body the run will send. What is absent is everything
 * that needs authority — the field list comes from the product through an author-only route, the
 * sample is an audited read of production data, and there is nothing to save.
 */
export function ReadOnlyMapping({
  rows,
  issues,
  preview,
}: {
  rows: readonly DraftRow[];
  issues: readonly (RowIssue | null)[];
  preview: string;
}) {
  return (
    <section aria-label="Mappings" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-faint label-caps">Mappings</p>
        <span className="text-micro text-faint">{rows.length} mapped</span>
      </div>

      <MappingTable
        rows={rows}
        issues={issues}
        sourceOptions={[]}
        targetOptions={[]}
        sampleValues={new Map()}
        onChange={NOOP}
        onRemove={NOOP}
        onAddEmpty={NOOP}
        onPaste={NOOP}
        onUseRun={NOOP}
        canAuthor={false}
      />

      <details className="rounded-xs border border-line bg-panel-soft" open={rows.length > 0}>
        <summary className="cursor-pointer px-2 py-1.5 font-mono text-micro text-muted label-caps">
          Request body preview
        </summary>
        <pre className="scroll-slim max-h-40 overflow-auto px-2 pb-2 font-mono text-micro leading-relaxed text-text">
          {rows.length === 0 ? '{}' : preview}
        </pre>
      </details>

      <InlineNote>
        Read-only: editing this mapping needs the workflow author. The target names are not checked
        against the product here, because that list is read with authoring rights.
      </InlineNote>
    </section>
  );
}
