import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowLeft,
  BadgeCheck,
  Copy,
  Download,
  Pencil,
  Play,
  Power,
  PowerOff,
  Trash2,
} from 'lucide-react';
import {
  toProblem,
  useDeleteWorkflow,
  useExportWorkflow,
  usePatchWorkflow,
  useWorkflow,
  useWorkflowAction,
} from '@seamnex/api-client';
import {
  can,
  ROLE_LABELS,
  RUN_STATE_LABELS,
  TRIGGER_LABELS,
  WORKFLOW_STATE_LABELS,
} from '@seamnex/domain';
import type { Tone, Workflow, WorkflowRun, WorkflowValidationResult } from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  buttonVariants,
  Callout,
  Dialog,
  Field,
  Grid,
  InlineNote,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  StatusPill,
  TabPanel,
  Tabs,
  Tooltip,
} from '@seamnex/ui';
import { downloadJson, formatDateTime } from '@seamnex/utils';
import { useSession } from '../../session';
import { usePageCrumb } from '../../page-crumb';
import { QueryError } from '@seamnex/shell';
import { WorkflowCanvas } from './WorkflowCanvas';
import { RUN_POLL_INTERVAL_MS, WorkflowRunsPanel } from './WorkflowRuns';
import { WorkflowTriggerPanel } from './WorkflowTriggerPanel';

/** The header's "last run" badge is part of the run's state, so it must settle with the table. */
const LAST_RUN_IN_FLIGHT = new Set<WorkflowRun['state']>(['queued', 'running', 'waiting_approval']);

function pollWhileLastRunIsInFlight(data: Workflow | undefined): number | false {
  const last = data?.lastRunState;
  return last !== null && last !== undefined && LAST_RUN_IN_FLIGHT.has(last)
    ? RUN_POLL_INTERVAL_MS
    : false;
}

export function WorkflowWorkspacePage() {
  const { id = '' } = useParams();
  const { session } = useSession();
  const workflow = useWorkflow(id, pollWhileLastRunIsInFlight);
  // The route id is a UUID; the chrome names the workflow instead of the path.
  usePageCrumb(workflow.data?.name);
  const action = useWorkflowAction(id);
  const exporter = useExportWorkflow();
  const remove = useDeleteWorkflow();
  const rename = usePatchWorkflow(id);
  const navigate = useNavigate();
  const [tab, setTab] = useState('canvas');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  /**
   * The tone is part of the notice: a failed validation used to be announced in a green
   * "Validation re-run" alert, which read as success next to a still-disabled Activate button.
   *
   * The definition version is part of it too. A trigger or mapping save writes version N+1 and
   * resets the validation, but the banner from the previous pass stayed on screen — so the page
   * claimed "Validation passed, activation is available" beside a disabled Activate button and no
   * issue list. The banner now belongs to the version it was produced for.
   */
  const [notice, setNotice] = useState<{
    tone: Tone;
    text: string;
    version: number;
    /** A copy of this workflow is a real destination; the banner carries the way to it. */
    action?: ReactNode;
  } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const removeProblem = remove.error ? toProblem(remove.error) : null;
  const canWrite = can(session.role, 'workflow.author');
  /**
   * Running is a separate grant from authoring (`workflow.run`), and an auditor holds neither. The
   * header used to offer Validate, Activate, Duplicate and Run now to every reader of the
   * definition, so a reviewer selected an action whose only answer was `403` — the list screen
   * hides the authoring actions from that role, and this screen now agrees with it.
   */
  const canRun = can(session.role, 'workflow.run');
  /**
   * A disabled action explains itself twice: a `title` for a mouse, and the read-only note below,
   * which the button *describes*. `title` alone was the whole story, and a disabled button takes
   * no focus and a tooltip has no place on a touch screen.
   */
  const readOnlyNote = canWrite ? {} : { 'aria-describedby': 'workspace-read-only' };

  if (workflow.isPending) {
    return (
      <Panel inset>
        <SkeletonLines lines={10} />
      </Panel>
    );
  }
  if (workflow.isError)
    /*
     * The failure keeps the way back. A missing or out-of-scope id answered `403`, and the screen
     * rendered the problem document alone: no crumb, no page, no link to the inventory — an
     * operator whose bookmark was stale had to use the sidebar to escape a page that had nothing
     * to show.
     */
    return (
      <Page>
        <Link
          to="/workflows"
          className="mb-3 inline-flex items-center gap-1.5 text-meta font-medium text-muted hover:text-link"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> Workflows
        </Link>
        <QueryError error={workflow.error} onRetry={() => void workflow.refetch()} />
      </Page>
    );

  const data = workflow.data;
  const state = WORKFLOW_STATE_LABELS[data.state];
  const errors = data.validation.issues.filter((issue) => issue.severity === 'error');
  /** `checkedAt: null` means no validation pass has produced these issues — not "zero errors". */
  const neverValidated = !data.validation.valid && data.validation.checkedAt === null;

  const runAction = (next: 'validate' | 'activate' | 'disable' | 'run' | 'duplicate') => {
    setNotice(null);
    // The version the verdict describes. None of these actions rewrites the definition, so it is
    // the version on screen; a later trigger or mapping save bumps it and retires the banner.
    const version = data.version;
    action.mutate(next, {
      onSuccess: (result) => {
        if (next === 'validate') {
          const validation = asValidationResult(result);
          if (validation === null) {
            setNotice({
              tone: 'caution',
              text: 'The validation response was not understood.',
              version,
            });
            return;
          }
          const blocking = validation.issues.filter((issue) => issue.severity === 'error').length;
          const advice = validation.issues.length - blocking;
          setNotice(
            blocking === 0
              ? {
                  // A pass with warnings is not a clean pass: the write may still be refused by the
                  // product, so the count travels with the verdict.
                  tone: advice === 0 ? 'positive' : 'caution',
                  version,
                  text:
                    advice === 0
                      ? `Validation passed at ${formatDateTime(validation.checkedAt)}. Activation is available.`
                      : `Validation passed at ${formatDateTime(validation.checkedAt)} with ${advice} warning${advice === 1 ? '' : 's'}. Activation is available; read them below the header before running.`,
                }
              : {
                  tone: 'danger',
                  version,
                  text: `Validation found ${blocking} blocking issue${blocking === 1 ? '' : 's'}. Activation stays blocked; the issues and their remediation are listed below the canvas.`,
                },
          );
        }
        if (next === 'activate')
          setNotice({
            tone: 'positive',
            version,
            text: 'Workflow activated. Triggers are live and runs will be recorded.',
          });
        if (next === 'disable')
          setNotice({
            tone: 'info',
            version,
            text: 'Workflow disabled. Trigger endpoints are paused; history is retained.',
          });
        if (next === 'run') {
          setTab('runs');
          /*
           * No state in this banner. It used to read `Run ${run.state}` from the response, which is
           * `running` at that moment — and the banner then outlived the run, so a run that had ended
           * `failed` still sat under a blue "Run running" while the table beside it said otherwise.
           * The Runs tab is the status; this only says where to look, which stays true.
           */
          setNotice({
            tone: 'info',
            version,
            text: 'Run requested. The Runs tab follows it to its outcome.',
          });
        }
        if (next === 'duplicate') {
          /*
           * "It appears in the workflow list" sent the operator to another screen to find one row
           * among rows, then back here-shaped: the copy is a workflow with an id, and its
           * workspace is the only place the next step (validate, map, activate) exists. The
           * response is the new workflow, so the banner links to it directly.
           */
          const copy = asWorkflow(result);
          setNotice({
            tone: 'positive',
            version,
            text:
              copy === null
                ? 'A draft copy was created. It appears in the workflow list.'
                : `A draft copy was created: ${copy.name}.`,
            ...(copy === null
              ? {}
              : {
                  action: (
                    <Link
                      to={`/workflows/${copy.id}`}
                      className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                    >
                      Open the copy
                    </Link>
                  ),
                }),
          });
        }
      },
    });
  };

  return (
    <Page>
      <Link
        to="/workflows"
        className="mb-3 inline-flex items-center gap-1.5 text-meta font-medium text-muted hover:text-link"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Workflows
      </Link>

      <PageHeader
        eyebrow={
          <>
            <StatusPill tone={state.tone} label={state.label} size="sm" />
            <span className="font-mono text-faint label-caps">version {data.version}</span>
            <Badge tone="neutral" size="sm">
              {TRIGGER_LABELS[data.trigger.type] ?? data.trigger.type}
            </Badge>
            {data.lastRunState ? (
              <Badge tone={RUN_STATE_LABELS[data.lastRunState].tone} size="sm">
                last run {RUN_STATE_LABELS[data.lastRunState].label}
              </Badge>
            ) : null}
          </>
        }
        title={data.name}
        description={data.description}
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              icon={<BadgeCheck />}
              disabled={action.isPending || !canWrite}
              title={canWrite ? undefined : 'workflow.author is required to validate'}
              {...readOnlyNote}
              onClick={() => runAction('validate')}
            >
              Validate
            </Button>
            <Tooltip content="Rename or re-describe. Node mapping edits remain out of scope (EX-2).">
              <Button
                size="sm"
                variant="ghost"
                icon={<Pencil />}
                disabled={!canWrite || rename.isPending}
                {...readOnlyNote}
                onClick={() => {
                  setDraftName(data.name);
                  setDraftDescription(data.description ?? '');
                  setRenameOpen(true);
                }}
              >
                Rename
              </Button>
            </Tooltip>
            {data.state === 'active' ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<PowerOff />}
                disabled={action.isPending || !canWrite}
                title={canWrite ? undefined : 'workflow.author is required to disable'}
                {...readOnlyNote}
                onClick={() => runAction('disable')}
              >
                Disable
              </Button>
            ) : data.validation.valid ? (
              <Button
                size="sm"
                variant="primary"
                icon={<Power />}
                disabled={action.isPending || !canWrite}
                title={canWrite ? undefined : 'workflow.author is required to activate'}
                {...readOnlyNote}
                onClick={() => runAction('activate')}
              >
                Activate
              </Button>
            ) : (
              <Tooltip
                content={
                  neverValidated
                    ? 'Run Validate first; activation needs a passing validation pass'
                    : 'Resolve blocking validation errors first'
                }
              >
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Power />}
                  disabled
                  aria-describedby="activation-blocked"
                >
                  Activate
                </Button>
              </Tooltip>
            )}
            <Button
              size="sm"
              variant="secondary"
              icon={<Play />}
              disabled={action.isPending || data.state !== 'active' || !canRun}
              title={canRun ? undefined : 'workflow.run is required to start a run'}
              onClick={() => runAction('run')}
            >
              Run now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Download />}
              disabled={exporter.isPending}
              onClick={() => {
                exporter.mutate(data.id, {
                  onSuccess: (payload) => downloadJson(`workflow-${data.id}.json`, payload),
                });
              }}
            >
              Export
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy />}
              disabled={action.isPending || !canWrite}
              title={canWrite ? undefined : 'workflow.author is required to duplicate'}
              {...readOnlyNote}
              onClick={() => runAction('duplicate')}
            >
              Duplicate
            </Button>
            {data.state !== 'active' ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 />}
                disabled={remove.isPending || !canWrite}
                title={canWrite ? undefined : 'workflow.author is required to delete'}
                {...readOnlyNote}
                onClick={() => setDeleteOpen(true)}
              >
                Delete
              </Button>
            ) : null}
          </>
        }
        meta={
          <>
            <span className="text-meta text-muted">owner {data.owner.name}</span>
            <span className="font-mono text-micro text-faint">{data.irHash.slice(0, 26)}…</span>
            <span className="text-micro text-faint">updated {formatDateTime(data.updatedAt)}</span>
            <span className="font-mono text-micro text-faint">role {session.role}</span>
          </>
        }
      />

      {/* A verdict for a definition that has since changed is not a statement about this one. */}
      {notice !== null && notice.version === data.version ? (
        <div className="mb-3">
          <Alert
            tone={notice.tone}
            title={notice.text}
            {...(notice.action === undefined ? {} : { action: notice.action })}
          />
        </div>
      ) : null}
      {/*
        The other half of the same defect: when the banner is retired, say why. Without this the
        page went from "activation is available" to a disabled button with no explanation, and the
        issue list disappeared with the validation pass it belonged to.
      */}
      {data.state !== 'active' && data.validation.checkedAt === null ? (
        <p id="activation-blocked" className="mb-3 text-meta text-muted">
          This version has not been validated since it changed. Run Validate before activating.
        </p>
      ) : null}
      {/*
        The third case: a pass ran and refused. The reason lived only in a tooltip on a disabled
        button, and a disabled button takes no focus — so the sentence was unreachable with a
        keyboard, and invisible on touch.
      */}
      {data.state !== 'active' && data.validation.checkedAt !== null && !data.validation.valid ? (
        <p id="activation-blocked" className="mb-3 text-meta text-muted">
          Activation is blocked by {errors.length !== 0 ? errors.length : 'at least one'} validation
          error{errors.length === 1 ? '' : 's'}, listed under the canvas.
        </p>
      ) : null}
      {canWrite ? null : (
        <p id="workspace-read-only" className="mb-3 text-meta text-muted">
          Read-only: the {ROLE_LABELS[session.role].name} role can inspect and export this
          definition, but cannot change it.
        </p>
      )}
      {action.isError ? <QueryError error={action.error} compact /> : null}
      {exporter.isError ? <QueryError error={exporter.error} compact /> : null}
      {removeProblem ? (
        <div className="mb-3">
          <Callout tone="danger" title={removeProblem.title}>
            {removeProblem.detail}
          </Callout>
        </div>
      ) : null}

      <Dialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${data.name}?`}
        description="The definition, its credential scopes and its run history are removed, and the compiled workflow is released in n8n."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 />}
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(data.id, {
                  onSuccess: () => {
                    setDeleteOpen(false);
                    navigate('/workflows');
                  },
                })
              }
            >
              {remove.isPending ? 'Deleting…' : 'Delete workflow'}
            </Button>
          </>
        }
      >
        <p className="text-meta leading-relaxed text-muted">
          Only drafts and disabled workflows can be deleted. An active workflow must be disabled
          first so that its trigger endpoint never outlives the definition.
        </p>
      </Dialog>

      <Dialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename workflow"
        description="The name and description are metadata; the definition, triggers and credential scopes are unchanged. The change is audited."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={rename.isPending || draftName.trim().length < 2}
              onClick={() =>
                rename.mutate(
                  {
                    name: draftName.trim(),
                    // Clearing the field clears the description: `null`, not `''`, which the
                    // contract refuses because an empty string is not a description.
                    description:
                      draftDescription.trim().length === 0 ? null : draftDescription.trim(),
                  },
                  {
                    onSuccess: () => {
                      setRenameOpen(false);
                      // A failed activate/validate banner belongs to that attempt; leaving it up
                      // beside a successful rename read as if the rename had failed too.
                      action.reset();
                      setNotice({
                        tone: 'positive',
                        // Renaming is metadata: it does not rewrite the definition, so the version
                        // — and any validation verdict already on screen — still applies.
                        version: data.version,
                        text: 'Workflow renamed. The change is in the audit trail.',
                      });
                    },
                  },
                )
              }
            >
              {rename.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {rename.isError ? <QueryError error={rename.error} compact /> : null}
        <div className="space-y-3">
          <Field
            label="Name"
            htmlFor="workflow-name"
            required
            error={draftName.trim().length < 2 ? 'Use at least two characters.' : undefined}
          >
            <Input
              id="workflow-name"
              value={draftName}
              invalid={draftName.trim().length < 2}
              onChange={(event) => setDraftName(event.target.value)}
            />
          </Field>
          <Field label="Description" htmlFor="workflow-description">
            <Input
              id="workflow-description"
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
            />
          </Field>
        </div>
      </Dialog>

      {/*
        Warnings are shown beside errors, not instead of them. `EMPTY_MAPPINGS` is a warning on a
        write node, and a write node with no mappings compiles to a request with no body: the
        definition activates, then dies on its first run. Rendering only the errors left the operator
        with "Validation passed" and no hint that the target would refuse the write.
      */}
      {data.validation.issues.length > 0 ? (
        <div
          className={
            errors.length > 0
              ? 'mb-3 rounded-md border border-danger-border bg-danger-wash p-3'
              : 'mb-3 rounded-md border border-warning-border bg-warning-wash p-3'
          }
        >
          <p
            className={
              errors.length > 0
                ? 'text-body font-semibold text-danger-strong'
                : 'text-body font-semibold text-warning-strong'
            }
          >
            {errors.length > 0
              ? `Activation blocked: ${errors.length} node-level error${errors.length === 1 ? '' : 's'}`
              : `Activation is available, with ${data.validation.issues.length} warning${data.validation.issues.length === 1 ? '' : 's'}`}
          </p>
          <ul className="mt-2 space-y-1.5">
            {data.validation.issues.map((issue) => (
              <li key={issue.id} className="flex flex-wrap items-start gap-2 text-meta">
                <Badge tone={issue.severity === 'error' ? 'danger' : 'caution'} size="sm">
                  {issue.severity}
                </Badge>
                <span className="min-w-0 flex-1 text-muted">
                  <span className="font-medium text-text">{issue.message}</span>
                  <span className="mt-0.5 block text-link">{issue.remediation}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'canvas', label: 'Canvas' },
          { value: 'trigger', label: 'Trigger' },
          { value: 'runs', label: 'Runs' },
        ]}
      >
        <TabPanel value="canvas" className="pt-3">
          <WorkflowCanvas workflow={data} selectedId={selectedNode} onSelect={setSelectedNode} />
          <Panel className="mt-3">
            <PanelHeader eyebrow="Governance" title="Write-target authorization" />
            <Grid cols={2} className="p-4">
              <div>
                <p className="mb-1 font-mono text-faint label-caps">Targets</p>
                <ul className="space-y-1">
                  {data.writeTargets.map((target) => (
                    <li
                      key={target.entryKey}
                      className="flex items-center justify-between gap-2 rounded-xs border border-line bg-panel-soft px-2 py-1.5"
                    >
                      <span className="text-meta text-text">
                        {target.entryKey} · {target.product}
                      </span>
                      <Badge tone="caution" size="sm">
                        {target.mode}
                      </Badge>
                    </li>
                  ))}
                </ul>
                {data.writeTargets.length === 0 ? (
                  <InlineNote>
                    No write target: this workflow is read-only, so entitlement to each source is
                    the only authorization it needs.
                  </InlineNote>
                ) : null}
              </div>
              {/* FR-5.9: the note used to open with the id — "FR-5.9: a user may create or modify
                  a workflow only if they hold R1, R3 over the domain, …". */}
              <p className="text-meta leading-relaxed text-muted">
                A user may create or modify a workflow only if they hold R1, R3 over the domain, or
                R4 over the only write target. Read-only targets require entitlement only. Manual
                replays are audited.
              </p>
            </Grid>
          </Panel>
        </TabPanel>
        <TabPanel value="trigger" className="pt-3">
          {/*
            FR-5.4: the header already shows the trigger as a badge; this is where it is edited.
            The panel owns its own mutation and notice so a save cannot be mistaken for the
            activate/validate banner that belongs to the header above.
          */}
          <WorkflowTriggerPanel key={data.id} workflow={data} canWrite={canWrite} />
        </TabPanel>
        <TabPanel value="runs" className="pt-3">
          <Panel inset>
            <WorkflowRunsPanel workflow={data} />
          </Panel>
        </TabPanel>
      </Tabs>
    </Page>
  );
}

/**
 * `POST /workflows/:id/:action` answers with a union of three shapes. `validate` is the only one
 * that carries `checkedAt` + `issues`, so the discriminant is structural rather than a second field
 * the contract does not have.
 */
function asValidationResult(value: unknown): WorkflowValidationResult | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('checkedAt' in value) || !('issues' in value) || !Array.isArray(value.issues)) return null;
  return value as WorkflowValidationResult;
}

/**
 * `duplicate` and `activate`/`disable` answer with the workflow itself, narrowed the same way —
 * the union carries no published discriminant, so identity is checked structurally.
 */
function asWorkflow(value: unknown): Workflow | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('id' in value) || !('name' in value) || !('state' in value)) return null;
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  return value as Workflow;
}
