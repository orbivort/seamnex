import { http, HttpResponse } from 'msw';
import { admissionVerdict } from '@seamnex/domain';
import type {
  BreakGlassReveal,
  CredentialScopeMintResult,
  DeployPreview,
  MaintenanceWindow,
  OperationsResponse,
  PlatformRestoreStatus,
  TriggerEndpoint,
  Workflow,
  WorkflowNode,
} from '@seamnex/domain';
import { at, PLATFORM_DOMAIN } from '../fixtures/context';
import { fieldFixture, sampleItemFor } from '../fixtures/field-snapshots';
import { appendAudit, getState } from '../store';
import { DEPLOY_STEPS, enqueueJob } from './job-factory';
import { actorFor, problem, readBody, requireCapability, roleOf } from './utils';

/**
 * Phase 4 operations in the mock server.
 *
 * Two rules this file follows:
 *   - it is registered **before** the handlers it could shadow (`/instances/:id/:action`,
 *     `/workflows/:id/:action`, `/break-glass-sessions/:id/:action`), because a dynamic segment
 *     would otherwise swallow `triggers`, `nodes` and `reveal`;
 *   - the authoring endpoints acknowledge the edit and return the unchanged definition. The
 *     prototype canvas stays read-only (EX-2); pretending a node was added would make a screenshot
 *     disagree with the API, which is worse than an honest no-op.
 */
/**
 * The API files every authoring edit as a new version, moves an active workflow to `disabled` and
 * clears the validation stamp (`WorkflowAuthoringService.mutate`). The mock used to answer with the
 * definition unchanged, so the demo showed "ACTIVE / VERSION 4" immediately after the drawer
 * promised the save would disable the schedule — the one sentence this screen must never contradict.
 */
function fileVersion(workflow: Workflow): void {
  workflow.version += 1;
  workflow.state = workflow.state === 'active' ? 'disabled' : 'draft';
  workflow.validation = { valid: false, checkedAt: null, issues: [] };
  workflow.updatedAt = at(0);
}

export const phase4Handlers = [
  // ---- 4A ------------------------------------------------------------------------------------
  http.post('/api/v1/instances/preview', async ({ request }) => {
    const guard = requireCapability(roleOf(request), 'instance.deploy');
    if (guard) return guard;
    const body = await readBody<{
      slug?: string;
      resources?: { cpu: number; memoryMb: number; diskMb: number };
    }>(request);
    const state = getState();
    const requested = body.resources ?? { cpu: 1, memoryMb: 1024, diskMb: 2048 };
    const capacity = state.capacity;

    // The same function the server and the wizard use, so the preview cannot disagree with the API.
    const outcome = admissionVerdict({
      host: {
        cpu: capacity.host.cpuCores,
        memoryMb: capacity.host.memoryMb,
        diskMb: capacity.host.diskMb,
      },
      reserve: {
        cpu: capacity.platformReserve.cpuCores,
        memoryMb: capacity.platformReserve.memoryMb,
        diskMb: capacity.platformReserve.diskMb,
      },
      allocated: {
        cpu: capacity.allocated.cpuCores,
        memoryMb: capacity.allocated.memoryMb,
        diskMb: capacity.allocated.diskMb,
      },
      request: requested,
      oversubscriptionFactor: capacity.oversubscriptionFactor,
    });

    // Integers, like the API: the shortfall schema is whole mebibytes, and `used - limits` is a
    // fraction as soon as the 95 %/90 % headroom ratios are applied.
    const limitsMb = {
      memoryMb: Math.round(outcome.limits.memoryMb),
      diskMb: Math.round(outcome.limits.diskMb),
    };
    const usedMb = {
      memoryMb: Math.round(outcome.used.memoryMb),
      diskMb: Math.round(outcome.used.diskMb),
    };

    const preview: DeployPreview = {
      admissible: outcome.admissible,
      headline: outcome.headline,
      detail: outcome.detail,
      shortfall: {
        cpuMilli: Math.max(0, Math.round((outcome.used.cpu - outcome.limits.cpu) * 1000)),
        memoryMb: Math.max(0, usedMb.memoryMb - limitsMb.memoryMb),
        diskMb: Math.max(0, usedMb.diskMb - limitsMb.diskMb),
      },
      capacitySource: 'measured',
      /*
       * The domain the rest of the platform publishes under. The review step asked the operator to
       * confirm `espocrm.platform.local` while the job it accepted provisioned
       * `espocrm.seamnex.local` — two different hosts for the one action being confirmed.
       */
      routeHost: `${body.slug ?? 'new-instance'}.${PLATFORM_DOMAIN}`,
      slugAvailable: !state.instances.some((instance) => instance.slug === body.slug),
      policyVerdict: 'allowed',
      warnings: [],
      evaluatedAt: at(0),
    };
    return HttpResponse.json(preview);
  }),

  http.post('/api/v1/catalog/:key/prefetch', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'metadata.manage');
    if (guard) return guard;
    return HttpResponse.json(
      enqueueJob({
        kind: 'prepull',
        instanceId: null,
        entryKey: String(params.key),
        label: `Prefetch ${String(params.key)}`,
        requestedBy: actorFor(roleOf(request)).name,
        summary:
          'Pre-pull the images this entry references so a deployment window is not spent downloading.',
        steps: DEPLOY_STEPS.slice(0, 2).concat('Pull images'),
      }),
      { status: 202 },
    );
  }),

  // ---- 4E triggers and credential scopes ------------------------------------------------------
  http.get('/api/v1/instances/:id/triggers', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.credentials');
    if (guard) return guard;
    void params;
    return HttpResponse.json([] as TriggerEndpoint[]);
  }),

  http.post('/api/v1/instances/:id/triggers', async ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.credentials');
    if (guard) return guard;
    const body = await readBody<{ eventName?: string; workflowId?: string }>(request);
    const endpoint: TriggerEndpoint = {
      id: `trg-${getState().jobs.length + 1}`,
      instanceId: String(params.id),
      workflowId: body.workflowId ?? null,
      eventName: body.eventName ?? 'record.created',
      state: 'active',
      registeredAt: at(0),
      url: `https://${String(params.id)}.${PLATFORM_DOMAIN}/hooks/${getState().jobs.length + 1}`,
      secret: 'shown-once-in-the-prototype',
    };
    return HttpResponse.json(endpoint);
  }),

  http.delete('/api/v1/instances/:id/triggers/:triggerId', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.credentials');
    if (guard) return guard;
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('/api/v1/instances/:id/credential-scopes', async ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.credentials');
    if (guard) return guard;
    const body = await readBody<{ operations?: string[]; mode?: 'read' | 'write' }>(request);
    const minted: CredentialScopeMintResult = {
      scopeId: `scope-${getState().jobs.length + 1}`,
      secretRef: `secret://workflow/${String(params.id)}/${getState().jobs.length + 1}`,
      expiresAt: at(90 * 24 * 60),
      mode: body.mode ?? 'read',
      operations: body.operations ?? [],
    };
    return HttpResponse.json(minted);
  }),

  http.delete('/api/v1/credential-scopes/:id', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.credentials');
    if (guard) return guard;
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('/api/v1/workflow-approvals/:token/decision', async ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.approve');
    if (guard) return guard;
    const body = await readBody<{ decision?: 'approve' | 'reject' }>(request);
    void params;
    return HttpResponse.json({
      runId: 'run-2001',
      nodeId: 'node-approval',
      state: body.decision === 'reject' ? 'failed' : 'running',
      decidedAt: at(0),
    });
  }),

  // ---- 4E authoring (canvas remains read-only, EX-2) -----------------------------------------
  http.post('/api/v1/workflows/:id/nodes', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.author');
    if (guard) return guard;
    return workflowResponse(String(params.id));
  }),

  /*
   * The mapping drawer's operation select sends `operation`, `label` and `summary` together, so the
   * mock has to apply them: answering with the definition unchanged made the rail's one editable
   * control look broken, one screen after the same file was fixed to make the mapping save real.
   */
  http.patch('/api/v1/workflows/:id/nodes/:nodeId', async ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.author');
    if (guard) return guard;
    const workflow = getState().workflows.find((item) => item.id === String(params.id));
    if (!workflow) return workflowResponse(String(params.id));
    const nodeId = String(params.nodeId);
    const node = workflow.nodes.find((entry) => entry.id === nodeId);
    if (!node) {
      return problem(
        404,
        'NODE_NOT_FOUND',
        'Node not found',
        `No node ${nodeId} in this workflow.`,
        'Reload the workflow and try again.',
      );
    }
    const patch =
      await readBody<
        Partial<Pick<WorkflowNode, 'label' | 'operation' | 'mode' | 'summary' | 'x' | 'y'>>
      >(request);
    Object.assign(node, patch);
    fileVersion(workflow);
    return HttpResponse.json(workflow as Workflow);
  }),

  http.delete('/api/v1/workflows/:id/nodes/:nodeId', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.author');
    if (guard) return guard;
    return workflowResponse(String(params.id));
  }),

  /*
   * The mapping PUT used to answer with the unchanged workflow, which is exactly what a failed save
   * looks like: the drawer refetched and showed the old rows again. It now writes to the same array
   * the detail endpoint serves, and refuses a blank side the way `FieldMappingSchema` does.
   */
  http.put('/api/v1/workflows/:id/nodes/:nodeId/mappings', async ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.author');
    if (guard) return guard;
    const workflow = getState().workflows.find((item) => item.id === String(params.id));
    if (!workflow) return workflowResponse(String(params.id));
    const nodeId = String(params.nodeId);
    const node = workflow.nodes.find((entry) => entry.id === nodeId);
    if (!node) {
      return problem(
        404,
        'NODE_NOT_FOUND',
        'Node not found',
        `No node ${nodeId} in this workflow.`,
        'Reload the workflow and try again.',
      );
    }
    const body = await readBody<{
      mappings?: { from?: string; to?: string; transform?: string | null }[];
    }>(request);
    const incoming = body.mappings ?? [];
    const blank = incoming.some(
      (row) => (row.from ?? '').trim().length === 0 || (row.to ?? '').trim().length === 0,
    );
    if (blank) {
      return problem(
        422,
        'INVALID_MAPPING',
        'Every mapping needs both sides',
        'A mapping with an empty source path or target field cannot be compiled.',
        'Fill both sides of each row, or remove the row.',
      );
    }
    const mappings = incoming.map((row) => ({
      from: String(row.from).trim(),
      to: String(row.to).trim(),
      transform: row.transform ?? null,
    }));
    node.mappings = mappings;
    const inbound = workflow.edges.find((edge) => edge.target === nodeId);
    if (inbound) inbound.mappings = mappings;
    fileVersion(workflow);
    return HttpResponse.json(workflow as Workflow);
  }),

  http.get('/api/v1/workflows/:id/nodes/:nodeId/fields', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.author');
    if (guard) return guard;
    const workflow = getState().workflows.find((item) => item.id === String(params.id));
    if (!workflow) return workflowResponse(String(params.id));
    const node = workflow.nodes.find((entry) => entry.id === String(params.nodeId));
    if (!node) {
      return problem(
        404,
        'NODE_NOT_FOUND',
        'Node not found',
        `No node ${String(params.nodeId)} in this workflow.`,
        'Reload the workflow and try again.',
      );
    }
    const fixture = fieldFixture(node.entryKey, node.operation);
    return HttpResponse.json({
      nodeId: node.id,
      entryKey: node.entryKey,
      operation: node.operation,
      status: fixture.status,
      fields: fixture.fields,
      fetchedAt: at(0),
      detail: fixture.detail,
    });
  }),

  http.get('/api/v1/workflows/:id/nodes/:nodeId/sample', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.author');
    if (guard) return guard;
    const workflow = getState().workflows.find((item) => item.id === String(params.id));
    if (!workflow) return workflowResponse(String(params.id));
    const node = workflow.nodes.find((entry) => entry.id === String(params.nodeId));
    if (!node) {
      return problem(
        404,
        'NODE_NOT_FOUND',
        'Node not found',
        `No node ${String(params.nodeId)} in this workflow.`,
        'Reload the workflow and try again.',
      );
    }
    const inbound = workflow.edges.find((edge) => edge.target === node.id);
    const item = sampleItemFor(workflow.id);
    return HttpResponse.json({
      nodeId: node.id,
      sourceNodeId: inbound?.source ?? node.id,
      runId: item === null ? null : 'run-2041',
      capturedAt: item === null ? null : at(-0.25),
      item,
      truncated: false,
    });
  }),

  http.put('/api/v1/workflows/:id/trigger', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'workflow.author');
    if (guard) return guard;
    return workflowResponse(String(params.id));
  }),

  // ---- 4F governance -------------------------------------------------------------------------
  http.post('/api/v1/audit-events/verify', async ({ request }) => {
    const guard = requireCapability(roleOf(request), 'audit.verify');
    if (guard) return guard;
    const body = await readBody<{ fromSeq?: number; toSeq?: number }>(request);
    const fromSeq = body.fromSeq ?? 1;
    const toSeq = body.toSeq ?? fromSeq;
    return HttpResponse.json({
      fromSeq,
      toSeq,
      valid: true,
      firstBrokenSeq: null,
      checked: Math.max(0, toSeq - fromSeq + 1),
      verifiedAt: at(0),
    });
  }),

  http.post('/api/v1/break-glass-sessions/:id/reveal', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'breakglass.request');
    if (guard) return guard;
    const session = getState().breakGlass.find((item) => item.id === String(params.id));
    if (!session || session.state !== 'active') {
      return problem(
        409,
        'STATE_CONFLICT',
        'The elevation is not active',
        'A credential is revealed only while the session is active.',
        'Approve the request first, then reveal within the granted window.',
      );
    }
    const reveal: BreakGlassReveal = {
      username: `bg-${session.instanceId}`,
      password: 'one-time-credential-shown-once',
      methodNote: 'Account created through the product API; password rotated on revocation.',
      expiresAt: at(1),
    };
    return HttpResponse.json(reveal);
  }),

  http.post('/api/v1/admin/settings/alerts/:id/test', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'alert.configure');
    if (guard) return guard;
    return HttpResponse.json({
      channelId: String(params.id),
      ok: true,
      detail: 'Test notification accepted by the channel.',
      deliveredAt: at(0),
    });
  }),

  /*
   * CL-05's three writes. They used to answer with a plausible `MaintenanceWindow` that was never
   * stored, so the invalidation the console performs straight afterwards re-read the unchanged
   * list and the new window simply vanished. They now write to the same array the list serves, and
   * refuse what the API refuses: an empty scope, an unparseable or reversed window, an instance
   * reference that resolves to nothing.
   */
  http.post('/api/v1/admin/maintenance-windows', async ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'maintenance.configure');
    if (guard) return guard;
    const body = await readBody<{
      scope?: string;
      instanceId?: string | null;
      startsAt?: string;
      endsAt?: string;
    }>(request);
    const scope = (body.scope ?? '').trim();
    if (scope.length === 0) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'A maintenance window needs a scope',
        'The record has no description of the work.',
        'Name the change the window covers.',
        [{ field: 'scope', code: 'minLength', message: 'At least one character.' }],
      );
    }
    const startsAt = body.startsAt ?? at(60);
    const endsAt = body.endsAt ?? at(120);
    const start = Date.parse(startsAt);
    const end = Date.parse(endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'Both ends must be instants',
        'A timestamp could not be read.',
        'Send an ISO-8601 UTC timestamp.',
      );
    }
    if (end <= start) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'A window must end after it starts',
        'The end is not after the start.',
        'Correct the end time.',
      );
    }
    const state = getState();
    const reference = body.instanceId?.trim() ?? '';
    const instance =
      reference === ''
        ? undefined
        : state.instances.find(
            (item) =>
              item.id === reference || item.slug === reference || item.entryKey === reference,
          );
    if (reference !== '' && instance === undefined) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'No deployed instance matches the reference',
        `"${reference}" is not an instance id, slug or entry key.`,
        'Choose an instance from the list, or leave it empty for a platform-wide window.',
        [{ field: 'instanceId', code: 'unknown', message: 'Instance does not exist.' }],
      );
    }
    const now = Date.parse(at(0));
    const window: MaintenanceWindow = {
      id: `mw-${460 + state.maintenance.length}`,
      scope,
      scopeLabel: instance === undefined ? scope : `${instance.product} — ${instance.slug}`,
      instanceId: instance?.id ?? null,
      title: instance === undefined ? scope : `${instance.product} maintenance`,
      startsAt,
      endsAt,
      createdBy: actorFor(role).name,
      state: now < start ? 'scheduled' : now < end ? 'active' : 'completed',
      suppressAlerts: now < end,
    };
    state.maintenance.unshift(window);
    appendAudit({
      action: 'maintenance.window.created',
      targetType: 'maintenance_window',
      targetId: window.id,
      targetLabel: window.title,
      outcome: 'success',
      detail: `${window.id} (${scope}) suppresses alerts from ${startsAt} to ${endsAt}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(window);
  }),

  http.patch('/api/v1/admin/maintenance-windows/:id', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'maintenance.configure');
    if (guard) return guard;
    const body = await readBody<{ startsAt?: string; endsAt?: string }>(request);
    const window = getState().maintenance.find((item) => item.id === String(params.id));
    if (window === undefined) {
      return problem(
        404,
        'NOT_FOUND',
        'The resource does not exist',
        `No live maintenance window ${params.id}.`,
        'Refresh the list.',
      );
    }
    if (window.state === 'completed') {
      return problem(
        409,
        'STATE_CONFLICT',
        'A finished window cannot be edited',
        `${window.id} is ${window.state}.`,
        'Schedule a new window instead.',
      );
    }
    const startsAt = body.startsAt ?? window.startsAt;
    const endsAt = body.endsAt ?? window.endsAt;
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'A window must end after it starts',
        'The end is not after the start.',
        'Correct the end time.',
      );
    }
    window.startsAt = startsAt;
    window.endsAt = endsAt;
    appendAudit({
      action: 'maintenance.window.updated',
      targetType: 'maintenance_window',
      targetId: window.id,
      targetLabel: window.title,
      outcome: 'success',
      detail: `${window.id} now runs from ${startsAt} to ${endsAt}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(window);
  }),

  http.delete('/api/v1/admin/maintenance-windows/:id', ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'maintenance.configure');
    if (guard) return guard;
    const window = getState().maintenance.find((item) => item.id === String(params.id));
    if (window === undefined || window.state === 'completed') {
      return problem(
        404,
        'NOT_FOUND',
        'The resource does not exist',
        `No live maintenance window ${params.id}.`,
        'Refresh the list.',
      );
    }
    /* Cancelled, not deleted: the state is how the record explains a suppressed alert. */
    window.state = 'completed';
    window.suppressAlerts = false;
    appendAudit({
      action: 'maintenance.window.cancelled',
      targetType: 'maintenance_window',
      targetId: window.id,
      targetLabel: window.title,
      outcome: 'success',
      detail: `${window.id} cancelled; alert delivery resumes.`,
      actor: actorFor(role),
    });
    return new HttpResponse(null, { status: 204 });
  }),

  // ---- 4C / 4D reads -------------------------------------------------------------------------
  http.get('/api/v1/platform/restore-status', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'recovery.view');
    if (guard) return guard;
    const status: PlatformRestoreStatus = {
      run: null,
      gate: {
        routesPublished: true,
        loginVerifiedAt: null,
        detail: 'No restore is running; product routes are published.',
      },
      generatedAt: at(0),
    };
    return HttpResponse.json(status);
  }),

  http.get('/api/v1/registry/operations', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'registry.view');
    if (guard) return guard;
    const target = new URL(request.url).searchParams.get('target') ?? '';
    const entry = getState().registry.find(
      (item) => item.instanceId === target || item.slug === target || item.entryKey === target,
    );
    const response: OperationsResponse = {
      target,
      operations: entry?.operations ?? [],
      eventModes: entry?.eventModes ?? [],
    };
    return HttpResponse.json(response);
  }),
];

function workflowResponse(id: string) {
  const workflow = getState().workflows.find((item) => item.id === id);
  if (!workflow) {
    return problem(
      404,
      'NOT_FOUND',
      'Workflow not found',
      `No workflow matches ${id}.`,
      'Refresh the workflow list.',
    );
  }
  return HttpResponse.json(workflow as Workflow);
}
