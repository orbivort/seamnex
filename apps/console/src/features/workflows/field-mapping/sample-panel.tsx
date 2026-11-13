import { useState } from 'react';
import { Checkbox, InlineNote, Input, Select, SkeletonLines, Textarea } from '@seamnex/ui';
import { cn } from '@seamnex/utils';
import type { SampleField } from './parse-sample';

type RegistryOperation = {
  readonly id: string;
  readonly label: string;
  readonly mode: 'read' | 'write';
  readonly description: string;
};

type RunSample = {
  readonly loading: boolean;
  readonly capturedAt: string | null;
  readonly runId: string | null;
  readonly truncated: boolean;
  readonly error: string | null;
};

/**
 * The left rail: what the node reads from, and the fields the author can pick.
 *
 * The list is the whole point of this rail. Before it existed, the source half of a mapping was a
 * free-text JSON path typed into a 78 px column from memory — the one thing an author cannot look
 * up anywhere in the product.
 */
export function SamplePanel({
  entryKey,
  product,
  mode,
  operation,
  operations,
  sourceStep,
  onOperation,
  operationBusy,
  source,
  onSource,
  sampleText,
  onSampleText,
  parseError,
  parsed,
  truncated,
  run,
  mapped,
  onToggle,
  onPickMany,
  canAuthor,
}: {
  entryKey: string | null;
  product: string;
  mode: 'read' | 'write';
  operation: string | null;
  operations: readonly RegistryOperation[];
  /** The node whose output this mapping reads; `null` when the node has no inbound edge. */
  sourceStep: { label: string; entryKey: string | null; operation: string | null } | null;
  onOperation: (id: string) => void;
  operationBusy: boolean;
  source: 'paste' | 'run';
  onSource: (source: 'paste' | 'run') => void;
  sampleText: string;
  onSampleText: (text: string) => void;
  parseError: string | null;
  parsed: readonly SampleField[];
  truncated: boolean;
  run: RunSample;
  mapped: ReadonlySet<string>;
  onToggle: (field: SampleField, checked: boolean) => void;
  onPickMany: (fields: readonly SampleField[]) => void;
  canAuthor: boolean;
}) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const visible = parsed.filter(
    (field) =>
      needle.length === 0 ||
      field.path.toLowerCase().includes(needle) ||
      field.value.toLowerCase().includes(needle),
  );
  const pickable = visible.filter((field) => !mapped.has(field.path));

  return (
    <section
      aria-label="Source fields"
      className="flex min-w-0 flex-col gap-3 border-line pb-3 xl:w-[320px] xl:shrink-0 xl:border-r xl:pr-3 xl:pb-0"
    >
      <div className="flex flex-col gap-1.5">
        {/*
          The select edits *this* node's operation, not the upstream one. Calling it "Source
          operation" while listing write operations is how the control came to mean something the
          label denied; the step that actually produces the sample is named underneath instead.
        */}
        <p className="font-mono text-faint label-caps">
          {mode === 'write' ? 'Write operation' : 'Read operation'}
        </p>
        {canAuthor ? (
          <Select
            aria-label={mode === 'write' ? 'Write operation' : 'Read operation'}
            value={operation ?? ''}
            disabled={operationBusy || operations.length === 0}
            onChange={(event) => onOperation(event.target.value)}
          >
            {operation === null ? <option value="">Choose an operation…</option> : null}
            {operations.length === 0 ? (
              <option value={operation ?? ''}>{operation ?? 'No operations published'}</option>
            ) : null}
            {operations.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label} · {entry.mode}
              </option>
            ))}
          </Select>
        ) : (
          <p className="font-mono text-micro text-text">{operation ?? 'No operation bound'}</p>
        )}
        <p className="text-micro leading-snug text-faint">
          {operations.find((entry) => entry.id === operation)?.description ??
            `${entryKey ?? 'Platform'} · ${product} — ${mode === 'write' ? 'sends the request body built here.' : 'reads from the product.'}`}
        </p>
        <p className="text-micro leading-snug text-faint">
          {sourceStep === null
            ? "No upstream step: the sample is this node's own output."
            : `Sample comes from ${sourceStep.label} (${sourceStep.entryKey ?? 'platform'} · ${sourceStep.operation ?? 'no operation'}).`}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-faint label-caps">Sample item</p>
          <div role="group" aria-label="Sample source" className="flex gap-1">
            {(['paste', 'run'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={source === option}
                onClick={() => onSource(option)}
                className={cn(
                  'rounded-xs border px-1.5 py-0.5 text-micro font-medium transition-colors',
                  source === option
                    ? 'border-primary-border bg-primary-soft text-link'
                    : 'border-line bg-panel text-muted hover:border-control-border-strong',
                )}
              >
                {option === 'paste' ? 'Paste' : 'Last run'}
              </button>
            ))}
          </div>
        </div>

        {source === 'paste' ? (
          <>
            <Textarea
              aria-label="Sample item JSON"
              className="min-h-24 font-mono text-micro"
              spellCheck={false}
              placeholder={'{\n  "lastName": "Chen",\n  "email": "chen@example.com"\n}'}
              value={sampleText}
              onChange={(event) => onSampleText(event.target.value)}
            />
            {parseError === null ? null : (
              <p role="alert" className="text-micro font-medium text-danger">
                {parseError}
              </p>
            )}
            <p className="text-micro leading-snug text-faint">
              Paste one item from the previous step. Values are shown to name a path, not to be
              copied.
            </p>
          </>
        ) : (
          <RunSampleBlock run={run} pickable={pickable} onPickMany={onPickMany} />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-faint label-caps">Fields</p>
          <span className="text-micro text-faint">
            {parsed.length === 0 ? 'none' : `${mapped.size} of ${parsed.length} mapped`}
          </span>
        </div>
        <Input
          aria-label="Filter fields"
          className="h-8 text-meta"
          placeholder="Filter by path or value"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {parsed.length === 0 ? (
          <p className="text-micro leading-snug text-faint">
            Fields appear here once a sample is available.
          </p>
        ) : (
          <ul className="scroll-slim -mx-1 flex max-h-[340px] flex-col gap-0.5 overflow-y-auto px-1">
            {visible.length === 0 ? (
              <li className="px-1 py-1 text-micro text-faint">No field matches “{filter}”.</li>
            ) : null}
            {visible.map((field) => (
              <li key={field.path} className="rounded-xs px-1 py-0.5 hover:bg-paper-deep">
                <Checkbox
                  checked={mapped.has(field.path)}
                  onChange={(event) => onToggle(field, event.target.checked)}
                  label={
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-mono text-micro text-text">{field.path}</span>
                      <span className="flex items-center gap-1 text-micro text-faint">
                        <span className="truncate">{field.value}</span>
                        <span className="shrink-0 rounded-xs border border-line px-1">
                          {field.type}
                        </span>
                      </span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {pickable.length > 1 ? (
          <button
            type="button"
            className="self-start text-micro font-semibold text-link hover:underline"
            onClick={() => onPickMany(pickable)}
          >
            Add all {pickable.length} unmapped fields
          </button>
        ) : null}
        {truncated ? (
          <InlineNote>
            The sample is long; only its first entries are listed. Paths beyond this list can still
            be typed.
          </InlineNote>
        ) : null}
      </div>
    </section>
  );
}

function RunSampleBlock({
  run,
  pickable,
  onPickMany,
}: {
  run: RunSample;
  pickable: readonly SampleField[];
  onPickMany: (fields: readonly SampleField[]) => void;
}) {
  if (run.loading) return <SkeletonLines lines={3} />;
  if (run.error !== null) {
    return (
      <p className="text-micro leading-snug text-danger">
        The last run could not be read: {run.error}
      </p>
    );
  }
  if (run.capturedAt === null) {
    return (
      <p className="text-micro leading-snug text-faint">
        No sample has been captured for this node yet. Run the workflow once, or paste an item.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-xs border border-line bg-panel-soft p-2">
      <p className="text-micro text-text">
        Captured {run.capturedAt.slice(0, 16).replace('T', ' ')} UTC
        {run.runId === null ? '' : ` · run ${run.runId.slice(0, 8)}`}
      </p>
      <p className="text-micro text-faint">
        Redacted before storage{run.truncated ? ' and capped at the size limit' : ''}.
      </p>
      {pickable.length > 0 ? (
        <button
          type="button"
          className="self-start text-micro font-semibold text-link hover:underline"
          onClick={() => onPickMany(pickable)}
        >
          Use all {pickable.length} fields from this run
        </button>
      ) : null}
    </div>
  );
}
