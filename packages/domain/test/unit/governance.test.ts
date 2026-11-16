import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AccessRequestSchema,
  AuditEventSchema,
  AuditExportSchema,
  AuditPageSchema,
  AuditProofSchema,
  AuditRangeVerificationSchema,
  AuditRangeVerifyRequestSchema,
  BreakGlassRevealSchema,
  BreakGlassSessionSchema,
  DsarRequestSchema,
  LicenseGateSchema,
  LicenseRecordSchema,
  LicenseReviewRequestSchema,
  MaintenanceWindowCreateRequestSchema,
  MaintenanceWindowPatchRequestSchema,
  MaintenanceWindowSchema,
  PatchRecordSchema,
  PolicyExceptionSchema,
  PostureSummarySchema,
} from '../../src/schemas/governance';

/**
 * FR-1.14 / FR-4.3 / ADR-BE-25: the governance contracts are what the console, the portal and the
 * API agree on, so the cases below pin the *refusals* as much as the happy path. Three of them are
 * load-bearing rather than cosmetic:
 *
 * - a licence review cannot be submitted without evidence (`upstreamRef`), and "no obligations" has
 *   to be chosen rather than left blank;
 * - an unreviewed licence has no reviewer and no date, so "not reviewed yet" is representable
 *   instead of being faked with today's clock;
 * - a missing measurement (`null`) is never encoded as a passing zero.
 */

const AT = '2026-11-15T09:00:00Z';

function timeRange() {
  return { startsAt: AT, endsAt: AT };
}

/** The issues a refused value produced; a value that parses fails the test instead of passing it. */
function issuesOf<T extends z.ZodType>(schema: T, candidate: unknown) {
  const result = schema.safeParse(candidate);
  if (result.success) {
    throw new Error('expected the candidate to be refused, but it parsed');
  }
  return result.error.issues;
}

/** Parse or fail the test: a fixture that stops matching the contract must not pass silently. */
function parsed<T extends z.ZodType>(schema: T, candidate: unknown): z.output<T> {
  const result = schema.safeParse(candidate);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

function accepts<T extends z.ZodType>(schema: T, candidate: unknown): boolean {
  return schema.safeParse(candidate).success;
}

const auditEvent = {
  seq: 1,
  id: 'aud_01',
  ts: AT,
  actorType: 'user',
  actorId: 'usr_01',
  actorName: 'Ada Lovelace',
  action: 'license.review',
  targetType: 'license',
  targetId: 'lic_01',
  targetLabel: 'AGPL-3.0 obligations',
  outcome: 'success',
  detail: 'Reviewed the AGPL obligations.',
  subjectRef: 'lic_01',
  prevHash: 'sha256:0000',
  hash: 'sha256:1111',
};

const auditExport = {
  exportedAt: AT,
  count: 1,
  events: [auditEvent],
  from: AT,
  to: AT,
  sha256: 'sha256:export',
  chainValid: true,
  downloadName: 'audit-2026-11-15.jsonl',
};

const auditProof = {
  seq: 1,
  hash: 'sha256:1111',
  prevHash: 'sha256:0000',
  algorithm: 'sha256',
  chainValid: true,
  verifiedAt: AT,
  anchoredDay: '2026-11-15',
  anchorSignature: 'sig:abc',
  path: [{ seq: 1, hash: 'sha256:1111' }],
};

const licenseRecord = {
  instanceId: 'inst_01',
  entryKey: 'D05-01',
  product: 'ERPNext',
  licenseId: 'GPL-3.0',
  obligations: ['Publish modifications'],
  resaleRestricted: false,
  hostedServiceRestricted: true,
  reviewedBy: 'usr_auditor',
  reviewedByName: 'Grace Hopper',
  reviewedAt: AT,
  upstreamRef: 'https://example.test/LICENSE',
  reviewNote: 'Checked against the upstream LICENSE file.',
  status: 'cleared',
  hostedService: false,
};

function licenseReview(overrides: Record<string, unknown> = {}) {
  return {
    licenseId: 'GPL-3.0',
    obligations: ['Publish modifications'],
    resaleRestricted: false,
    hostedServiceRestricted: true,
    upstreamRef: 'https://example.test/LICENSE',
    ...overrides,
  };
}

const patchRecord = {
  instanceId: 'inst_01',
  entryKey: 'D05-01',
  product: 'ERPNext',
  currentVersion: '15.1.0',
  latestVersion: '15.2.0',
  lastUpgradeAt: AT,
  oldestUnappliedSecurityDays: 12,
  severity: 'warning',
  checkedAt: AT,
};

const postureSummary = {
  generatedAt: AT,
  sso: {
    native: 4,
    forwardAuth: 3,
    signInRequired: 2,
    totalEntries: 9,
    platformManagedCredentials: 1,
  },
  missingHealthChecks: [{ instanceId: 'inst_01', product: 'ERPNext' }],
  unverifiedRestores: [{ instanceId: 'inst_01', product: 'ERPNext', lastVerifiedAt: null }],
  expiringCertificates: [{ host: 'erp.example.test', expiresAt: AT, daysLeft: 12 }],
  staleMetadata: [{ entryKey: 'D05-01', product: 'ERPNext', verifiedAt: AT, daysOverdue: 3 }],
  instancesWithoutHealthCheck: 1,
  totalInstances: 10,
  coveragePercent: 80,
};

const breakGlassSession = {
  id: 'bg_01',
  requester: { id: 'usr_01', name: 'Ada Lovelace' },
  instanceId: 'inst_01',
  product: 'ERPNext',
  domainOwner: 'Core Operations',
  domainOwnerEmail: 'core.operations@example.test',
  accessMode: 'read_only',
  justification: 'The product is down and the admin UI is unreachable through SSO.',
  approver: null,
  selfApproved: false,
  state: 'requested',
  requestedAt: AT,
  grantedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAccounts: 0,
  retentionReason: null,
};

const policyException = {
  id: 'exc_01',
  rule: 'password.min_length',
  scope: 'D05-01',
  justification: 'A legacy account cannot meet the minimum length.',
  requester: 'usr_01',
  approver: 'usr_02',
  state: 'approved',
  requestedAt: AT,
  expiresAt: AT,
  patchDiff: '- minLength: 14\n+ minLength: 12',
};

const maintenanceWindow = {
  id: 'maint_01',
  scope: 'domain',
  scopeLabel: 'Core Operations',
  title: 'PostgreSQL minor upgrade',
  startsAt: AT,
  endsAt: AT,
  createdBy: 'usr_01',
  state: 'scheduled',
  suppressAlerts: true,
};

const auditRangeVerification = {
  fromSeq: 1,
  toSeq: 10,
  valid: true,
  firstBrokenSeq: null,
  checked: 10,
  verifiedAt: AT,
};

const dsarRequest = {
  id: 'dsar_01',
  subjectRef: 'subject:01',
  kind: 'export',
  state: 'open',
  openedBy: 'usr_01',
  openedAt: AT,
  closedAt: null,
  evidence: [],
};

const accessRequest = {
  id: 'req_01',
  requester: { id: 'usr_01', name: 'Ada Lovelace' },
  kind: 'entitlement',
  target: 'ERPNext:Accounting',
  justification: 'Month-end close.',
  state: 'open',
  createdAt: AT,
  decidedBy: null,
  decidedAt: null,
  domain: 'Core Operations',
};

describe('audit event', () => {
  it('accepts a chained row', () => {
    expect(accepts(AuditEventSchema, auditEvent)).toBe(true);
  });

  it('refuses a sequence number that cannot be a position in a chain', () => {
    // The chain is ordered by `seq`: zero or a fraction has no predecessor to link to.
    expect(accepts(AuditEventSchema, { ...auditEvent, seq: 0 })).toBe(false);
    expect(accepts(AuditEventSchema, { ...auditEvent, seq: 1.5 })).toBe(false);
  });

  it('refuses an actor type the platform does not emit', () => {
    expect(accepts(AuditEventSchema, { ...auditEvent, actorType: 'root' })).toBe(false);
  });

  it('refuses a row whose detail is empty, because the trail exists to be read', () => {
    expect(accepts(AuditEventSchema, { ...auditEvent, detail: '' })).toBe(false);
  });

  it('page envelope carries the cursor and the total, not a bare array', () => {
    const page = {
      items: [auditEvent],
      nextCursor: 'cursor:2',
      total: 30,
    };
    expect(accepts(AuditPageSchema, page)).toBe(true);
    // The last page is stated with `null`, not by omitting the cursor.
    expect(accepts(AuditPageSchema, { ...page, nextCursor: null })).toBe(true);
    expect(accepts(AuditPageSchema, { ...page, total: -1 })).toBe(false);
    expect(accepts(AuditPageSchema, { items: [auditEvent] })).toBe(false);
  });
});

describe('audit export', () => {
  it('accepts a signed export that carries the rows it describes', () => {
    expect(accepts(AuditExportSchema, auditExport)).toBe(true);
  });

  it('accepts an unbounded export, stated with null instead of an invented date', () => {
    expect(accepts(AuditExportSchema, { ...auditExport, from: null, to: null })).toBe(true);
  });

  it('refuses a negative count or an empty digest', () => {
    expect(accepts(AuditExportSchema, { ...auditExport, count: -1 })).toBe(false);
    expect(accepts(AuditExportSchema, { ...auditExport, sha256: '' })).toBe(false);
  });

  it('refuses an export whose rows do not match the event contract', () => {
    expect(accepts(AuditExportSchema, { ...auditExport, events: [{ seq: 1 }] })).toBe(false);
  });
});

describe('audit proof', () => {
  it('accepts a proof path', () => {
    expect(accepts(AuditProofSchema, { ...auditProof, path: [] })).toBe(true);
    expect(accepts(AuditProofSchema, auditProof)).toBe(true);
  });

  it('refuses a path step without a position in the chain', () => {
    expect(accepts(AuditProofSchema, { ...auditProof, path: [{ seq: 0, hash: 'x' }] })).toBe(false);
    expect(accepts(AuditProofSchema, { ...auditProof, path: [{ seq: 1, hash: '' }] })).toBe(false);
  });

  it('refuses a proof that names no algorithm', () => {
    expect(accepts(AuditProofSchema, { ...auditProof, algorithm: '' })).toBe(false);
  });
});

describe('licence record', () => {
  it('accepts a reviewed record', () => {
    expect(accepts(LicenseRecordSchema, licenseRecord)).toBe(true);
  });

  it('accepts a record nobody has reviewed, with the whole review block null', () => {
    const data = parsed(LicenseRecordSchema, {
      ...licenseRecord,
      reviewedBy: null,
      reviewedByName: null,
      reviewedAt: null,
      upstreamRef: null,
      reviewNote: null,
      status: 'review_required',
    });

    // "Not reviewed yet" is a state, not an empty string and not today's date.
    expect(data.reviewedAt).toBeNull();
    expect(data.reviewedByName).toBeNull();
    expect(data.status).toBe('review_required');
  });

  it('refuses an empty reviewer, which would look reviewed with nobody behind it', () => {
    expect(accepts(LicenseRecordSchema, { ...licenseRecord, reviewedBy: '' })).toBe(false);
  });

  it('refuses a status outside the register vocabulary', () => {
    expect(accepts(LicenseRecordSchema, { ...licenseRecord, status: 'pending' })).toBe(false);
  });

  it('refuses an entry key the catalog grammar does not describe', () => {
    expect(accepts(LicenseRecordSchema, { ...licenseRecord, entryKey: 'D0-01' })).toBe(false);
    expect(accepts(LicenseRecordSchema, { ...licenseRecord, entryKey: 'D13-01' })).toBe(true);
  });
});

describe('licence review request (FR-1.14 / AC-44)', () => {
  it('accepts a review with obligations and evidence', () => {
    const data = parsed(LicenseReviewRequestSchema, licenseReview());

    expect(data.upstreamRef).toBe('https://example.test/LICENSE');
    // The two confirmations are opt-in: absent means false, never undefined.
    expect(data.acknowledgeUnknownLicence).toBe(false);
    expect(data.confirmNoObligations).toBe(false);
  });

  it('refuses an empty obligation list that was not confirmed', () => {
    const issues = issuesOf(LicenseReviewRequestSchema, licenseReview({ obligations: [] }));

    expect(issues.map((issue) => issue.message)).toContain(
      'Confirm explicitly when no obligations apply.',
    );
    // The message has to land on the field the auditor can act on.
    expect(issues.some((issue) => issue.path.join('.') === 'obligations')).toBe(true);
  });

  it('accepts "no obligations" when it was chosen', () => {
    const data = parsed(
      LicenseReviewRequestSchema,
      licenseReview({ obligations: [], confirmNoObligations: true }),
    );

    expect(data.obligations).toEqual([]);
    expect(data.confirmNoObligations).toBe(true);
  });

  it('refuses a review with no artefact to check against', () => {
    expect(accepts(LicenseReviewRequestSchema, licenseReview({ upstreamRef: '' }))).toBe(false);
    expect(accepts(LicenseReviewRequestSchema, licenseReview({ upstreamRef: '   ' }))).toBe(false);
  });

  it('refuses a blank obligation, which would satisfy the refine without saying anything', () => {
    expect(accepts(LicenseReviewRequestSchema, licenseReview({ obligations: ['   '] }))).toBe(
      false,
    );
  });

  it('accepts twenty obligations and refuses twenty-one', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `Obligation ${index + 1}`);

    expect(accepts(LicenseReviewRequestSchema, licenseReview({ obligations: twenty }))).toBe(true);
    expect(
      accepts(LicenseReviewRequestSchema, licenseReview({ obligations: [...twenty, 'One more'] })),
    ).toBe(false);
  });

  it('trims the fields the auditor pastes from a licence page', () => {
    const data = parsed(
      LicenseReviewRequestSchema,
      licenseReview({ licenseId: '  GPL-3.0  ', obligations: ['  Publish modifications  '] }),
    );

    expect(data.licenseId).toBe('GPL-3.0');
    expect(data.obligations).toEqual(['Publish modifications']);
  });

  it('enforces the documented length ceilings', () => {
    expect(accepts(LicenseReviewRequestSchema, licenseReview({ licenseId: 'L'.repeat(120) }))).toBe(
      true,
    );
    expect(accepts(LicenseReviewRequestSchema, licenseReview({ licenseId: 'L'.repeat(121) }))).toBe(
      false,
    );
    expect(
      accepts(LicenseReviewRequestSchema, licenseReview({ upstreamRef: 'u'.repeat(500) })),
    ).toBe(true);
    expect(
      accepts(LicenseReviewRequestSchema, licenseReview({ upstreamRef: 'u'.repeat(501) })),
    ).toBe(false);
    expect(accepts(LicenseReviewRequestSchema, licenseReview({ note: 'n'.repeat(2000) }))).toBe(
      true,
    );
    expect(accepts(LicenseReviewRequestSchema, licenseReview({ note: 'n'.repeat(2001) }))).toBe(
      false,
    );
    expect(accepts(LicenseReviewRequestSchema, licenseReview({ note: '   ' }))).toBe(false);
  });

  it('leaves the reviewer and the timestamp off the request entirely', () => {
    const data = parsed(
      LicenseReviewRequestSchema,
      licenseReview({ reviewedBy: 'usr_someone', reviewedAt: AT }),
    );

    // The server takes both from the session and its own clock; a request cannot claim either.
    expect(data).not.toHaveProperty('reviewedBy');
    expect(data).not.toHaveProperty('reviewedAt');
  });
});

describe('licence gate', () => {
  it('accepts an allowed configuration with no reason', () => {
    expect(
      accepts(LicenseGateSchema, {
        instanceId: 'inst_01',
        hostedService: true,
        restricted: false,
        reason: null,
        evaluatedAt: AT,
      }),
    ).toBe(true);
  });

  it('accepts a refusal that names its reason', () => {
    expect(
      accepts(LicenseGateSchema, {
        instanceId: 'inst_01',
        hostedService: true,
        restricted: true,
        reason: 'The licence restricts hosted service.',
        evaluatedAt: AT,
      }),
    ).toBe(true);
  });

  it('refuses a gate nobody evaluated', () => {
    expect(accepts(LicenseGateSchema, { instanceId: 'inst_01', hostedService: true })).toBe(false);
  });
});

describe('patch record', () => {
  it('accepts a measured record', () => {
    expect(accepts(PatchRecordSchema, patchRecord)).toBe(true);
  });

  it('accepts zero pending days, which states "checked and nothing due"', () => {
    expect(accepts(PatchRecordSchema, { ...patchRecord, oldestUnappliedSecurityDays: 0 })).toBe(
      true,
    );
  });

  it('accepts null, which states "nobody has checked" rather than "nothing pending"', () => {
    const data = parsed(PatchRecordSchema, {
      ...patchRecord,
      oldestUnappliedSecurityDays: null,
      severity: 'info',
    });

    expect(data.oldestUnappliedSecurityDays).toBeNull();
  });

  it('refuses a negative age and an unknown severity', () => {
    expect(accepts(PatchRecordSchema, { ...patchRecord, oldestUnappliedSecurityDays: -1 })).toBe(
      false,
    );
    expect(accepts(PatchRecordSchema, { ...patchRecord, severity: 'high' })).toBe(false);
    expect(accepts(PatchRecordSchema, { ...patchRecord, severity: 'critical' })).toBe(true);
  });
});

describe('posture summary', () => {
  it('accepts a full summary', () => {
    expect(accepts(PostureSummarySchema, postureSummary)).toBe(true);
  });

  it('accepts a summary from before the credential relay existed', () => {
    const sso = { native: 4, forwardAuth: 3, signInRequired: 2, totalEntries: 9 };

    expect(accepts(PostureSummarySchema, { ...postureSummary, sso })).toBe(true);
  });

  it('refuses a negative deployment count anywhere in the SSO block', () => {
    for (const key of ['native', 'forwardAuth', 'signInRequired', 'totalEntries'] as const) {
      expect(
        accepts(PostureSummarySchema, {
          ...postureSummary,
          sso: { ...postureSummary.sso, [key]: -1 },
        }),
        key,
      ).toBe(false);
    }
    expect(
      accepts(PostureSummarySchema, {
        ...postureSummary,
        sso: { ...postureSummary.sso, platformManagedCredentials: -1 },
      }),
    ).toBe(false);
  });

  it('holds the coverage percentage inside 0–100, inclusive', () => {
    expect(accepts(PostureSummarySchema, { ...postureSummary, coveragePercent: 0 })).toBe(true);
    expect(accepts(PostureSummarySchema, { ...postureSummary, coveragePercent: 100 })).toBe(true);
    expect(accepts(PostureSummarySchema, { ...postureSummary, coveragePercent: 100.5 })).toBe(
      false,
    );
    expect(accepts(PostureSummarySchema, { ...postureSummary, coveragePercent: -0.5 })).toBe(false);
  });

  it('keeps the missing-evidence lists explicit rather than inferred from empty counts', () => {
    const data = parsed(PostureSummarySchema, {
      ...postureSummary,
      missingHealthChecks: [],
      unverifiedRestores: [],
      expiringCertificates: [],
      staleMetadata: [],
      instancesWithoutHealthCheck: 0,
      totalInstances: 0,
      coveragePercent: 0,
    });

    expect(data.missingHealthChecks).toEqual([]);
    expect(data.instancesWithoutHealthCheck).toBe(0);
  });

  it('accepts an unverified restore with no verification date', () => {
    const data = parsed(PostureSummarySchema, postureSummary);

    expect(data.unverifiedRestores[0]?.lastVerifiedAt).toBeNull();
  });

  it('refuses a negative instance total, which no ratio could use', () => {
    expect(accepts(PostureSummarySchema, { ...postureSummary, totalInstances: -1 })).toBe(false);
  });
});

describe('break-glass session', () => {
  it('accepts a request that nobody has approved yet', () => {
    const data = parsed(BreakGlassSessionSchema, breakGlassSession);

    expect(data.approver).toBeNull();
    expect(data.grantedAt).toBeNull();
    expect(data.expiresAt).toBeNull();
  });

  it('accepts an active session with zero created accounts', () => {
    expect(
      accepts(BreakGlassSessionSchema, {
        ...breakGlassSession,
        state: 'active',
        approver: 'usr_02',
        grantedAt: AT,
        expiresAt: AT,
        createdAccounts: 0,
      }),
    ).toBe(true);
  });

  it('refuses an access mode beyond the two the platform grants', () => {
    expect(accepts(BreakGlassSessionSchema, { ...breakGlassSession, accessMode: 'admin' })).toBe(
      false,
    );
    expect(
      accepts(BreakGlassSessionSchema, { ...breakGlassSession, accessMode: 'read_write' }),
    ).toBe(true);
  });

  it('refuses a state outside the elevation lifecycle', () => {
    expect(accepts(BreakGlassSessionSchema, { ...breakGlassSession, state: 'pending' })).toBe(
      false,
    );
    expect(accepts(BreakGlassSessionSchema, { ...breakGlassSession, state: 'revoked' })).toBe(true);
  });

  it('refuses a negative created-account count and a nameless requester', () => {
    expect(accepts(BreakGlassSessionSchema, { ...breakGlassSession, createdAccounts: -1 })).toBe(
      false,
    );
    expect(
      accepts(BreakGlassSessionSchema, {
        ...breakGlassSession,
        requester: { id: 'usr_01', name: '' },
      }),
    ).toBe(false);
  });
});

describe('policy exception', () => {
  it('accepts an approved exception with its patch', () => {
    expect(accepts(PolicyExceptionSchema, policyException)).toBe(true);
  });

  it('refuses an exception without a patch, which is a request for an unnamed change', () => {
    expect(accepts(PolicyExceptionSchema, { ...policyException, patchDiff: '' })).toBe(false);
  });

  it('refuses a state outside the exception lifecycle', () => {
    expect(accepts(PolicyExceptionSchema, { ...policyException, state: 'withdrawn' })).toBe(false);
    expect(accepts(PolicyExceptionSchema, { ...policyException, approver: null })).toBe(true);
  });
});

describe('maintenance window', () => {
  it('accepts a domain-wide window with no instance', () => {
    const data = parsed(MaintenanceWindowSchema, maintenanceWindow);

    expect(data.instanceId).toBeUndefined();
    expect(data.scope).toBe('domain');
  });

  it('accepts an instance-scoped window, and a null instance on the response', () => {
    expect(accepts(MaintenanceWindowSchema, { ...maintenanceWindow, instanceId: 'inst_01' })).toBe(
      true,
    );
    expect(accepts(MaintenanceWindowSchema, { ...maintenanceWindow, instanceId: null })).toBe(true);
  });

  it('refuses a state outside the window lifecycle', () => {
    expect(accepts(MaintenanceWindowSchema, { ...maintenanceWindow, state: 'cancelled' })).toBe(
      false,
    );
    expect(accepts(MaintenanceWindowSchema, { ...maintenanceWindow, state: 'completed' })).toBe(
      true,
    );
  });

  it('refuses a timestamp that is not ISO-8601 UTC', () => {
    expect(accepts(MaintenanceWindowSchema, { ...maintenanceWindow, startsAt: AT })).toBe(true);
    expect(
      accepts(MaintenanceWindowSchema, { ...maintenanceWindow, startsAt: '2026-11-15 09:00' }),
    ).toBe(false);
    expect(
      accepts(MaintenanceWindowSchema, {
        ...maintenanceWindow,
        endsAt: '2026-11-15T09:00:00+01:00',
      }),
    ).toBe(false);
  });
});

describe('maintenance window writes (CL-05)', () => {
  it('accepts a create request for a domain-wide window', () => {
    const data = parsed(MaintenanceWindowCreateRequestSchema, { scope: 'domain', ...timeRange() });

    expect(data.instanceId).toBeUndefined();
  });

  it('accepts a create request for one instance, and states "no instance" with null', () => {
    expect(
      accepts(MaintenanceWindowCreateRequestSchema, {
        scope: 'instance',
        instanceId: 'inst_01',
        ...timeRange(),
      }),
    ).toBe(true);
    expect(
      accepts(MaintenanceWindowCreateRequestSchema, {
        scope: 'instance',
        instanceId: null,
        ...timeRange(),
      }),
    ).toBe(true);
  });

  it('refuses a create request without a scope or a range', () => {
    expect(accepts(MaintenanceWindowCreateRequestSchema, { ...timeRange() })).toBe(false);
    expect(accepts(MaintenanceWindowCreateRequestSchema, { scope: 'domain' })).toBe(false);
  });

  it('accepts an empty patch, which changes dates only when they are sent', () => {
    const data = parsed(MaintenanceWindowPatchRequestSchema, {});

    expect(data.startsAt).toBeUndefined();
    expect(data.endsAt).toBeUndefined();
  });

  it('accepts a one-sided patch and refuses a malformed date', () => {
    expect(accepts(MaintenanceWindowPatchRequestSchema, { endsAt: AT })).toBe(true);
    expect(accepts(MaintenanceWindowPatchRequestSchema, { startsAt: 'tomorrow' })).toBe(false);
  });
});

describe('audit range verification (CL-11)', () => {
  it('accepts a range request with positive ends', () => {
    expect(accepts(AuditRangeVerifyRequestSchema, { fromSeq: 1, toSeq: 10 })).toBe(true);
  });

  it('refuses sequence zero and fractions, which address no row', () => {
    expect(accepts(AuditRangeVerifyRequestSchema, { fromSeq: 0, toSeq: 10 })).toBe(false);
    expect(accepts(AuditRangeVerifyRequestSchema, { fromSeq: 1, toSeq: 10.5 })).toBe(false);
  });

  it('accepts a range that verifies, naming no broken row', () => {
    const data = parsed(AuditRangeVerificationSchema, auditRangeVerification);

    expect(data.firstBrokenSeq).toBeNull();
    expect(data.valid).toBe(true);
  });

  it('accepts a broken range that names the first row whose link does not hold', () => {
    expect(
      accepts(AuditRangeVerificationSchema, {
        ...auditRangeVerification,
        valid: false,
        firstBrokenSeq: 7,
      }),
    ).toBe(true);
  });

  it('refuses a broken row that is not a chain position, or a negative checked count', () => {
    expect(
      accepts(AuditRangeVerificationSchema, { ...auditRangeVerification, firstBrokenSeq: 0 }),
    ).toBe(false);
    expect(accepts(AuditRangeVerificationSchema, { ...auditRangeVerification, checked: -1 })).toBe(
      false,
    );
  });
});

describe('break-glass reveal (CL-12 / CL-17)', () => {
  const reveal = {
    username: 'breakglass_01',
    password: 'one-time',
    methodNote: 'Created through the product API.',
    expiresAt: AT,
  };

  it('accepts a one-time credential with its method and expiry', () => {
    expect(accepts(BreakGlassRevealSchema, reveal)).toBe(true);
  });

  it('refuses a reveal with no credential or no explanation of how it was created', () => {
    expect(accepts(BreakGlassRevealSchema, { ...reveal, password: '' })).toBe(false);
    expect(accepts(BreakGlassRevealSchema, { ...reveal, methodNote: '' })).toBe(false);
    expect(accepts(BreakGlassRevealSchema, { ...reveal, expiresAt: 'soon' })).toBe(false);
  });
});

describe('DSAR request', () => {
  it('accepts an open export request with no evidence yet', () => {
    const data = parsed(DsarRequestSchema, dsarRequest);

    expect(data.closedAt).toBeNull();
    expect(data.evidence).toEqual([]);
  });

  it('accepts a completed delete request with its evidence', () => {
    expect(
      accepts(DsarRequestSchema, {
        ...dsarRequest,
        kind: 'delete',
        state: 'complete',
        closedAt: AT,
        evidence: ['job:01', 'artifact:01'],
      }),
    ).toBe(true);
  });

  it('refuses a kind or state outside the privacy queue vocabulary', () => {
    expect(accepts(DsarRequestSchema, { ...dsarRequest, kind: 'rectify' })).toBe(false);
    expect(accepts(DsarRequestSchema, { ...dsarRequest, state: 'queued' })).toBe(false);
  });

  it('refuses a request with no subject to act on', () => {
    expect(accepts(DsarRequestSchema, { ...dsarRequest, subjectRef: '' })).toBe(false);
  });
});

describe('access request', () => {
  it('accepts an undecided request', () => {
    const data = parsed(AccessRequestSchema, accessRequest);

    expect(data.decidedBy).toBeNull();
    expect(data.decidedAt).toBeNull();
    expect(data.state).toBe('open');
  });

  it('accepts a decided request', () => {
    expect(
      accepts(AccessRequestSchema, {
        ...accessRequest,
        state: 'approved',
        decidedBy: 'usr_02',
        decidedAt: AT,
      }),
    ).toBe(true);
  });

  it('refuses a kind the platform cannot grant', () => {
    expect(accepts(AccessRequestSchema, { ...accessRequest, kind: 'role' })).toBe(false);
    expect(accepts(AccessRequestSchema, { ...accessRequest, kind: 'instance_param' })).toBe(true);
  });

  it('refuses a state outside the request lifecycle', () => {
    expect(accepts(AccessRequestSchema, { ...accessRequest, state: 'running' })).toBe(false);
    expect(accepts(AccessRequestSchema, { ...accessRequest, state: 'expired' })).toBe(true);
  });

  it('refuses a request with no justification, which nobody could decide on', () => {
    expect(accepts(AccessRequestSchema, { ...accessRequest, justification: '' })).toBe(false);
    expect(accepts(AccessRequestSchema, { ...accessRequest, domain: '' })).toBe(false);
  });
});
