import { http, HttpResponse } from 'msw';
import {
  writeIneligibilityReason,
  type PlatformRole,
  type Workflow,
  type WorkflowRun,
} from '@seamnex/domain';
import { at } from '../fixtures/context';
import { isEntitled } from '../fixtures/portal';
import { appendAudit, getState } from '../store';
import { actorFor, deny, problem, readBody, requireCapability, roleOf } from './utils';

function findWorkflow(id: string): Workflow | undefined {
  return getState().workflows.find((workflow) => workflow.id === id);
}

function targetInstanceIds(writeTargets: Workflow['writeTargets']): string[] {
  return getState()
    .instances.filter((instance) =>
      writeTargets.some((target) => instance.entryKeys.includes(target.entryKey)),
    )
    .map((instance) => instance.id);
}

/** FR-5.9: authority follows the write targets, not the workflow's existence. */
function workflowScopeProblem(role: PlatformRole, ids: string[]) {
  if (role === 'R1') return null;
  if (role === 'R3') {
    if (ids.every((id) => isEntitled('R3', id))) return null;
    return problem(
      403,
      'WORKFLOW_SCOPE',
      'You do not own every write target',
      'A domain owner may only author or run workflows whose write targets are inside their own domain.',
      'Remove the targets outside your domain, or ask the platform administrator.',
    );
  }
  if (role === 'R4') {
    if (ids.length === 1 && isEntitled('R4', ids[0] ?? '')) return null;
    return problem(
      403,
      'WORKFLOW_SCOPE',
      'A product administrator may write to exactly one instance',
      'R4 authority is limited to the single instance they administer; read-only targets are allowed.',
      'Use one write target that you administer.',
    );
  }
  return problem(
    403,
    'WORKFLOW_SCOPE',
    'This role cannot author workflows',
    'Workflow authoring needs platform or domain authority.',
    'Ask the platform administrator.',
  );
}

export const workflowHandlers = [
  /**
   * Mirrors `PostgresWorkflowService.list`: the same `q`/`state`/`limit`/`offset` surface and the
   * same `x-total-count`, so a screen that pages or filters behaves identically against the mock
   * platform and the real API.
   */
  http.get('/api/v1/workflows', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.view_runs');
    if (guard) return guard;
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const state = url.searchParams.get('state');
    const matched = getState().workflows.filter((workflow) => {
      if (state !== null && workflow.state !== state) return false;
      if (q.length === 0) return true;
      return (
        workflow.name.toLowerCase().includes(q) ||
        (workflow.description ?? '').toLowerCase().includes(q)
      );
    });
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam === null ? null : Number.parseInt(limitParam, 10);
    const page = limit === null ? matched.slice(offset) : matched.slice(offset, offset + limit);
    return HttpResponse.json(page, { headers: { 'x-total-count': String(matched.length) } });
  }),

  http.get('/api/v1/workflows/:id', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.view_runs');
    if (guard) return guard;
    const workflow = findWorkflow(String(params.id));
    if (!workflow) {
      return problem(
        404,
        'WORKFLOW_NOT_FOUND',
        'Workflow not found',
        'The workflow no longer exists.',
        'Open the workflow list and retry.',
      );
    }
    return HttpResponse.json(workflow);
  }),

  /** FR-5.1: authoring starts from discovered operations, not from a blank canvas. */
  http.post('/api/v1/workflows', async ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R3', 'R4'], 'workflow.create');
    if (guard) return guard;
    const state = getState();
    const body = await readBody<{
      name?: string;
      description?: string;
      triggerType?: 'schedule' | 'webhook' | 'poll' | 'manual';
      sourceInstanceId?: string;
      targetInstanceId?: string;
    }>(request);
    const name = (body.name ?? '').trim();
    const source = state.registry.find((item) => item.instanceId === body.sourceInstanceId);
    const target = state.registry.find((item) => item.instanceId === body.targetInstanceId);

    if (!source || !target) {
      return problem(
        422,
        'WORKFLOW_INVALID',
        'The workflow needs a source and a write target',
        'Both products must be deployed and discoverable in the registry.',
        'Pick a discovered source and write target, then retry.',
        [
          { field: 'sourceInstanceId', code: 'required', message: 'Choose a source instance.' },
          { field: 'targetInstanceId', code: 'required', message: 'Choose a write target.' },
        ],
      );
    }
    if (name.length < 3) {
      return problem(
        422,
        'WORKFLOW_INVALID',
        'The workflow needs a name',
        'Names are how operators recognise a workflow in the run history.',
        'Use at least three characters.',
        [{ field: 'name', code: 'minLength', message: 'At least 3 characters.' }],
      );
    }
    // C-11 / FR-5.3. `writeEligible` is derived from the recorded granularity, so this fires for
    // `account` as well as `none` — the reason differs, and the message says which one applies.
    if (!target.writeEligible) {
      return problem(
        422,
        'WRITE_NOT_ELIGIBLE',
        'This product has no write-capable credential',
        `${target.product}: ${writeIneligibilityReason(target.credentialGranularity) ?? 'no write credential can be brokered.'}`,
        'Choose a write-eligible target, or ask the platform administrator to record a scoped credential for this product.',
      );
    }
    const scope = workflowScopeProblem(role, [target.instanceId]);
    if (scope) return scope;

    const readOp =
      source.operations.find((operation) => operation.mode === 'read') ?? source.operations[0];
    const writeOp = target.operations.find((operation) => operation.mode === 'write');
    if (!readOp || !writeOp) {
      return problem(
        422,
        'OPERATION_MISSING',
        'No discovered operation pair',
        'The registry does not expose a read and a write operation for this pair.',
        'Verify the metadata for both products, then retry.',
      );
    }

    const id = `wf-${1100 + state.workflows.length}`;
    const triggerType = body.triggerType ?? 'schedule';
    const trigger: Workflow['trigger'] =
      triggerType === 'webhook'
        ? {
            type: 'webhook',
            label: `Inbound ${target.product} webhook`,
            config: `/hooks/${id}`,
            timezone: null,
          }
        : triggerType === 'poll'
          ? {
              type: 'poll',
              label: `Poll ${source.product}`,
              config: 'every 15 minutes',
              timezone: null,
            }
          : triggerType === 'manual'
            ? {
                type: 'manual',
                label: 'Manual run',
                config: 'run from the console',
                timezone: null,
              }
            : {
                type: 'schedule',
                label: 'Weekday schedule',
                config: '0 3 * * 1-5',
                timezone: 'Europe/Berlin',
              };

    const draft: Workflow = {
      id,
      name,
      description:
        (body.description ?? '').trim() ||
        `Copy ${readOp.label.toLowerCase()} from ${source.product} into ${target.product} on ${triggerType === 'schedule' ? 'a schedule' : triggerType}.`,
      owner: { id: actorFor(role).id, name: actorFor(role).name },
      state: 'draft',
      version: 1,
      irHash: `sha256:${id}-v1`,
      trigger,
      writeTargets: [{ entryKey: target.entryKey, product: target.product, mode: 'write' }],
      nodes: [
        {
          id: 'node-trigger',
          kind: 'trigger',
          label: readOp.label,
          product: source.product,
          entryKey: source.entryKey,
          operation: readOp.id,
          mode: 'read',
          x: 40,
          y: 150,
          summary: `${readOp.description} Read through the brokered credential for ${source.product}.`,
          mappings: [],
        },
        {
          id: 'node-action',
          kind: 'action',
          label: writeOp.label,
          product: target.product,
          entryKey: target.entryKey,
          operation: writeOp.id,
          mode: 'write',
          x: 340,
          y: 150,
          summary: `${writeOp.description} Written to ${target.product}.`,
          mappings: [],
        },
      ],
      edges: [{ id: 'edge-1', source: 'node-trigger', target: 'node-action', mappings: [] }],
      credentialScopes: [],
      validation: {
        valid: false,
        checkedAt: null,
        issues: [
          {
            id: 'vi-1',
            nodeId: 'node-action',
            severity: 'error',
            code: 'MAPPING_REQUIRED',
            message: `Map at least one ${source.product} field onto ${writeOp.label}.`,
            remediation: 'Open the mapping panel on the edge and choose the write fields.',
          },
          {
            id: 'vi-2',
            nodeId: 'node-action',
            severity: 'warning',
            code: 'OWNER_ACK',
            message: 'A write workflow needs an owner acknowledgement before its first activation.',
            remediation: 'Confirm the owner on the workspace header.',
          },
        ],
      },
      createdAt: at(0),
      updatedAt: at(0),
      lastRunAt: null,
      lastRunState: null,
      enabled: false,
    };

    state.workflows = [draft, ...state.workflows];
    appendAudit({
      action: 'workflow.created',
      targetType: 'workflow',
      targetId: draft.id,
      targetLabel: draft.name,
      outcome: 'success',
      detail: `Draft created from the discovered operations ${source.entryKey}:${readOp.id} → ${target.entryKey}:${writeOp.id}; validation blocks activation until a mapping exists.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(draft, { status: 201 });
  }),

  http.delete('/api/v1/workflows/:id', ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R3', 'R4'], 'workflow.delete');
    if (guard) return guard;
    const workflow = findWorkflow(String(params.id));
    if (!workflow) {
      return problem(
        404,
        'WORKFLOW_NOT_FOUND',
        'Workflow not found',
        'The workflow no longer exists.',
        'Open the workflow list and retry.',
      );
    }
    if (workflow.state === 'active') {
      return problem(
        409,
        'WORKFLOW_ACTIVE',
        'Disable the workflow before deleting it',
        'An active workflow still owns trigger endpoints and credential scopes; deletion would strand them.',
        'Disable the workflow, then delete the draft.',
      );
    }
    const scope = workflowScopeProblem(role, targetInstanceIds(workflow.writeTargets));
    if (scope) return scope;
    getState().workflows = getState().workflows.filter((item) => item.id !== workflow.id);
    appendAudit({
      action: 'workflow.deleted',
      targetType: 'workflow',
      targetId: workflow.id,
      targetLabel: workflow.name,
      outcome: 'success',
      detail: `Workflow ${workflow.id} deleted; trigger endpoints and credential scopes released.`,
      actor: actorFor(role),
    });
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('/api/v1/workflows/:id/:action', async ({ params, request }) => {
    const role = roleOf(request);
    const action = String(params.action);
    const guard = deny(role, ['R1', 'R3', 'R4'], `workflow.${action}`);
    if (guard) return guard;
    const workflow = findWorkflow(String(params.id));
    if (!workflow) {
      return problem(
        404,
        'WORKFLOW_NOT_FOUND',
        'Workflow not found',
        'The workflow no longer exists.',
        'Open the workflow list and retry.',
      );
    }
    if (action !== 'validate') {
      const scope = workflowScopeProblem(role, targetInstanceIds(workflow.writeTargets));
      if (scope) return scope;
    }

    if (action === 'validate') {
      workflow.validation.checkedAt = at(0);
      workflow.validation.valid = workflow.validation.issues.every(
        (issue) => issue.severity !== 'error',
      );
      // Same rule as the API: a clean pass promotes anything that is not active, and an active
      // workflow is never demoted by a check. `disabled` used to stay disabled after a green pass,
      // so the state pill and the enabled Activate button disagreed.
      if (workflow.validation.valid && workflow.state !== 'active') workflow.state = 'validated';
      appendAudit({
        action: 'workflow.validated',
        targetType: 'workflow',
        targetId: workflow.id,
        targetLabel: workflow.name,
        outcome: workflow.validation.valid ? 'success' : 'failure',
        detail: workflow.validation.valid
          ? `Validation passed with ${workflow.validation.issues.length} warning(s).`
          : `Validation blocked activation with ${workflow.validation.issues.filter((issue) => issue.severity === 'error').length} error(s).`,
        actor: actorFor(role),
      });
      return HttpResponse.json({
        valid: workflow.validation.valid,
        checkedAt: workflow.validation.checkedAt,
        issues: workflow.validation.issues,
      });
    }

    if (action === 'activate') {
      if (!workflow.validation.valid) {
        return problem(
          422,
          'WORKFLOW_INVALID',
          'Workflow cannot be activated',
          `${workflow.validation.issues.filter((issue) => issue.severity === 'error').length} blocking validation errors remain.`,
          'Resolve the node-level errors, then validate again before activating.',
        );
      }
      workflow.state = 'active';
      workflow.enabled = true;
      workflow.updatedAt = at(0);
      appendAudit({
        action: 'workflow.activated',
        targetType: 'workflow',
        targetId: workflow.id,
        targetLabel: workflow.name,
        outcome: 'success',
        detail: `Version ${workflow.version} activated; write targets ${workflow.writeTargets.map((target) => target.entryKey).join(', ')}.`,
        actor: actorFor(role),
      });
      return HttpResponse.json(workflow);
    }

    if (action === 'disable') {
      workflow.state = 'disabled';
      workflow.enabled = false;
      workflow.updatedAt = at(0);
      appendAudit({
        action: 'workflow.disabled',
        targetType: 'workflow',
        targetId: workflow.id,
        targetLabel: workflow.name,
        outcome: 'success',
        detail: 'Trigger endpoints paused; run history retained.',
        actor: actorFor(role),
      });
      return HttpResponse.json(workflow);
    }

    if (action === 'run') {
      if (workflow.state !== 'active') {
        return problem(
          409,
          'WORKFLOW_INACTIVE',
          'Workflow is not active',
          'Activate the workflow before running it.',
          'Validate and activate, or start a test run from a draft in the sandbox.',
        );
      }
      const run: WorkflowRun = {
        id: `run-${9000 + getState().workflowRuns.length}`,
        workflowId: workflow.id,
        workflowName: workflow.name,
        version: workflow.version,
        trigger: 'manual',
        state: 'succeeded',
        startedAt: at(0),
        finishedAt: at(0),
        durationMs: 4_200,
        idempotencyKey: `manual:${workflow.id}:run-${9000 + getState().workflowRuns.length}`,
        replayOf: null,
        recordsProcessed: 1,
        nodes: workflow.nodes.map((node) => ({
          nodeId: node.id,
          label: node.label,
          state: 'succeeded' as const,
          attempt: 1,
          durationMs: 640,
          records: 1,
          error: null,
        })),
        error: null,
      };
      getState().workflowRuns = [run, ...getState().workflowRuns];
      workflow.lastRunAt = run.startedAt;
      workflow.lastRunState = 'succeeded';
      appendAudit({
        action: 'workflow.run.succeeded',
        targetType: 'workflow',
        targetId: workflow.id,
        targetLabel: workflow.name,
        outcome: 'success',
        detail: `Manual run ${run.id} completed; ${run.recordsProcessed} record(s) processed.`,
        actor: actorFor(role),
      });
      return HttpResponse.json(run, { status: 201 });
    }

    if (action === 'duplicate') {
      const copy: Workflow = {
        ...structuredClone(workflow),
        id: `wf-copy-${getState().workflows.length + 1}`,
        name: `${workflow.name} (copy)`,
        state: 'draft',
        enabled: false,
        version: 1,
        createdAt: at(0),
        updatedAt: at(0),
        lastRunAt: null,
        lastRunState: null,
      };
      getState().workflows = [copy, ...getState().workflows];
      appendAudit({
        action: 'workflow.duplicated',
        targetType: 'workflow',
        targetId: copy.id,
        targetLabel: copy.name,
        outcome: 'success',
        detail: `Draft copy created from ${workflow.id}; write targets copied and credentials re-issued on activation.`,
        actor: actorFor(role),
      });
      return HttpResponse.json(copy, { status: 201 });
    }

    return problem(
      404,
      'UNKNOWN_ACTION',
      'Unknown workflow action',
      `"${action}" is not supported.`,
      'Use validate, activate, disable, run or duplicate.',
    );
  }),

  http.patch('/api/v1/workflows/:id', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R3', 'R4'], 'workflow.author');
    if (guard) return guard;
    const workflow = findWorkflow(String(params.id));
    if (!workflow) {
      return problem(
        404,
        'WORKFLOW_NOT_FOUND',
        'Workflow not found',
        'The workflow no longer exists.',
        'Open the workflow list and retry.',
      );
    }
    const body = await readBody<{ name?: string; description?: string | null }>(request);
    const previousName = workflow.name;
    if (typeof body.name === 'string' && body.name.trim().length > 0)
      workflow.name = body.name.trim();
    // `null` clears the description; an empty string is refused by the contract, as on the API.
    if (body.description === null) workflow.description = null;
    else if (typeof body.description === 'string' && body.description.trim().length > 0) {
      workflow.description = body.description;
    }
    workflow.updatedAt = at(0);
    appendAudit({
      action: 'workflow.updated',
      targetType: 'workflow',
      targetId: workflow.id,
      targetLabel: workflow.name,
      outcome: 'success',
      detail: `Workflow metadata changed${previousName === workflow.name ? '' : `: "${previousName}" → "${workflow.name}"`}. Mapping edits remain out of scope (EX-2).`,
      actor: actorFor(role),
    });
    return HttpResponse.json(workflow);
  }),

  /** FR-5.11: an imported document lands as a disabled draft, never as a live workflow. */
  http.post('/api/v1/workflows/import', async ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R3', 'R4'], 'workflow.import');
    if (guard) return guard;
    const body = await readBody<{ document?: { apiVersion?: string; workflow?: Workflow } }>(
      request,
    );
    const source = body.document?.workflow;
    if (!source || typeof source.name !== 'string' || source.name.trim().length === 0) {
      return problem(
        422,
        'IMPORT_INVALID',
        'The document is not an exported workflow',
        'The payload must carry apiVersion, exportedAt, irHash and a workflow object.',
        'Export a workflow from its workspace and paste that document unchanged.',
        [
          {
            field: 'document',
            code: 'required',
            message: 'A workflow export document is required.',
          },
        ],
      );
    }
    if (body.document?.apiVersion !== 'seamnex.workflow/v1') {
      return problem(
        422,
        'IMPORT_VERSION_UNSUPPORTED',
        'Unsupported document version',
        `Expected apiVersion seamnex.workflow/v1, received ${body.document?.apiVersion ?? 'none'}.`,
        'Re-export the workflow from a platform build that supports seamnex.workflow/v1.',
        [
          {
            field: 'document.apiVersion',
            code: 'unsupported',
            message: 'Only seamnex.workflow/v1 is accepted.',
          },
        ],
      );
    }
    const imported: Workflow = {
      ...structuredClone(source),
      id: `wf-import-${getState().workflows.length + 1}`,
      name: `${source.name} (imported)`,
      state: 'draft',
      enabled: false,
      version: 1,
      createdAt: at(0),
      updatedAt: at(0),
      lastRunAt: null,
      lastRunState: null,
      trigger: { ...source.trigger, config: 'Imported document; activate to bind a trigger.' },
    };
    getState().workflows = [imported, ...getState().workflows];
    appendAudit({
      action: 'workflow.imported',
      targetType: 'workflow',
      targetId: imported.id,
      targetLabel: imported.name,
      outcome: 'success',
      detail: `Workflow imported from ${source.id} as a disabled draft; activation requires validation.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(imported, { status: 201 });
  }),

  http.get('/api/v1/workflows/:id/runs', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.view_runs');
    if (guard) return guard;
    const workflowId = String(params.id);
    // An unknown workflow is 404, as on the API: `[]` would read as "this workflow never ran".
    if (!findWorkflow(workflowId)) {
      return problem(
        404,
        'WORKFLOW_NOT_FOUND',
        'Workflow not found',
        'The workflow no longer exists.',
        'Open the workflow list and retry.',
      );
    }
    const runs = getState().workflowRuns.filter((run) => run.workflowId === workflowId);
    return HttpResponse.json(runs);
  }),

  http.get('/api/v1/workflow-runs/:runId', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.view_runs');
    if (guard) return guard;
    const run = getState().workflowRuns.find((item) => item.id === String(params.runId));
    if (!run) {
      return problem(
        404,
        'RUN_NOT_FOUND',
        'Run not found',
        'The run is outside the 30-day retention window.',
        'Open the workflow and choose another run.',
      );
    }
    return HttpResponse.json(run);
  }),

  http.post('/api/v1/workflow-runs/:runId/replay', ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R3'], 'workflow.run');
    if (guard) return guard;
    const run = getState().workflowRuns.find((item) => item.id === String(params.runId));
    if (!run) {
      return problem(
        404,
        'RUN_NOT_FOUND',
        'Run not found',
        'The run is outside the retention window.',
        'Choose another run.',
      );
    }
    if (run.state !== 'failed') {
      return problem(
        409,
        'RUN_NOT_FAILED',
        'Only failed runs can be replayed',
        `Run ${run.id} is ${run.state}.`,
        'Replay exists for the failed-run queue.',
      );
    }
    const replay: WorkflowRun = {
      ...structuredClone(run),
      id: `run-${9000 + getState().workflowRuns.length}`,
      state: 'succeeded',
      startedAt: at(0),
      finishedAt: at(0),
      replayOf: run.id,
      error: null,
      nodes: run.nodes.map((node) => ({
        ...node,
        state: 'succeeded' as const,
        error: null,
        records: 1,
      })),
    };
    getState().workflowRuns = [replay, ...getState().workflowRuns];
    appendAudit({
      action: 'workflow.run.replayed',
      targetType: 'workflow',
      targetId: run.workflowId,
      targetLabel: run.workflowName,
      outcome: 'success',
      detail: `Failed run ${run.id} replayed as ${replay.id}; idempotency key preserved.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(replay, { status: 201 });
  }),

  http.get('/api/v1/workflows/:id/export', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.view_runs');
    if (guard) return guard;
    const workflow = findWorkflow(String(params.id));
    if (!workflow) {
      return problem(
        404,
        'WORKFLOW_NOT_FOUND',
        'Workflow not found',
        'The workflow no longer exists.',
        'Open the workflow list and retry.',
      );
    }
    return HttpResponse.json({
      apiVersion: 'seamnex.workflow/v1',
      exportedAt: at(0),
      irHash: workflow.irHash,
      workflow,
    });
  }),
];
