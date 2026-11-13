import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, CircleAlert, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import {
  toProblem,
  useCreateWorkflow,
  useImportWorkflow,
  useInstances,
  useRegistry,
  useWorkflows,
} from '@seamnex/api-client';
import type { Workflow, WorkflowExport } from '@seamnex/domain';
import { TRIGGER_LABELS, WORKFLOW_STATE_LABELS } from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Grid,
  InlineNote,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  SkeletonLines,
  StatusPill,
  Textarea,
  defineColumns,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

/**
 * Module scope: no cell here reads component state, so the array and its closures are built once.
 *
 * `name` is the row's identity and carries the link; the trailing "Open" cell is a second, explicit
 * affordance to the same destination in a different cell, so the two anchors are siblings and never
 * nested.
 */
const WORKFLOW_COLUMNS = defineColumns<Workflow>([
  {
    id: 'name',
    header: 'Workflow',
    primary: true,
    cell: (row) => (
      <div className="min-w-0">
        <span className="block font-medium text-text">{row.name}</span>
        {/* `null` is "no description"; a synthesised fallback used to make it look authored. */}
        <p className="mt-0.5 line-clamp-1 max-w-md text-micro text-faint">
          {row.description ?? 'No description'}
        </p>
      </div>
    ),
  },
  {
    id: 'state',
    header: 'State',
    cell: (row) => {
      const label = WORKFLOW_STATE_LABELS[row.state];
      return <StatusPill tone={label.tone} label={label.label} size="sm" />;
    },
  },
  {
    id: 'trigger',
    header: 'Trigger',
    hideBelow: 'md',
    cell: (row) => (
      <div className="min-w-0">
        <Badge tone="accent" size="sm">
          {TRIGGER_LABELS[row.trigger.type] ?? row.trigger.type}
        </Badge>
        <p className="mt-0.5 truncate text-micro text-faint">{row.trigger.label}</p>
      </div>
    ),
  },
  {
    id: 'targets',
    header: 'Write targets',
    hideBelow: 'lg',
    cell: (row) => (
      <div className="flex flex-wrap gap-1">
        {row.writeTargets.map((target) => (
          <Badge key={target.entryKey} tone="caution" size="sm">
            {target.entryKey} {target.product}
          </Badge>
        ))}
      </div>
    ),
  },
  {
    id: 'owner',
    header: 'Owner',
    hideBelow: 'xl',
    cell: (row) => <span className="text-meta text-muted">{row.owner.name}</span>,
  },
  {
    id: 'last',
    header: 'Last run',
    hideBelow: 'md',
    cell: (row) =>
      row.lastRunAt ? (
        <div>
          <span className="text-meta text-muted">{formatRelative(row.lastRunAt)}</span>
          <span className="mt-0.5 block">
            <Badge
              tone={
                row.lastRunState === 'succeeded'
                  ? 'positive'
                  : row.lastRunState === 'failed'
                    ? 'danger'
                    : 'neutral'
              }
              size="sm"
            >
              {row.lastRunState}
            </Badge>
          </span>
        </div>
      ) : (
        <span className="text-micro text-faint">never run</span>
      ),
  },
  {
    id: 'validation',
    header: 'Validation',
    hideBelow: 'xl',
    /**
     * Three states, not two: a draft that has never been validated is neither "valid" nor
     * "N errors" — the API reports `checkedAt: null` for exactly that case, and claiming "valid"
     * used to enable Activate on a definition nothing had checked.
     */
    cell: (row) => {
      if (row.validation.valid) {
        return (
          <Badge tone="positive" size="sm">
            valid
          </Badge>
        );
      }
      if (row.validation.checkedAt === null) {
        return (
          <Badge tone="neutral" size="sm">
            not validated
          </Badge>
        );
      }
      const errors = row.validation.issues.filter((issue) => issue.severity === 'error').length;
      return (
        <Badge tone="danger" size="sm">
          {errors} error{errors === 1 ? '' : 's'}
        </Badge>
      );
    },
  },
  {
    id: 'open',
    header: '',
    align: 'right',
    cell: (row) => (
      <Link
        to={`/workflows/${row.id}`}
        className="inline-flex items-center gap-1 text-meta font-semibold text-link"
      >
        Open <ArrowRight className="size-3" aria-hidden />
      </Link>
    ),
  },
]);

const workflowRowKey = (row: Workflow) => row.id;

const workflowRowLink = (row: Workflow, className: string, children: ReactNode) => (
  <Link to={`/workflows/${row.id}`} className={className}>
    {children}
  </Link>
);

export function WorkflowsPage() {
  const workflows = useWorkflows();
  const instances = useInstances();
  const registry = useRegistry();
  const create = useCreateWorkflow();
  const importer = useImportWorkflow();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [documentText, setDocumentText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState<'schedule' | 'webhook' | 'poll' | 'manual'>(
    'schedule',
  );
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');

  const rows = workflows.data ?? [];
  const failed = rows.filter((workflow) => workflow.state === 'failed');
  const createProblem = create.error ? toProblem(create.error) : null;
  const fieldError = (field: string) =>
    createProblem?.fieldErrors?.find((item) => item.field === field)?.message;

  /**
   * FR-5.2 / C-11: the pickers offer what the platform can actually broker.
   *
   * The target list used to contain every deployed product, and the server refused the ones that
   * cannot issue an operation-scoped credential — a round trip to learn something the registry had
   * already published. The registry entry carries the verdict (`writeEligible`, `workflowEligible`),
   * computed by the same predicate the broker and invariant 4 use, so the two cannot disagree.
   * While the registry is still loading the full list is offered: a missing answer must not read as
   * "nothing is eligible", and the API refuses the impossible choice anyway.
   */
  const eligibility = useMemo(
    () => new Map((registry.data ?? []).map((entry) => [entry.instanceId, entry])),
    [registry.data],
  );
  const sourceOptions = (instances.data ?? []).filter(
    (instance) => eligibility.get(instance.id)?.workflowEligible ?? true,
  );
  const targetOptions = (instances.data ?? []).filter(
    (instance) => eligibility.get(instance.id)?.writeEligible ?? true,
  );
  const notWriteEligible = (instances.data ?? []).filter(
    (instance) => eligibility.get(instance.id)?.writeEligible === false,
  );
  const notSourceEligible = (instances.data ?? []).filter(
    (instance) => eligibility.get(instance.id)?.workflowEligible === false,
  );

  return (
    <Page>
      <PageHeader
        eyebrow="Automation workspace"
        title="Workflows"
        description="Connect installed products without writing glue code. Discovery comes from the integration registry; credentials are brokered and operation-scoped."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
              Import
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus />}
              onClick={() => setOpen(true)}
              aria-describedby="new-workflow-note"
            >
              New workflow
            </Button>
          </>
        }
        meta={
          <>
            <Badge tone="positive" size="sm">
              {rows.filter((workflow) => workflow.state === 'active').length} active
            </Badge>
            <Badge tone="neutral" size="sm">
              {rows.filter((workflow) => workflow.state === 'draft').length} draft
            </Badge>
            <Badge tone="danger" size="sm">
              {failed.length} failed
            </Badge>
          </>
        }
      />

      {failed.length > 0 ? (
        <div className="mb-3 rounded-md border border-danger-border bg-danger-wash px-4 py-3">
          <p className="flex items-center gap-2 text-body font-semibold text-danger-strong">
            <CircleAlert className="size-4" aria-hidden /> Failed-run queue
          </p>
          <ul className="mt-2 space-y-1">
            {failed.map((workflow) => (
              <li
                key={workflow.id}
                className="flex flex-wrap items-center justify-between gap-2 text-meta"
              >
                <span className="text-muted">
                  <Link
                    to={`/workflows/${workflow.id}`}
                    className="font-medium text-text hover:text-link"
                  >
                    {workflow.name}
                  </Link>{' '}
                  · last run {formatRelative(workflow.lastRunAt ?? workflow.updatedAt)}
                </span>
                <Link
                  to={`/workflows/${workflow.id}`}
                  className="font-semibold text-link hover:underline"
                >
                  Inspect and replay
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Panel>
        <PanelHeader
          eyebrow={`${rows.length} definitions`}
          title="Workflow inventory"
          description="Every write to a system of record needs a named owner, an idempotency key, retry limits and failure alerting."
        />
        <AsyncPanel
          query={workflows}
          loading={
            <div className="p-4">
              <SkeletonLines lines={6} />
            </div>
          }
          loadingLabel="Loading the workflow inventory"
          renderError={(error, retry) => (
            <div className="p-4">
              <QueryError error={error} onRetry={retry} />
            </div>
          )}
        >
          {() => (
            <DataTable
              columns={WORKFLOW_COLUMNS}
              rows={rows}
              rowKey={workflowRowKey}
              renderRowLink={workflowRowLink}
              empty={
                <EmptyState
                  icon={<WorkflowIcon className="size-5" />}
                  title="No workflows yet"
                  description="Compose one from the operations discovered in the registry. A write target must expose operation-scoped credentials (C-11)."
                />
              }
            />
          )}
        </AsyncPanel>
      </Panel>

      <p id="new-workflow-note" className="mt-3 text-micro text-faint">
        New workflows bind the source’s first read operation and the target’s first write operation
        from the registry. Activation stays blocked until validation passes and the write node holds
        a live write credential scope.
      </p>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New workflow"
        description="Drafted from discovered operations. Credentials are brokered at activation; nothing is written until then."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={create.isPending || name.trim().length < 3 || !sourceId || !targetId}
              onClick={() =>
                create.mutate(
                  {
                    name: name.trim(),
                    // Omitted rather than sent as `''`: an empty string is not a description, and
                    // storing one made the whole workflow list fail its response schema.
                    ...(description.trim().length === 0 ? {} : { description: description.trim() }),
                    triggerType,
                    sourceInstanceId: sourceId,
                    targetInstanceId: targetId,
                  },
                  {
                    onSuccess: (workflow) => {
                      setOpen(false);
                      setName('');
                      setDescription('');
                      setSourceId('');
                      setTargetId('');
                      navigate(`/workflows/${workflow.id}`);
                    },
                  },
                )
              }
            >
              {create.isPending ? 'Drafting…' : 'Create draft'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {createProblem ? (
            <Callout tone="danger" title={createProblem.title}>
              {createProblem.detail} {createProblem.remediation ?? ''}
            </Callout>
          ) : null}
          <Field
            label="Name"
            required
            htmlFor="wf-name"
            {...(fieldError('name') ? { error: fieldError('name') } : {})}
          >
            <Input
              id="wf-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Invoice export to finance"
            />
          </Field>
          <Field
            label="Description"
            htmlFor="wf-description"
            hint="Optional. Shown in the workflow inventory."
          >
            <Textarea
              id="wf-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Nightly export of issued invoices into the finance ledger."
            />
          </Field>
          <Field
            label="Trigger"
            required
            htmlFor="wf-trigger"
            hint="The type is recorded here. The definition carries the cron, timezone or polling interval, which the platform writes and `PUT /workflows/:id/trigger` changes."
          >
            <Select
              id="wf-trigger"
              value={triggerType}
              onChange={(event) => setTriggerType(event.target.value as typeof triggerType)}
            >
              <option value="schedule">Schedule — cron in a named timezone</option>
              <option value="webhook">Webhook — inbound, authenticated</option>
              <option value="poll">Poll — minimum interval enforced</option>
              <option value="manual">Manual — run from the console</option>
            </Select>
          </Field>
          <Grid cols={2}>
            <Field
              label="Source"
              required
              htmlFor="wf-source"
              {...(fieldError('sourceInstanceId') ? { error: fieldError('sourceInstanceId') } : {})}
            >
              <Select
                id="wf-source"
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
              >
                <option value="">Choose a product…</option>
                {sourceOptions.map((instance) => (
                  <option key={instance.id} value={instance.id}>
                    {instance.entryKey} · {instance.product}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Write target"
              required
              htmlFor="wf-target"
              hint="Only products with an operation-scoped write credential."
              {...(fieldError('targetInstanceId') ? { error: fieldError('targetInstanceId') } : {})}
            >
              <Select
                id="wf-target"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                <option value="">Choose a product…</option>
                {targetOptions.map((instance) => (
                  <option key={instance.id} value={instance.id}>
                    {instance.entryKey} · {instance.product}
                  </option>
                ))}
              </Select>
            </Field>
          </Grid>
          {notWriteEligible.length > 0 ? (
            <InlineNote>
              Not offered as a write target:{' '}
              {notWriteEligible
                .map((instance) => `${instance.entryKey} ${instance.product}`)
                .join(', ')}{' '}
              — they issue no operation-scoped credential, so a write cannot be bounded to an
              operation (C-11).
            </InlineNote>
          ) : null}
          {notSourceEligible.length > 0 ? (
            <InlineNote>
              Not offered as a source:{' '}
              {notSourceEligible
                .map((instance) => `${instance.entryKey} ${instance.product}`)
                .join(', ')}{' '}
              — the platform cannot broker any credential for them.
            </InlineNote>
          ) : null}
          <Callout tone="info" title="What gets created">
            A trigger node bound to the source’s first read operation and an action node bound to
            the target’s first write operation, both discovered in the registry. Any blocking issue
            is listed under the canvas; nothing runs until the definition validates and is
            activated.
          </Callout>
        </div>
      </Dialog>

      <Dialog
        open={importOpen}
        onOpenChange={(next) => {
          setImportOpen(next);
          if (!next) {
            setDocumentText('');
            setImportError(null);
          }
        }}
        title="Import a workflow"
        description="Paste a document exported from another environment. It lands as a disabled draft and must still be validated before activation."
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={importer.isPending || documentText.trim().length === 0}
              onClick={() => {
                setImportError(null);
                let parsed: unknown;
                try {
                  parsed = JSON.parse(documentText) as unknown;
                } catch {
                  setImportError('That is not valid JSON. Paste the exported document unchanged.');
                  return;
                }
                importer.mutate(parsed as WorkflowExport, {
                  onSuccess: (workflow) => {
                    setImportOpen(false);
                    setDocumentText('');
                    navigate(`/workflows/${workflow.id}`);
                  },
                });
              }}
            >
              {importer.isPending ? 'Importing…' : 'Import draft'}
            </Button>
          </>
        }
      >
        {importError ? (
          <div className="mb-3">
            <Alert tone="caution" title="The document could not be read">
              {importError}
            </Alert>
          </div>
        ) : null}
        {importer.isError ? <QueryError error={importer.error} compact /> : null}
        <div className="space-y-3">
          <Field
            label="Export document"
            htmlFor="workflow-import"
            hint="apiVersion seamnex.workflow/v1. Exported from a workflow workspace with the Export action."
          >
            <Textarea
              id="workflow-import"
              rows={12}
              value={documentText}
              spellCheck={false}
              placeholder={
                '{\n "apiVersion": "seamnex.workflow/v1",\n "exportedAt": "…",\n "irHash": "…",\n "workflow": { … }\n}'
              }
              onChange={(event) => setDocumentText(event.target.value)}
            />
          </Field>
          <Callout tone="caution" title="Imported definitions are inert">
            Nothing runs until the draft passes validation and is activated, so an imported document
            cannot silently start writing to a system of record.
          </Callout>
        </div>
      </Dialog>
    </Page>
  );
}
