import { http, HttpResponse } from 'msw';
import { breakGlassStateAt } from '@seamnex/domain';
import type { BreakGlassSession } from '@seamnex/domain';
import { at } from '../fixtures/context';
import { appendAudit, auditProofFor, getState } from '../store';
import {
  actorFor,
  deny,
  paginate,
  problem,
  readBody,
  requireAnyCapability,
  requireCapability,
  roleOf,
} from './utils';

/** The written reason an approver decides on; the console states the same number in its hint. */
const MIN_JUSTIFICATION = 20;

export const governanceHandlers = [
  http.get('/api/v1/audit-events', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'audit.view');
    if (guard) return guard;
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const actor = (url.searchParams.get('actor') ?? '').toLowerCase();
    const outcome = url.searchParams.get('outcome');
    const target = url.searchParams.get('target');
    const items = getState().audit.filter((event) => {
      const matchesAction = !action || event.action.startsWith(action);
      const matchesActor =
        actor === '' ||
        event.actorName.toLowerCase().includes(actor) ||
        event.actorId.includes(actor);
      const matchesOutcome = !outcome || event.outcome === outcome;
      const matchesTarget =
        !target ||
        event.targetId === target ||
        event.targetLabel.toLowerCase().includes(target.toLowerCase());
      return matchesAction && matchesActor && matchesOutcome && matchesTarget;
    });
    // Newest first: seq increases with time, so the audit page reads top-down.
    items.sort((left, right) => right.seq - left.seq);
    return HttpResponse.json(paginate(items, request));
  }),

  http.get('/api/v1/audit-events/:seq/proof', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'audit.view');
    if (guard) return guard;
    const seq = Number.parseInt(String(params.seq), 10);
    const event = getState().audit.find((item) => item.seq === seq);
    if (!event) {
      return problem(
        404,
        'AUDIT_EVENT_NOT_FOUND',
        'Audit event not found',
        `No event with sequence ${seq}.`,
        'Search the audit trail again.',
      );
    }
    return HttpResponse.json(auditProofFor(seq));
  }),

  http.post('/api/v1/audit-events/export', async ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R2'], 'audit.export');
    if (guard) return guard;
    const body = await readBody<{ from?: string; to?: string }>(request).catch(
      () => ({}) as { from?: string; to?: string },
    );
    const from = body.from ?? null;
    const to = body.to ?? null;
    // The exported rows travel with their count and digest: a file that reports a range it does
    // not contain cannot be verified by the reader.
    const events = getState()
      .audit.filter(
        (event) => (from === null || event.ts >= from) && (to === null || event.ts <= to),
      )
      .sort((left, right) => left.seq - right.seq);
    appendAudit({
      action: 'audit.export',
      targetType: 'platform',
      targetId: 'audit',
      targetLabel: 'Audit log',
      outcome: 'success',
      detail: `Exported ${events.length} events with hash-chain proof.`,
      actor: actorFor(role),
    });
    return HttpResponse.json({
      exportedAt: at(0),
      count: events.length,
      events,
      from,
      to,
      sha256: 'sha256:0a91c4b7d82e3f65c0b71d4a92e36f80c5a1d7e4b92f038c6d51e8a04b7c3e12',
      chainValid: true,
      downloadName: 'seamnex-audit-2026-10-22.json',
    });
  }),

  http.get('/api/v1/licenses', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'license.view');
    if (guard) return guard;
    return HttpResponse.json(getState().licenses);
  }),

  /**
   * FR-1.14 / AC-44: the register is a release gate. Reading it is `license.view` (R1 and R2);
   * changing the configuration it certifies is `license.manage` (R1 only), and a restricted or
   * unreviewed licence refuses the change with a reason that names the licence.
   */
  http.put('/api/v1/licenses/:instanceId/hosted-service', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'license.manage');
    if (guard) return guard;
    const body = await readBody<{ enabled?: boolean }>(request);
    const record = getState().licenses.find(
      (item) => item.instanceId === String(params.instanceId),
    );
    if (!record) {
      return problem(
        404,
        'LICENSE_NOT_FOUND',
        'Licence record not found',
        `No licence is recorded for ${String(params.instanceId)}.`,
        'Refresh the register.',
      );
    }
    const enabled = Boolean(body.enabled);
    const restricted = record.resaleRestricted || record.hostedServiceRestricted;
    const gateReason = !record.reviewedAt
      ? `The ${record.licenseId} licence recorded for ${record.product} has not been reviewed, so hosted-service mode stays off.`
      : restricted
        ? `${record.product} is licensed under ${record.licenseId}, which does not permit resale or offering it as a hosted service.`
        : null;

    if (enabled && gateReason !== null) {
      appendAudit({
        action: 'license.hosted_service.denied',
        targetType: 'instance',
        targetId: record.instanceId,
        targetLabel: `${record.entryKey} ${record.product}`,
        outcome: 'denied',
        detail: `${record.licenseId} blocks hosted-service provision; the request was refused before any configuration changed.`,
        actor: actorFor(role),
      });
      return problem(
        403,
        'LICENCE_RESTRICTED',
        'The licence does not allow this configuration',
        gateReason,
        'Keep the instance for internal use, or complete the licence review and obtain a commercial licence before enabling hosted-service mode.',
      );
    }
    record.hostedService = enabled;
    appendAudit({
      action: 'license.hosted_service.updated',
      targetType: 'instance',
      targetId: record.instanceId,
      targetLabel: `${record.entryKey} ${record.product}`,
      outcome: 'success',
      detail: `Hosted-service provision ${enabled ? 'enabled' : 'disabled'} for ${record.licenseId}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json({
      instanceId: record.instanceId,
      hostedService: record.hostedService,
      restricted,
      reason: gateReason,
      evaluatedAt: at(0),
    });
  }),

  http.get('/api/v1/patch-register', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'patch.view');
    if (guard) return guard;
    return HttpResponse.json(getState().patches);
  }),

  http.get('/api/v1/posture', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'posture.view');
    if (guard) return guard;
    return HttpResponse.json(getState().posture);
  }),

  http.get('/api/v1/break-glass-sessions', ({ request }) => {
    // Same any-of rule as the live route: the requester and both approvers may read the register,
    // and none of them shares a single capability with the others.
    const guard = requireAnyCapability(roleOf(request), [
      'breakglass.request',
      'breakglass.approve',
      'breakglass.revoke',
    ]);
    if (guard) return guard;
    // A time box that has elapsed is over whether or not a sweep has run.
    return HttpResponse.json(
      getState().breakGlass.map((session) => ({
        ...session,
        state: breakGlassStateAt(session.state, session.expiresAt),
      })),
    );
  }),

  http.post('/api/v1/break-glass-sessions', async ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'breakglass.request');
    if (guard) return guard;
    const body = await readBody<{
      instanceId: string;
      accessMode: 'read_only' | 'read_write';
      justification: string;
    }>(request);
    const instance = getState().instances.find((item) => item.id === body.instanceId);
    if (!instance) {
      return problem(
        422,
        'INSTANCE_NOT_FOUND',
        'Unknown instance',
        'Choose a deployed instance for the elevation.',
        'Select an instance from the list.',
        [{ field: 'instanceId', code: 'unknown', message: 'Instance does not exist.' }],
      );
    }
    // The justification is what an approver decides on, for either mode, so the floor applies to
    // read-only elevation too — the live API enforces the same rule.
    if (body.justification.trim().length < MIN_JUSTIFICATION) {
      return problem(
        422,
        'JUSTIFICATION_REQUIRED',
        'A written justification is required',
        'Elevation needs a substantive written reason the approver can decide on.',
        'Describe the change, the reason and the rollback.',
        [
          {
            field: 'justification',
            code: 'minLength',
            message: `At least ${MIN_JUSTIFICATION} characters.`,
          },
        ],
      );
    }
    const session: BreakGlassSession = {
      id: `bg-${2300 + getState().breakGlass.length}`,
      requester: { id: 'usr-sofia', name: 'Sofia Almeida' },
      instanceId: instance.id,
      product: `${instance.entryKey} ${instance.product}`,
      domainOwner: instance.domainOwner.name,
      accessMode: body.accessMode,
      justification: body.justification,
      approver: null,
      selfApproved: false,
      state: 'requested',
      requestedAt: at(0),
      grantedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAccounts: 0,
      retentionReason: null,
    };
    getState().breakGlass = [session, ...getState().breakGlass];
    appendAudit({
      action: 'breakglass.requested',
      targetType: 'instance',
      targetId: instance.id,
      targetLabel: `${instance.entryKey} ${instance.product}`,
      outcome: 'success',
      detail: `${session.id} requested in ${body.accessMode} mode; awaiting second-party approval from ${session.domainOwner}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(session, { status: 201 });
  }),

  http.post('/api/v1/break-glass-sessions/:id/:action', ({ params, request }) => {
    const role = roleOf(request);
    const action = String(params.action);
    const session = getState().breakGlass.find((item) => item.id === String(params.id));
    if (!session) {
      return problem(
        404,
        'BREAK_GLASS_NOT_FOUND',
        'Session not found',
        'The elevation request no longer exists.',
        'Refresh the list.',
      );
    }
    if (action === 'approve') {
      const guard = deny(role, ['R2', 'R3'], 'breakglass.approve');
      if (guard) return guard;
      /*
       * Only a pending request can be approved. Without this, a second approval of a live grant
       * rewrote `granted_at`/`expires_at` and silently extended the time box — the one thing the
       * feature promises never to allow.
       */
      if (session.state !== 'requested') {
        return problem(
          409,
          'INVALID_STATE',
          'Only a pending request can be approved',
          `Session is ${breakGlassStateAt(session.state, session.expiresAt)}.`,
          'Refresh the list.',
        );
      }
      if (session.accessMode === 'read_write' && role === 'R2') {
        return problem(
          403,
          'APPROVAL_MODE_FORBIDDEN',
          'Auditors may approve read-only sessions only',
          'Read-write elevation requires the domain owner of the affected domain.',
          'Ask the domain owner to approve this request.',
        );
      }
      session.state = 'active';
      session.approver = role === 'R2' ? 'Ruth Adler' : session.domainOwner;
      session.grantedAt = at(0);
      session.expiresAt = at(getState().settings.breakGlassMaxMinutes);
      appendAudit({
        action: 'breakglass.approved',
        targetType: 'instance',
        targetId: session.instanceId,
        targetLabel: session.product,
        outcome: 'success',
        detail: `${session.id} approved by ${session.approver} in ${session.accessMode} mode for ${getState().settings.breakGlassMaxMinutes} minutes; mode cannot be escalated.`,
        actor: actorFor(role),
      });
      return HttpResponse.json(session);
    }
    if (action === 'reject') {
      const guard = deny(role, ['R2', 'R3'], 'breakglass.approve');
      if (guard) return guard;
      // Rejecting a live or decided request would rewrite history; only a pending one is decidable.
      if (session.state !== 'requested') {
        return problem(
          409,
          'INVALID_STATE',
          'Only a pending request can be rejected',
          `Session is ${breakGlassStateAt(session.state, session.expiresAt)}.`,
          'Refresh the list.',
        );
      }
      session.state = 'rejected';
      session.approver = role === 'R2' ? 'Ruth Adler' : session.domainOwner;
      session.revokedAt = at(0);
      appendAudit({
        action: 'breakglass.rejected',
        targetType: 'instance',
        targetId: session.instanceId,
        targetLabel: session.product,
        outcome: 'success',
        detail: `${session.id} rejected by ${session.approver}; no elevation was granted.`,
        actor: actorFor(role),
      });
      return HttpResponse.json(session);
    }
    if (action === 'revoke') {
      const guard = requireCapability(role, 'breakglass.revoke');
      if (guard) return guard;
      // Derived state: a grant whose window closed is already over, and calling that a revoke
      // would put the wrong ending in the audit trail.
      if (breakGlassStateAt(session.state, session.expiresAt) !== 'active') {
        return problem(
          409,
          'INVALID_STATE',
          'Only an active session can be revoked',
          `Session is ${breakGlassStateAt(session.state, session.expiresAt)}.`,
          'Refresh the list.',
        );
      }
      session.state = 'revoked';
      session.revokedAt = at(0);
      appendAudit({
        action: 'breakglass.revoked',
        targetType: 'instance',
        targetId: session.instanceId,
        targetLabel: session.product,
        outcome: 'success',
        detail: `${session.id} revoked before expiry; in-product access removed and the route unpublished.`,
        actor: actorFor(role),
      });
      return HttpResponse.json(session);
    }
    return problem(
      404,
      'UNKNOWN_ACTION',
      'Unknown action',
      `"${action}" is not supported.`,
      'Use approve, reject or revoke.',
    );
  }),

  http.get('/api/v1/capacity', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'capacity.view');
    if (guard) return guard;
    return HttpResponse.json(getState().capacity);
  }),

  http.get('/api/v1/capacity/forecast', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'capacity.view');
    if (guard) return guard;
    return HttpResponse.json(getState().capacity.forecast);
  }),
];
