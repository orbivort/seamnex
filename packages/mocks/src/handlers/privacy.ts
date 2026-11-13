import { http, HttpResponse } from 'msw';
import type { PrivacyRequest, PrivacyScope } from '@seamnex/domain';
import { at } from '../fixtures/context';
import { appendAudit, getState } from '../store';
import { actorFor, problem, readBody, requireCapability, roleOf } from './utils';

/** Platform-tier scopes are mandatory: a subject's data is not only inside products. */
const PLATFORM_SCOPES: PrivacyScope[] = [
  {
    scopeType: 'platform',
    scopeId: 'idp_user',
    label: 'Identity-provider record',
    state: 'pending',
    detail: 'Profile, groups and MFA enrolment.',
  },
  {
    scopeType: 'platform',
    scopeId: 'entitlements',
    label: 'Entitlements and role bindings',
    state: 'pending',
    detail: 'Effective grants with their scope labels.',
  },
  {
    scopeType: 'platform',
    scopeId: 'audit_event',
    label: 'Audit events (subject_ref)',
    state: 'pending',
    detail: 'Matched by the pseudonymous reference; the chain is never rewritten.',
  },
  {
    scopeType: 'platform',
    scopeId: 'job_log',
    label: 'Job logs',
    state: 'pending',
    detail: 'Lines attributed to the subject, secrets masked.',
  },
  {
    scopeType: 'platform',
    scopeId: 'notification',
    label: 'Notifications and backup sets',
    state: 'pending',
    detail: 'Delivery records plus the backup catalogue entries that contain them.',
  },
];

export const privacyHandlers = [
  http.get('/api/v1/privacy/requests', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'privacy.view');
    if (guard) return guard;
    const requests = [...getState().privacy].sort(
      (left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt),
    );
    return HttpResponse.json({ generatedAt: at(0), requests });
  }),

  http.post('/api/v1/privacy/requests', async ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'privacy.manage');
    if (guard) return guard;
    const body = await readBody<{ subjectRef?: string; kind?: 'export' | 'delete' }>(request);
    const subjectRef = (body.subjectRef ?? '').trim();
    if (!/^sub_[0-9a-z]{4}$/i.test(subjectRef)) {
      return problem(
        422,
        'SUBJECT_REF_INVALID',
        'A pseudonymous subject reference is required',
        'Requests are addressed by the HMAC subject reference, never by a person’s name.',
        'Use the reference from the identity-provider export, for example sub_44c1.',
        [
          {
            field: 'subjectRef',
            code: 'pattern',
            message: 'Expected a reference such as sub_44c1.',
          },
        ],
      );
    }
    if (body.kind !== 'export' && body.kind !== 'delete') {
      return problem(
        422,
        'KIND_INVALID',
        'Choose export or delete',
        'A data-subject request is either an export or an erasure.',
        'Select the request kind.',
        [{ field: 'kind', code: 'required', message: 'Use export or delete.' }],
      );
    }
    const state = getState();
    const created: PrivacyRequest = {
      id: `pr-${4110 + state.privacy.length}`,
      subjectRef,
      kind: body.kind,
      state: 'open',
      openedBy: actorFor(role).name,
      openedAt: at(0),
      dueAt: at(30 * 24 * 60),
      closedAt: null,
      scopes: PLATFORM_SCOPES.map((scope) => ({ ...scope })),
      evidence: [`Request accepted with a recorded legal basis (${body.kind})`],
    };
    state.privacy = [created, ...state.privacy];
    appendAudit({
      action: 'privacy.request.opened',
      targetType: 'platform',
      targetId: created.id,
      targetLabel: `Data-subject ${body.kind} · ${subjectRef}`,
      outcome: 'success',
      detail: `Privacy request ${created.id} opened with ${created.scopes.length} platform scopes; product scopes are added per entitlement.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(created, { status: 201 });
  }),

  http.post('/api/v1/privacy/requests/:id/advance', ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'privacy.manage');
    if (guard) return guard;
    const item = getState().privacy.find((entry) => entry.id === String(params.id));
    if (!item) {
      return problem(
        404,
        'PRIVACY_REQUEST_NOT_FOUND',
        'Privacy request not found',
        'The request no longer exists.',
        'Refresh the queue.',
      );
    }
    if (item.state === 'complete') {
      return problem(
        409,
        'INVALID_STATE',
        'This request is already complete',
        `Request ${item.id} is complete.`,
        'Open another request.',
      );
    }
    const scope = item.scopes.find((entry) => entry.state !== 'complete');
    if (!scope) {
      item.state = 'complete';
      item.closedAt = at(0);
      item.evidence = [
        ...item.evidence,
        'All platform and product scopes complete; outcome recorded',
      ];
    } else {
      scope.state = 'complete';
      item.state = 'running';
      item.evidence = [...item.evidence, `${scope.label} complete`];
    }
    appendAudit({
      action: item.state === 'complete' ? 'privacy.request.completed' : 'privacy.request.advanced',
      targetType: 'platform',
      targetId: item.id,
      targetLabel: `Data-subject ${item.kind} · ${item.subjectRef}`,
      outcome: 'success',
      detail: scope
        ? `Scope "${scope.label}" completed; ${item.scopes.filter((entry) => entry.state === 'complete').length} of ${item.scopes.length} scopes done.`
        : `Request ${item.id} completed; the subject reference mapping is the erasure while the audit chain keeps only the opaque reference.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(item);
  }),
];
