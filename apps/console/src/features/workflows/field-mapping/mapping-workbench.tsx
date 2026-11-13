import { useMemo, useState } from 'react';
import {
  usePatchWorkflowNode,
  usePutWorkflowMappings,
  useRegistryOperations,
  useWorkflowNodeFields,
  useWorkflowNodeSample,
} from '@seamnex/api-client';
import {
  can,
  type FieldDescriptor,
  type FieldMapping,
  type Workflow,
  type WorkflowNode,
} from '@seamnex/domain';
import { Button, ConfirmDialog, Drawer, InlineNote } from '@seamnex/ui';
import { QueryError } from '@seamnex/shell';
import { useSession } from '../../../session';
import type { ComboOption } from './field-combobox';
import { MappingTable } from './mapping-table';
import { parseSample, targetGuessFor, type SampleField } from './parse-sample';
import { ReadOnlyMapping } from './read-only-mapping';
import { SamplePanel } from './sample-panel';
import { TargetCoverage } from './target-coverage';
import {
  bodyPreview,
  requiredCoverage,
  serializeRows,
  toFieldMappings,
  useMappingDraft,
  validateRows,
} from './use-mapping-draft';

/**
 * FR-5.5 — the mapping workbench.
 *
 * Replaces the two free-text inputs that used to live in the 280 px inspector. Everything an author
 * needs to decide is on one surface: which operation this node runs, the fields a sample actually
 * contains, the fields the product accepts, the body that will be sent, and one save for the node.
 */
export function MappingWorkbench({
  workflow,
  node,
  open,
  onOpenChange,
}: {
  workflow: Workflow;
  node: WorkflowNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { session } = useSession();
  const canAuthor = can(session.role, 'workflow.author');
  const draft = useMappingDraft(node);
  const put = usePutWorkflowMappings(workflow.id);
  const patchNode = usePatchWorkflowNode(workflow.id);
  const operations = useRegistryOperations(node.entryKey ?? '');
  const [source, setSource] = useState<'paste' | 'run'>('paste');
  /*
   * The refresh intent belongs to the node it was asked for, not to the drawer. A plain boolean
   * stayed set after one click, so every later node opened in the same drawer forced a live product
   * read as well.
   */
  const [refreshNodeId, setRefreshNodeId] = useState<string | null>(null);
  const refresh = refreshNodeId === node.id;
  // Both aids are `workflow.author` routes: a viewer must not request them and then render a 403.
  const fields = useWorkflowNodeFields(workflow.id, node.id, node.operation, refresh, canAuthor);
  /*
   * The sample is production data and reading it is audited, so it is fetched when the author opens
   * the "Last run" rail — not when the drawer mounts on someone who pastes a fixture instead.
   */
  const sample = useWorkflowNodeSample(workflow.id, node.id, canAuthor && source === 'run');
  const [sampleText, setSampleText] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const parsed = useMemo(
    () => (sampleText.trim().length === 0 ? null : parseSample(sampleText)),
    [sampleText],
  );
  const runFields = useMemo<readonly SampleField[]>(
    () => (sample.data?.item == null ? [] : toFields(sample.data.item)),
    [sample.data],
  );
  const pasteFields = parsed?.ok === true ? parsed.fields : [];
  const activeFields = source === 'run' ? runFields : pasteFields;
  const parseError = source === 'paste' && parsed !== null && !parsed.ok ? parsed.error : null;

  const schemaFields = useMemo<readonly FieldDescriptor[]>(
    () => (fields.data?.status === 'available' ? fields.data.fields : []),
    [fields.data],
  );
  const known = useMemo(
    () =>
      fields.data?.status === 'available' ? new Set(schemaFields.map((field) => field.name)) : null,
    [fields.data, schemaFields],
  );

  const targetOptions = useMemo<ComboOption[]>(() => {
    const options = schemaFields.map((field) => ({
      value: field.name,
      meta: field.required ? 'required' : field.type,
    }));
    if (known !== null) return options;
    // No schema: offer what this workflow already writes, so a second node does not re-type it.
    const used = new Set(workflow.nodes.flatMap((entry) => entry.mappings.map((row) => row.to)));
    return [...used].filter((name) => name.length > 0).map((name) => ({ value: name }));
  }, [schemaFields, known, workflow.nodes]);

  const sourceOptions = useMemo<ComboOption[]>(
    () => activeFields.map((field) => ({ value: field.path, meta: field.type })),
    [activeFields],
  );
  const sampleValues = useMemo(
    () => new Map(activeFields.map((field) => [field.path, field.value])),
    [activeFields],
  );
  const mapped = useMemo(() => new Set(draft.rows.map((row) => row.from)), [draft.rows]);
  const issues = validateRows(draft.rows, known);
  const invalid = issues.some((issue) => issue !== null);
  const coverage = requiredCoverage(draft.rows, schemaFields);

  const bestTarget = (path: string): string => {
    const guess = targetGuessFor(path);
    if (guess.length === 0) return '';
    if (known === null) return guess;
    const exact = schemaFields.find((field) => field.name === guess);
    if (exact !== undefined) return exact.name;
    const folded = schemaFields.find((field) => field.name.toLowerCase() === guess.toLowerCase());
    return folded?.name ?? '';
  };

  /**
   * Any edit invalidates the "saved" confirmation. Leaving it up over a dirty draft claimed the rows
   * on screen were the ones stored, which is precisely what the author needs to know is no longer
   * true.
   */
  const clearSaved = () => setSaved(null);

  const toggle = (field: SampleField, checked: boolean) => {
    clearSaved();
    if (!checked) {
      const index = draft.rows.findIndex((row) => row.from === field.path);
      if (index >= 0) draft.remove(index);
      return;
    }
    if (draft.rows.some((row) => row.from === field.path)) return;
    draft.add(field.path, bestTarget(field.path));
  };

  const requestClose = () => {
    if (draft.dirty && canAuthor) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  const nodeOperations = (operations.data?.operations ?? []).filter(
    (entry) => entry.mode === node.mode,
  );
  /*
   * The step whose output this mapping reads. n8n stores each node's **output** and a mapping's
   * `from` is evaluated against the previous node's item, so the sample and its paths belong to the
   * inbound edge's source rather than to this node. The rail names it, because "which operation
   * shapes the data I am mapping" is the question the old editor could not answer at all.
   */
  const inbound = workflow.edges.find((edge) => edge.target === node.id);
  const sourceNode =
    inbound === undefined
      ? null
      : (workflow.nodes.find((entry) => entry.id === inbound.source) ?? null);

  const save = () => {
    // Trimmed values only: `toFieldMappings` drops the row id the ledger renders with, which is not
    // part of the definition and has no business on the wire.
    const rows: FieldMapping[] = toFieldMappings(draft.rows).map((row) => ({
      ...row,
      from: row.from.trim(),
      to: row.to.trim(),
    }));
    setSaved(null);
    put.mutate(
      { nodeId: node.id, mappings: rows },
      {
        onSuccess: () => {
          draft.markSaved(serializeRows(rows));
          setSaved(`${rows.length} mapping${rows.length === 1 ? '' : 's'} saved.`);
        },
      },
    );
  };

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
        width="xl"
        title={node.label}
        description={`${node.entryKey ?? 'Platform'} · ${node.operation ?? 'no operation'} · ${node.mode}`}
        footer={
          canAuthor ? (
            <>
              <span className="mr-auto self-center text-micro text-faint">
                {draft.rows.length} mapped
                {draft.dirty ? ' · unsaved changes' : ''}
              </span>
              <Button variant="ghost" onClick={requestClose}>
                {draft.dirty ? 'Discard' : 'Close'}
              </Button>
              <Button
                variant="primary"
                disabled={!draft.dirty || invalid || put.isPending}
                onClick={save}
              >
                {put.isPending ? 'Saving…' : 'Save mapping'}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )
        }
      >
        {canAuthor ? (
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
            <SamplePanel
              entryKey={node.entryKey}
              product={node.product}
              mode={node.mode}
              operation={node.operation}
              operations={nodeOperations}
              operationBusy={patchNode.isPending}
              sourceStep={
                sourceNode === null
                  ? null
                  : {
                      label: sourceNode.label,
                      entryKey: sourceNode.entryKey,
                      operation: sourceNode.operation,
                    }
              }
              onOperation={(id) => {
                const chosen = nodeOperations.find((entry) => entry.id === id);
                if (chosen === undefined || id === node.operation) return;
                patchNode.mutate({
                  nodeId: node.id,
                  patch: { operation: chosen.id, label: chosen.label, summary: chosen.description },
                });
              }}
              source={source}
              onSource={setSource}
              sampleText={sampleText}
              onSampleText={setSampleText}
              parseError={parseError}
              parsed={activeFields}
              truncated={
                source === 'run'
                  ? sample.data?.truncated === true
                  : parsed?.ok === true && parsed.truncated
              }
              run={{
                loading: sample.isLoading,
                capturedAt: sample.data?.capturedAt ?? null,
                runId: sample.data?.runId ?? null,
                truncated: sample.data?.truncated === true,
                error:
                  sample.error === null
                    ? null
                    : sample.error instanceof Error
                      ? sample.error.message
                      : 'the request failed',
              }}
              mapped={mapped}
              onToggle={toggle}
              onPickMany={(picked) => {
                clearSaved();
                const pairs = picked
                  .filter((field) => !mapped.has(field.path))
                  .map((field) => ({ from: field.path, to: bestTarget(field.path) }));
                draft.addMany(pairs);
              }}
              canAuthor={canAuthor}
            />

            <section aria-label="Mappings" className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-faint label-caps">Mappings</p>
                {canAuthor ? (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={activeFields.length === 0}
                      onClick={() => {
                        clearSaved();
                        const pairs = activeFields
                          .filter((field) => !mapped.has(field.path))
                          .map((field) => ({ from: field.path, to: bestTarget(field.path) }))
                          .filter((pair) => pair.to.length > 0);
                        draft.addMany(pairs);
                      }}
                    >
                      Match all by name
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => {
                        clearSaved();
                        draft.add('', '');
                      }}
                    >
                      Add row
                    </Button>
                  </div>
                ) : null}
              </div>

              <MappingTable
                rows={draft.rows}
                issues={issues}
                sourceOptions={sourceOptions}
                targetOptions={targetOptions}
                sampleValues={sampleValues}
                onChange={(index, patch) => {
                  clearSaved();
                  draft.replace(index, patch);
                }}
                onRemove={(index) => {
                  clearSaved();
                  draft.remove(index);
                }}
                onAddEmpty={() => {
                  clearSaved();
                  draft.add('', '');
                }}
                onPaste={() => setSource('paste')}
                onUseRun={() => setSource('run')}
                canAuthor={canAuthor}
              />

              <TargetCoverage
                fields={fields.data}
                fieldsError={
                  fields.error === null
                    ? null
                    : fields.error instanceof Error
                      ? fields.error.message
                      : 'the field schema could not be read'
                }
                loading={fields.isLoading}
                refreshing={fields.isFetching && refresh}
                onRefresh={() => {
                  // Already live for this node: the second click asks again, and the server's refresh
                  // floor decides whether the product is dialled.
                  if (refresh) void fields.refetch();
                  else setRefreshNodeId(node.id);
                }}
                required={coverage.required}
                covered={coverage.covered}
                missing={coverage.missing}
                preview={bodyPreview(draft.rows)}
                mapped={draft.rows.length}
              />

              {put.isError ? <QueryError error={put.error} compact /> : null}
              {patchNode.isError ? <QueryError error={patchNode.error} compact /> : null}
              {workflow.state === 'active' ? (
                <InlineNote>
                  Saving a mapping disables this active workflow. Activate it again when the mapping
                  is right, or the schedule stays off.
                </InlineNote>
              ) : null}
              <p className="sr-only" role="status" aria-live="polite">
                {saved ?? ''}
              </p>
              {saved === null ? null : (
                <p className="text-micro font-medium text-success-strong">{saved}</p>
              )}
            </section>
          </div>
        ) : (
          <ReadOnlyMapping rows={draft.rows} issues={issues} preview={bodyPreview(draft.rows)} />
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard unsaved mappings?"
        description="The rows you added or edited have not been saved to this workflow."
        confirmLabel="Discard changes"
        onConfirm={() => {
          setConfirmDiscard(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}

function toFields(item: unknown): readonly SampleField[] {
  const parsed = parseSample(JSON.stringify(item));
  return parsed.ok ? parsed.fields : [];
}
