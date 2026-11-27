import { http, HttpResponse } from 'msw';
import {
  NATIVE_FLOOR_DEPLOYMENTS,
  breakGlassStateAt,
  isAcceptableFloorDecision,
  licenseGateVerdict,
  licenseTerms,
  mayApproveAccessMode,
  nativeFloorStatus,
  updateAvailable,
} from '@seamnex/domain';
import type { BreakGlassSession, LicenseReviewRequest } from '@seamnex/domain';
import { at } from '../fixtures/context';
import { releasesPageOf } from '../fixtures/governance';
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
  http.get('*/api/v1/audit-events', ({ request }) => {
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

  http.get('*/api/v1/audit-events/:seq/proof', ({ params, request }) => {
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

  http.post('*/api/v1/audit-events/export', async ({ request }) => {
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

  http.get('*/api/v1/licenses', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'license.view');
    if (guard) return guard;
    return HttpResponse.json(getState().licenses);
  }),

  /**
   * FR-1.14 / AC-44: the register is a release gate. Reading it is `license.view` (R1 and R2);
   * changing the configuration it certifies is `license.manage` (R1 only), and a restricted or
   * unreviewed licence refuses the change with a reason that names the licence.
   */
  http.put('*/api/v1/licenses/:instanceId/hosted-service', async ({ params, request }) => {
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
    const reviewed =
      record.reviewedBy !== null && record.reviewedAt !== null && record.upstreamRef !== null;
    // Same builder as the API (ADR-BE-25): unknown, then unreviewed, then restricted.
    const verdict = licenseGateVerdict({
      product: record.product,
      licenseId: record.licenseId,
      terms: licenseTerms(record.licenseId),
      recorded: true,
      reviewed,
      resaleRestricted: record.resaleRestricted,
      hostedServiceRestricted: record.hostedServiceRestricted,
    });

    if (enabled && verdict.reason !== null) {
      const licensingRefusal = verdict.code === 'LICENCE_RESTRICTED';
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
        licensingRefusal ? 403 : 409,
        verdict.code ?? 'LICENCE_UNREVIEWED',
        licensingRefusal
          ? 'The licence does not allow this configuration'
          : 'The licence has not been reviewed',
        verdict.reason,
        verdict.remediation ?? 'Complete the licence review before enabling hosted-service mode.',
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
      restricted: verdict.restricted,
      reason: verdict.reason,
      evaluatedAt: at(0),
    });
  }),

  /**
   * ADR-BE-25: the R2 review write. The mirror of `recordReview` — the same two explicit
   * confirmations, the same state conflict, and the reviewer taken from the role rather than the
   * body.
   */
  http.put('*/api/v1/licenses/:instanceId/review', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'license.review');
    if (guard) return guard;
    const body = await readBody<Partial<LicenseReviewRequest>>(request);
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

    const licenseId = (body.licenseId ?? '').trim();
    if (licenseId === '') {
      return problem(
        422,
        'VALIDATION_FAILED',
        'The review is incomplete',
        'A licence identifier is required.',
        'Check the upstream LICENSE file and enter its identifier.',
        [{ field: 'licenseId', code: 'minLength', message: 'At least one character.' }],
      );
    }
    const terms = licenseTerms(licenseId);
    if (terms === null && !body.acknowledgeUnknownLicence) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'The review is incomplete',
        `"${licenseId}" is not a licence the platform knows, so it cannot be reviewed without confirmation.`,
        'Correct the identifier, or acknowledge the unknown licence before recording it.',
        [
          {
            field: 'licenseId',
            code: 'unknown_licence',
            message: 'Confirm that you reviewed this licence against its LICENSE file or contract.',
          },
        ],
      );
    }

    const obligations = (Array.isArray(body.obligations) ? body.obligations : [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (obligations.length === 0 && !body.confirmNoObligations) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'The review is incomplete',
        'No obligations were supplied.',
        'Confirm explicitly that no obligations apply, or list them.',
        [
          {
            field: 'obligations',
            code: 'confirmation_required',
            message: 'Confirm explicitly when no obligations apply.',
          },
        ],
      );
    }

    const upstreamRef = (body.upstreamRef ?? '').trim();
    if (upstreamRef === '') {
      return problem(
        422,
        'VALIDATION_FAILED',
        'The review is incomplete',
        'The artefact the review was checked against is required.',
        'Record the upstream LICENSE URL or the commercial contract id.',
        [
          {
            field: 'upstreamRef',
            code: 'minLength',
            message: 'At least one character: a URL or a contract id.',
          },
        ],
      );
    }

    const resaleRestricted = Boolean(body.resaleRestricted);
    const hostedServiceRestricted = Boolean(body.hostedServiceRestricted);
    if ((resaleRestricted || hostedServiceRestricted) && record.hostedService) {
      return problem(
        409,
        'STATE_CONFLICT',
        'The instance is still offered as a hosted service',
        `${record.product} is currently offered as a hosted service; disable that configuration before recording a restriction.`,
        'Ask the platform administrator (R1) to turn hosted-service mode off, then record the review.',
      );
    }

    const note = (body.note ?? '').trim();
    record.licenseId = licenseId;
    record.obligations = obligations;
    record.resaleRestricted = resaleRestricted;
    record.hostedServiceRestricted = hostedServiceRestricted;
    record.reviewedBy = actorFor(role).id;
    record.reviewedByName = actorFor(role).name;
    record.reviewedAt = at(0);
    record.upstreamRef = upstreamRef;
    record.reviewNote = note === '' ? null : note;
    record.status = 'cleared';
    appendAudit({
      action: 'license.review.recorded',
      targetType: 'instance',
      targetId: record.instanceId,
      targetLabel: `${record.entryKey} ${record.product}`,
      outcome: 'success',
      detail: `Reviewed ${licenseId} with ${obligations.length} obligations.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(record);
  }),

  http.get('*/api/v1/patch-register', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'patch.view');
    if (guard) return guard;
    return HttpResponse.json(getState().patches);
  }),

  /**
   * FR-2.12 — the on-demand observation pass.
   *
   * The mock does what the real pass does to the register: it stamps the provenance, the observation
   * time and the release link. It deliberately does not invent a newer version: a feed that is not
   * reachable is the state the screen has to survive, not a version bump.
   */
  http.post('*/api/v1/patch-register/observe', ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'settings.manage');
    if (guard) return guard;

    const patches = getState().patches;
    let releases = 0;
    let advisories = 0;
    for (const patch of patches) {
      // The same rule as the API: `releases` counts versions an operator can move up to, and a
      // maintenance release published on the previous branch is not one of them.
      const behind = updateAvailable(patch.currentVersion, patch.latestVersion);
      patch.source = 'observed';
      patch.lastObservedAt = at(0);
      patch.checkedAt = at(0);
      if (behind) {
        releases += 1;
        // The same derivation the fixture uses: a link to the product's releases, never a URL with no
        // repository in it.
        patch.releaseUrl = releasesPageOf(patch.entryKey) ?? patch.releaseUrl;
        if (patch.advisory) advisories += 1;
        // An observed deployment that is behind has an unapplied update; the age is what the row
        // reports, and it survives the pass instead of being reset by it.
        patch.oldestUnappliedSecurityDays = patch.oldestUnappliedSecurityDays ?? 9;
      }
    }

    appendAudit({
      action: 'patch.register.observed',
      targetType: 'platform',
      targetId: 'patch-register',
      targetLabel: 'Patch register',
      outcome: 'success',
      detail: `Observed ${patches.length} deployments: ${releases} with a newer release, ${advisories} with an open advisory.`,
      actor: actorFor(role),
    });

    return HttpResponse.json({
      observedAt: at(0),
      entries: patches.length,
      releases,
      advisories,
      skipped: 0,
      failed: 0,
      instancesUpdated: patches.length,
    });
  }),

  http.get('*/api/v1/posture', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'posture.view');
    if (guard) return guard;
    return HttpResponse.json(getState().posture);
  }),

  /**
   * S-2 — the only path that may lower the served floor.
   *
   * It refuses a decision that is not a lower floor (the default is the floor; "raising" it would be
   * a re-baseline dressed as a decision) and a reason too short to be a record of what was accepted.
   */
  http.post('*/api/v1/posture/native-floor/decision', async ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'settings.manage');
    if (guard) return guard;

    const body = await readBody<{ floor?: number; reason?: string }>(request);
    const floor = Number(body.floor);
    const reason = (body.reason ?? '').trim();

    if (!isAcceptableFloorDecision({ floor, reason })) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'That is not a recordable floor decision',
        `A decision lowers the floor below ${NATIVE_FLOOR_DEPLOYMENTS}, gives a whole number, and states what is being accepted in at least 20 characters.`,
        `Send a floor between 0 and ${NATIVE_FLOOR_DEPLOYMENTS - 1} with a written reason.`,
        [{ field: 'reason', code: 'custom', message: 'A substantive reason is required.' }],
      );
    }

    const posture = getState().posture;
    const status = nativeFloorStatus(
      {
        native: posture.sso.native,
        forwardAuth: posture.sso.forwardAuth,
        signInRequired: posture.sso.signInRequired,
      },
      floor,
    );
    posture.sso.nativeFloor = {
      floor: status.floor,
      baseline: status.baseline,
      met: status.met,
      shortfall: status.shortfall,
    };
    const decision = {
      floor,
      reason,
      recordedBy: actorFor(role).id,
      recordedAt: at(0),
    };
    posture.sso.ownerDecision = decision;

    appendAudit({
      action: 'posture.native_floor.decided',
      targetType: 'native_floor_decision',
      targetId: `floor-${floor}`,
      targetLabel: `Native floor ${floor}`,
      outcome: 'success',
      detail: `Floor lowered from ${NATIVE_FLOOR_DEPLOYMENTS} to ${floor}: ${reason}`,
      actor: actorFor(role),
    });

    return HttpResponse.json(decision);
  }),

  http.get('*/api/v1/break-glass-sessions', ({ request }) => {
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

  http.post('*/api/v1/break-glass-sessions', async ({ request }) => {
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
      domainOwnerEmail: instance.domainOwner.email ?? null,
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

  http.post('*/api/v1/break-glass-sessions/:id/:action', ({ params, request }) => {
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
      // The same rule the API enforces (FR-4.11, `ISSUE-05`): a scoped approver decides read-only
      // elevations only. This used to be the *only* copy of it, which is what the review recorded.
      if (!mayApproveAccessMode(role, session.accessMode)) {
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

  http.get('*/api/v1/capacity', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'capacity.view');
    if (guard) return guard;
    return HttpResponse.json(getState().capacity);
  }),

  http.get('*/api/v1/capacity/forecast', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'capacity.view');
    if (guard) return guard;
    return HttpResponse.json(getState().capacity.forecast);
  }),
];
