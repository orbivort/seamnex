import { http, HttpResponse } from 'msw';
import type { AccessRequest, AlertChannel } from '@seamnex/domain';
import { at } from '../fixtures/context';
import { appendAudit, getState, meFor, refreshCapacity } from '../store';
import { actorFor, deny, etagFor, problem, readBody, requireCapability, roleOf } from './utils';

export const adminHandlers = [
  http.get('/api/v1/admin/users', ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R2'], 'identity.manage_users');
    if (guard) return guard;
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    const users = getState().users.filter(
      (user) =>
        q === '' ||
        user.displayName.toLowerCase().includes(q) ||
        user.email.toLowerCase().includes(q),
    );
    return HttpResponse.json(users);
  }),

  http.get('/api/v1/admin/users/:id', ({ params, request }) => {
    const guard = deny(roleOf(request), ['R1', 'R2'], 'identity.manage_users');
    if (guard) return guard;
    const user = getState().users.find((item) => item.id === String(params.id));
    if (!user) {
      return problem(
        404,
        'USER_NOT_FOUND',
        'User not found',
        'The identity-provider user no longer exists.',
        'Refresh the user list.',
      );
    }
    return HttpResponse.json(user);
  }),

  http.get('/api/v1/admin/users/:id/entitlements', ({ params, request }) => {
    const guard = deny(roleOf(request), ['R1', 'R2'], 'identity.manage_users');
    if (guard) return guard;
    const user = getState().users.find((item) => item.id === String(params.id));
    if (!user) {
      return problem(
        404,
        'USER_NOT_FOUND',
        'User not found',
        'The identity-provider user no longer exists.',
        'Refresh the user list.',
      );
    }
    const entitlements = getState()
      .instances.slice(0, user.entitlementCount)
      .map((instance) => ({
        instanceId: instance.id,
        product: instance.product,
        entryKey: instance.entryKey,
        productRole: 'User',
        syncState: 'applied',
      }));
    return HttpResponse.json({ userId: user.id, entitlements });
  }),

  http.post('/api/v1/admin/users/:id/disable', ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'identity.manage_users');
    if (guard) return guard;
    const user = getState().users.find((item) => item.id === String(params.id));
    if (!user) {
      return problem(
        404,
        'USER_NOT_FOUND',
        'User not found',
        'The identity-provider user no longer exists.',
        'Refresh the user list.',
      );
    }
    user.enabled = false;
    const entitlements = getState()
      .instances.slice(0, user.entitlementCount)
      .map((instance) => ({
        instanceId: instance.id,
        product: instance.product,
        syncState: 'pending',
      }));
    appendAudit({
      action: 'user.disabled',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.displayName,
      outcome: 'success',
      detail: `Disabled in the identity provider; ${entitlements.length} product entitlement(s) enumerated and revoked within one sync cycle.`,
      actor: actorFor(role),
    });
    return HttpResponse.json({
      userId: user.id,
      disabledAt: at(0),
      sessionsTerminated: 3,
      entitlements,
      propagationNote: 'Product access revokes within one sync cycle (5 minutes p95).',
    });
  }),

  http.get('/api/v1/admin/groups', ({ request }) => {
    const guard = deny(roleOf(request), ['R1', 'R2', 'R3'], 'identity.manage_groups');
    if (guard) return guard;
    return HttpResponse.json(getState().groups);
  }),

  http.put('/api/v1/admin/groups/:id/mapping', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'identity.manage_groups');
    if (guard) return guard;
    const group = getState().groups.find((item) => item.id === String(params.id));
    if (!group) {
      return problem(
        404,
        'GROUP_NOT_FOUND',
        'Group not found',
        'The directory group no longer exists.',
        'Refresh the group list.',
      );
    }
    const body = await readBody<{
      role?: string;
      scopeType?: string;
      scopeLabel?: string;
      propagate?: boolean;
    }>(request);
    group.mapping = {
      role: (body.role as 'R1') ?? group.mapping?.role ?? 'R5',
      scopeType: (body.scopeType as 'platform') ?? group.mapping?.scopeType ?? 'platform',
      scopeId: group.mapping?.scopeId ?? null,
      scopeLabel: body.scopeLabel ?? group.mapping?.scopeLabel ?? 'Platform',
      propagateToProduct: body.propagate ?? group.mapping?.propagateToProduct ?? false,
    };
    group.updatedAt = at(0);
    appendAudit({
      action: 'group.mapping.updated',
      targetType: 'group',
      targetId: group.id,
      targetLabel: group.path,
      outcome: 'success',
      detail: `Mapped to ${group.mapping?.role ?? 'unmapped'} at ${group.mapping?.scopeLabel ?? 'no scope'}; propagation ${
        group.mapping?.propagateToProduct ? 'requested immediately' : 'follows the next sync cycle'
      }. Mapping changes are never written by the sync loop.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(group);
  }),

  http.get('/api/v1/admin/identity-sync', ({ request }) => {
    const guard = deny(roleOf(request), ['R1', 'R2'], 'identity.manage_users');
    if (guard) return guard;
    return HttpResponse.json(getState().syncRuns);
  }),

  http.post('/api/v1/admin/identity-sync/run', ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'identity sync');
    if (guard) return guard;
    const run = {
      id: `sync-${7742 + getState().syncRuns.length}`,
      startedAt: at(0),
      finishedAt: at(0.4),
      users: getState().users.length,
      groups: getState().groups.length,
      changes: 1,
      p95LatencyMs: 82_000,
      errors: [],
      state: 'succeeded' as const,
    };
    getState().syncRuns = [run, ...getState().syncRuns];
    appendAudit({
      action: 'identity.sync.run',
      targetType: 'platform',
      targetId: run.id,
      targetLabel: 'Identity sync',
      outcome: 'success',
      detail: `${run.users} users and ${run.groups} groups reconciled; p95 ${Math.round(run.p95LatencyMs / 1000)} s.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(run, { status: 201 });
  }),

  http.get('/api/v1/admin/settings', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'settings.view');
    if (guard) return guard;
    const settings = getState().settings;
    return HttpResponse.json(settings, { headers: { ETag: etagFor(settings) } });
  }),

  http.put('/api/v1/admin/settings', async ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'settings.manage');
    if (guard) return guard;

    // Optimistic concurrency (design §8): a stale editor must not overwrite a newer value.
    const current = etagFor(getState().settings);
    if (request.headers.get('If-Match') !== current) {
      return problem(
        412,
        'PRECONDITION_FAILED',
        'Platform settings changed since this form was loaded',
        `The stored representation is ${current}; reload the settings before saving.`,
        'Reload the page, re-apply your change and save again.',
      );
    }

    const body = await readBody<Record<string, number>>(request);
    const settings = getState().settings;
    if (typeof body.breakGlassMaxMinutes === 'number') {
      if (body.breakGlassMaxMinutes < 5 || body.breakGlassMaxMinutes > 240) {
        return problem(
          422,
          'OUT_OF_RANGE',
          'Break-glass duration is out of range',
          'Allowed range is 5–240 minutes.',
          'Choose a value inside the range.',
          [{ field: 'breakGlassMaxMinutes', code: 'range', message: '5–240 minutes.' }],
        );
      }
      settings.breakGlassMaxMinutes = body.breakGlassMaxMinutes;
    }
    if (typeof body.restoreConcurrency === 'number') {
      settings.restoreConcurrency = Math.min(12, Math.max(4, body.restoreConcurrency));
    }
    settings.updatedAt = at(0);
    settings.updatedBy = 'Sofia Almeida';
    refreshCapacity(getState());
    appendAudit({
      action: 'settings.updated',
      targetType: 'platform',
      targetId: 'settings',
      targetLabel: 'Platform settings',
      outcome: 'success',
      detail: `Break-glass maximum ${settings.breakGlassMaxMinutes} min, restore concurrency ${settings.restoreConcurrency}, oversubscription ${settings.oversubscriptionFactor}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(settings);
  }),

  http.get('/api/v1/admin/settings/alerts', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'settings.view');
    if (guard) return guard;
    return HttpResponse.json(getState().alerts);
  }),

  http.put('/api/v1/admin/settings/alerts', async ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'alert.configure');
    if (guard) return guard;
    const body = await readBody<AlertChannel[]>(request);
    getState().alerts = body;
    appendAudit({
      action: 'alert.channel.updated',
      targetType: 'platform',
      targetId: 'alerts',
      targetLabel: 'Alert channels',
      outcome: 'success',
      detail: `${body.filter((channel) => channel.enabled).length} of ${body.length} channel(s) enabled.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(getState().alerts);
  }),

  /**
   * The queue is readable by whoever may *decide* an entitlement (`POLICY_KEYS` names the same
   * capability for the route). The old role-literal list omitted R4, whose scoped grant puts the
   * page in its sidebar — so the console offered a link to a 403 and the deployment it predicts
   * disagreed with `packages/domain/src/policy.ts`.
   */
  http.get('/api/v1/admin/access-requests', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'entitlement.grant');
    if (guard) return guard;
    return HttpResponse.json(getState().accessRequests);
  }),

  /** FR-3.13: an end user opens a request; it lands in the same queue a second party decides. */
  http.post('/api/v1/admin/access-requests', async ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'access.request');
    if (guard) return guard;
    const body = await readBody<{ entryKey?: string; justification?: string }>(request);
    const entryKey = (body.entryKey ?? '').trim();
    const justification = (body.justification ?? '').trim();
    const state = getState();
    const entry = state.catalog.find((item) => item.key === entryKey);
    if (!entry) {
      return problem(
        422,
        'ENTRY_UNKNOWN',
        'Unknown catalog entry',
        `No entry has key "${entryKey}".`,
        'Choose a product from the requestable list.',
        [{ field: 'entryKey', code: 'unknown', message: 'Pick a requestable product.' }],
      );
    }
    if (justification.length < 10) {
      return problem(
        422,
        'JUSTIFICATION_REQUIRED',
        'A justification is required',
        'The domain owner needs a reason to decide.',
        'Describe the task and the record you need to reach, in at least 10 characters.',
        [{ field: 'justification', code: 'required', message: 'At least 10 characters.' }],
      );
    }
    const me = meFor(role);
    const existing = state.accessRequests.find(
      (item) =>
        item.requester.id === me.id &&
        item.state === 'open' &&
        item.target.startsWith(`${entry.key} `),
    );
    if (existing) {
      return problem(
        409,
        'REQUEST_ALREADY_OPEN',
        'A request is already open',
        `${existing.id} is awaiting a decision.`,
        'Wait for the decision or ask the domain owner.',
      );
    }
    const created: AccessRequest = {
      id: `ar-${3205 + state.accessRequests.length}`,
      requester: { id: me.id, name: me.displayName },
      kind: 'entitlement',
      target: `${entry.key} ${entry.product} — product access`,
      justification,
      state: 'open',
      createdAt: at(0),
      decidedBy: null,
      decidedAt: null,
      domain: entry.domain,
    };
    state.accessRequests = [created, ...state.accessRequests];
    appendAudit({
      action: 'access.request.created',
      targetType: 'access_request',
      targetId: created.id,
      targetLabel: created.target,
      outcome: 'success',
      detail: `Entitlement requested by ${me.displayName}; routed to the domain owner of ${entry.domain}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(created, { status: 201 });
  }),

  http.post('/api/v1/admin/access-requests/:id/:decision', ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'entitlement.grant');
    if (guard) return guard;
    const item = getState().accessRequests.find(
      (requestItem) => requestItem.id === String(params.id),
    );
    if (!item) {
      return problem(
        404,
        'REQUEST_NOT_FOUND',
        'Access request not found',
        'The request no longer exists.',
        'Refresh the list.',
      );
    }
    const decision = String(params.decision);
    if (decision !== 'approve' && decision !== 'reject') {
      return problem(
        404,
        'UNKNOWN_ACTION',
        'Unknown decision',
        `"${decision}" is not a decision.`,
        'Use approve or reject.',
      );
    }
    // The page states this rule and the API enforces it: a second party decides, never the
    // requester. A prototype that let the requester approve would teach the wrong workflow.
    if (item.requester.id === meFor(role).id) {
      return problem(
        409,
        'SELF_DECISION',
        'A request cannot be decided by its requester',
        `${item.id} was raised by ${item.requester.name}.`,
        'Ask another approver; the requester never decides their own request.',
      );
    }
    item.state = decision === 'approve' ? 'approved' : 'rejected';
    item.decidedBy = actorFor(role).name;
    item.decidedAt = at(0);
    appendAudit({
      action: decision === 'approve' ? 'access.request.approved' : 'access.request.rejected',
      targetType: 'access_request',
      targetId: item.id,
      targetLabel: `${item.kind} · ${item.target}`,
      outcome: 'success',
      detail: `Request ${item.id} ${item.state} by ${item.decidedBy}; justification retained.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(item);
  }),

  /*
   * The guards are the contract's own keys (`POLICY_KEYS` in @seamnex/domain), not a second opinion.
   * The window list was readable with `metadata.manage` here and refused to the same role by the
   * API, so the prototype showed a page that a deployment answers with 403; the exception queue
   * was readable with `settings.view`, which the API does not accept either. That divergence is
   * why the console could not be trusted to predict what a deployment would allow.
   */
  http.get('/api/v1/admin/maintenance-windows', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'settings.view');
    if (guard) return guard;
    return HttpResponse.json(getState().maintenance);
  }),

  http.get('/api/v1/admin/policy-exceptions', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'exception.decide');
    if (guard) return guard;
    return HttpResponse.json(getState().policyExceptions);
  }),

  /** NFR-4.15: an exception is approved by a second party, never by the requester. */
  http.post('/api/v1/admin/policy-exceptions/:id/:decision', ({ params, request }) => {
    const role = roleOf(request);
    // One source of truth: the same capability the route and the button use.
    const guard = requireCapability(role, 'exception.decide');
    if (guard) return guard;
    const exception = getState().policyExceptions.find((item) => item.id === String(params.id));
    if (!exception) {
      return problem(
        404,
        'POLICY_EXCEPTION_NOT_FOUND',
        'Policy exception not found',
        'The exception no longer exists.',
        'Refresh the list.',
      );
    }
    const decision = String(params.decision);
    if (decision !== 'approve' && decision !== 'reject') {
      return problem(
        404,
        'UNKNOWN_ACTION',
        'Unknown decision',
        `"${decision}" is not a decision.`,
        'Use approve or reject.',
      );
    }
    if (exception.state !== 'requested') {
      return problem(
        409,
        'INVALID_STATE',
        'This exception is no longer awaiting approval',
        `Exception ${exception.id} is ${exception.state}.`,
        'Refresh the list.',
      );
    }
    exception.state = decision === 'approve' ? 'approved' : 'rejected';
    exception.approver = actorFor(role).name;
    appendAudit({
      action: decision === 'approve' ? 'policy.exception.approved' : 'policy.exception.rejected',
      targetType: 'policy_exception',
      targetId: exception.id,
      targetLabel: `${exception.rule} · ${exception.scope}`,
      outcome: 'success',
      detail: `${exception.id} ${exception.state} by ${exception.approver}; expires ${exception.expiresAt}; patch diff recorded.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(exception);
  }),

  http.get('/api/v1/admin/dsar', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'privacy.view');
    if (guard) return guard;
    return HttpResponse.json(getState().dsar);
  }),
];
