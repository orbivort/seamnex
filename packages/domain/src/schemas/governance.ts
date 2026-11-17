import { z } from 'zod';
import { WaivableComposeRuleSchema } from '../compose-rules';
import {
  ACCESS_MODES,
  ACCESS_REQUEST_KINDS,
  ACCESS_REQUEST_STATES,
  BREAK_GLASS_STATES,
  SEVERITIES,
} from '../enums';
import { EntryKeySchema, IdSchema, TimestampSchema, pageOf } from './common';

export const AuditEventSchema = z.object({
  seq: z.number().int().positive(),
  id: IdSchema,
  ts: TimestampSchema,
  actorType: z.enum(['user', 'system', 'service']),
  actorId: z.string().min(1),
  actorName: z.string().min(1),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  targetLabel: z.string().min(1),
  outcome: z.enum(['success', 'failure', 'denied']),
  detail: z.string().min(1),
  subjectRef: z.string().min(1),
  prevHash: z.string().min(1),
  hash: z.string().min(1),
});

export const AuditPageSchema = pageOf(AuditEventSchema);

export const AuditExportSchema = z.object({
  exportedAt: TimestampSchema,
  count: z.number().int().nonnegative(),
  /** The rows `count` and `sha256` describe, so the file can be checked on its own. */
  events: z.array(AuditEventSchema),
  from: TimestampSchema.nullable(),
  to: TimestampSchema.nullable(),
  sha256: z.string().min(1),
  chainValid: z.boolean(),
  downloadName: z.string().min(1),
});

export const AuditProofSchema = z.object({
  seq: z.number().int().positive(),
  hash: z.string().min(1),
  prevHash: z.string().min(1),
  algorithm: z.string().min(1),
  chainValid: z.boolean(),
  verifiedAt: TimestampSchema,
  anchoredDay: z.string().min(1),
  anchorSignature: z.string().min(1),
  /**
   * NFR-4.10: whether the stored signature covers the row it sits on. `null` when the day has no
   * anchor yet or the row predates signing — "not verifiable" and "wrong" are different answers,
   * and the screen shows them differently.
   */
  anchorSignatureValid: z.boolean().nullable().default(null),
  path: z.array(z.object({ seq: z.number().int().positive(), hash: z.string().min(1) })),
});

export const LicenseRecordSchema = z.object({
  instanceId: IdSchema,
  entryKey: EntryKeySchema,
  product: z.string().min(1),
  licenseId: z.string().min(1),
  obligations: z.array(z.string().min(1)),
  resaleRestricted: z.boolean(),
  hostedServiceRestricted: z.boolean(),
  /**
   * The review is evidence, not decoration: an unreviewed record has no reviewer and no date.
   * Both are nullable so "not reviewed yet" is representable instead of being faked with
   * `new Date()` (which made an unreviewed licence look audited today).
   */
  reviewedBy: z.string().min(1).nullable(),
  /**
   * The same reviewer, rendered: the identity mirror's display name, then its username, and only
   * then the identity id. `reviewedBy` stays the id because it is the join key back to
   * `audit_event.actor_id`; a register that shows only the id prints `stub:dev-admin` for the person
   * who signed the row off. Null exactly when `reviewedBy` is null.
   */
  reviewedByName: z.string().min(1).nullable(),
  reviewedAt: TimestampSchema.nullable(),
  /**
   * ADR-BE-25: the artefact the review was checked against — the upstream LICENSE URL or the
   * commercial contract id. The database keeps it all-or-nothing with the reviewer and the date,
   * so a cleared row can always be traced back to something a second person can open.
   */
  upstreamRef: z.string().min(1).nullable(),
  /** Reviewer note; the audit detail records only its length. */
  reviewNote: z.string().min(1).nullable(),
  status: z.enum(['cleared', 'review_required']),
  /** Whether this instance is offered as a hosted service (blocked for restricted licences). */
  hostedService: z.boolean(),
});

/**
 * FR-1.14 / AC-44 / ADR-BE-25: the auditor's sign-off.
 *
 * The reviewer and the timestamp are deliberately absent: the server takes them from the session
 * and its own clock, so no request can claim either. `upstreamRef` is required because a review
 * that cannot be checked against an artefact is an assertion.
 */
export const LicenseReviewRequestSchema = z
  .object({
    licenseId: z.string().trim().min(1).max(120),
    obligations: z.array(z.string().trim().min(1).max(300)).max(20),
    resaleRestricted: z.boolean(),
    hostedServiceRestricted: z.boolean(),
    upstreamRef: z.string().trim().min(1).max(500),
    note: z.string().trim().min(1).max(2000).optional(),
    /** A licence outside `LICENSE_TERMS` is reviewable only if the auditor says so explicitly. */
    acknowledgeUnknownLicence: z.boolean().default(false),
    /** "No obligations apply" is a valid answer, but it must be chosen, not left blank. */
    confirmNoObligations: z.boolean().default(false),
  })
  .refine((value) => value.obligations.length > 0 || value.confirmNoObligations, {
    path: ['obligations'],
    message: 'Confirm explicitly when no obligations apply.',
  });

/** FR-1.14 / AC-44: a restricted licence blocks a hosted-service configuration with a stated reason. */
export const LicenseGateSchema = z.object({
  instanceId: IdSchema,
  hostedService: z.boolean(),
  restricted: z.boolean(),
  reason: z.string().nullable(),
  evaluatedAt: TimestampSchema,
});

export const PatchRecordSchema = z.object({
  instanceId: IdSchema,
  entryKey: EntryKeySchema,
  product: z.string().min(1),
  currentVersion: z.string().min(1),
  latestVersion: z.string().min(1),
  lastUpgradeAt: TimestampSchema,
  /**
   * Age of the oldest unapplied security update, or `null` when no version check has produced one.
   * A zero would state "nothing pending" for an instance nobody has checked — the same
   * missing-evidence-as-good-news defect the licence review fields above avoid.
   */
  oldestUnappliedSecurityDays: z.number().int().nonnegative().nullable(),
  severity: z.enum(SEVERITIES),
  checkedAt: TimestampSchema,
  /**
   * FR-2.12 — the advisory the last observation found, when one is open. Optional so a register
   * written before ingestion existed still parses; `null` means observed and nothing open.
   */
  advisory: z.string().min(1).nullable().optional(),
  /** Release notes link for `latestVersion` (FR-2.12 "surface … release notes links"). */
  releaseUrl: z.string().min(1).nullable().optional(),
  /**
   * Provenance of the version pair. `observed` means the scheduler pass wrote this row; `catalog`
   * means it is the catalogue document's fallback, which is what the review found being passed off
   * as tracking. The register renders the difference rather than printing two numbers.
   */
  source: z.enum(['observed', 'catalog']).optional(),
  /** When the platform last looked upstream; `null` means never observed. */
  lastObservedAt: TimestampSchema.nullable().optional(),
});

/**
 * FR-2.12 / FR-4.7 — one upstream observation pass, reported by what it actually reached.
 *
 * Counts rather than a bare success: a pass that reached no feed because every entry lacks a
 * GitHub repository is not evidence of a healthy patch register, so `skipped` and `failed` are part
 * of the answer and the console distinguishes them from `releases`.
 */
export const UpstreamObservationResultSchema = z.object({
  observedAt: TimestampSchema,
  entries: z.number().int().nonnegative(),
  /** Entries whose upstream release metadata was refreshed. */
  releases: z.number().int().nonnegative(),
  /** Entries that gained or kept an open advisory. */
  advisories: z.number().int().nonnegative(),
  /** Entries with no feed mapping (no GitHub repository URL, no queryable package). */
  skipped: z.number().int().nonnegative(),
  /** Entries whose feed answered with an error; the previous observation is kept. */
  failed: z.number().int().nonnegative(),
  /** Instances whose `patch_record` row was written or refreshed. */
  instancesUpdated: z.number().int().nonnegative(),
});

export const PostureSummarySchema = z.object({
  generatedAt: TimestampSchema,
  /**
   * Counts are per **deployment**, the basis S-2 uses for the native floor. `totalEntries` is the
   * distinct catalog-entry count and is deliberately a different denominator: D5 and D6 share one
   * ERPNext deployment, so an entry-based count would credit that deployment twice.
   */
  sso: z.object({
    native: z.number().int().nonnegative(),
    forwardAuth: z.number().int().nonnegative(),
    signInRequired: z.number().int().nonnegative(),
    totalEntries: z.number().int().nonnegative(),
    /**
     * ADR-BE-22 — deployments whose product credential the platform holds and uses. A subset of
     * `signInRequired`, never of `native` or `forwardAuth`: a relayed password is not single sign-on,
     * and the screen states "platform-managed credential" for these rather than "provisioned
     * outside the platform".
     *
     * Optional so a reader built before the relay keeps parsing a summary, and so a deployment that
     * never enables it is not forced to render a number it has nothing to say about.
     */
    platformManagedCredentials: z.number().int().nonnegative().optional(),
    /**
     * S-2 — the floor the counts are measured against, served rather than hard-coded in the screen.
     * `floor` is normally `NATIVE_FLOOR_DEPLOYMENTS` and differs only when an owner decision lowered
     * it, which `ownerDecision` then names. Optional for back-compatibility with a stored summary.
     */
    nativeFloor: z
      .object({
        floor: z.number().int().nonnegative(),
        baseline: z.number().int().nonnegative(),
        met: z.boolean(),
        shortfall: z.number().int().nonnegative(),
      })
      .optional(),
    /** S-2's "recorded owner decision"; `null` when the default floor applies. */
    ownerDecision: z
      .object({
        floor: z.number().int().nonnegative(),
        reason: z.string().min(1),
        recordedBy: z.string().min(1),
        recordedAt: TimestampSchema,
      })
      .nullable()
      .optional(),
  }),
  missingHealthChecks: z.array(z.object({ instanceId: IdSchema, product: z.string() })),
  unverifiedRestores: z.array(
    z.object({
      instanceId: IdSchema,
      product: z.string(),
      lastVerifiedAt: TimestampSchema.nullable(),
    }),
  ),
  /** Only renewals that are due; an empty list is not proof that every certificate is healthy. */
  expiringCertificates: z.array(
    z.object({ host: z.string(), expiresAt: TimestampSchema, daysLeft: z.number().int() }),
  ),
  staleMetadata: z.array(
    z.object({
      entryKey: EntryKeySchema,
      product: z.string(),
      verifiedAt: TimestampSchema,
      daysOverdue: z.number().int(),
    }),
  ),
  /** Instances with no readiness observation: missing evidence, not a passing check. */
  instancesWithoutHealthCheck: z.number().int().nonnegative(),
  /** Denominator for the verified-restore ratio; derived, never hardcoded in the UI. */
  totalInstances: z.number().int().nonnegative(),
  /** Verified-restore coverage only (NFR-3.5 quarter). Never display this as SSO coverage. */
  coveragePercent: z.number().min(0).max(100),
});

/**
 * S-2 — lowering the native floor is an owner decision that has to be recorded, not a settings
 * toggle. The reason minimum is the same floor the break-glass and policy-exception requests use:
 * a decision nobody can read back is indistinguishable from a re-baseline.
 */
export const NativeFloorDecisionRequestSchema = z.object({
  floor: z.number().int().nonnegative(),
  reason: z.string().trim().min(20).max(1000),
});

export const NativeFloorDecisionSchema = NativeFloorDecisionRequestSchema.extend({
  recordedBy: z.string().min(1),
  recordedAt: TimestampSchema,
});

export const BreakGlassSessionSchema = z.object({
  id: IdSchema,
  requester: z.object({ id: IdSchema, name: z.string().min(1) }),
  instanceId: IdSchema,
  product: z.string().min(1),
  /**
   * Resolved from the affected instance's catalogue entry (`payload.owner`), not a placeholder:
   * FR-4.11 makes the domain owner the party the grant and expiry notices are addressed to.
   */
  domainOwner: z.string().min(1),
  /** The owner's mailbox when the entry records one; `null` when delivery falls back to the channels. */
  domainOwnerEmail: z.string().min(1).nullable(),
  accessMode: z.enum(ACCESS_MODES),
  justification: z.string().min(1),
  approver: z.string().nullable(),
  selfApproved: z.boolean(),
  state: z.enum(BREAK_GLASS_STATES),
  requestedAt: TimestampSchema,
  grantedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  createdAccounts: z.number().int().nonnegative(),
  retentionReason: z.string().nullable(),
});

export const PolicyExceptionSchema = z.object({
  id: IdSchema,
  rule: z.string().min(1),
  /**
   * The catalog entry key the exception covers (`D04-01`), not free text. NFR-4.15 makes the scope
   * part of what is approved, and the waiver is resolved by comparing this value with the product
   * being deployed — a human label could not be compared, which is how one exception came to waive a
   * rule for every product.
   */
  scope: z.string().min(1),
  justification: z.string().min(1),
  requester: z.string().min(1),
  approver: z.string().nullable(),
  state: z.enum(['requested', 'approved', 'rejected', 'expired']),
  requestedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  patchDiff: z.string().min(1),
});

/**
 * NFR-4.15 / FR-4.11 — what an R1 asks for, and nothing more.
 *
 * The deviation itself is not in the body: the platform derives it from the recorded resolution of
 * the product's source. A client that could name its own patch diff could approve itself a patch
 * that does not exist, which is the defect this whole flow exists to prevent.
 */
export const PolicyExceptionRequestSchema = z.object({
  entryKey: EntryKeySchema,
  rule: WaivableComposeRuleSchema,
  /** FR-4.11's written justification, the same floor the break-glass request uses. */
  justification: z.string().min(20),
  /** A time box, not a permanent waiver: an expiry that has passed blocks the next deployment. */
  expiresAt: TimestampSchema,
});

export const MaintenanceWindowSchema = z.object({
  id: IdSchema,
  scope: z.string().min(1),
  scopeLabel: z.string().min(1),
  /** Present for an instance-scoped window; absent for a domain-wide one. */
  instanceId: IdSchema.nullable().optional(),
  title: z.string().min(1),
  startsAt: TimestampSchema,
  endsAt: TimestampSchema,
  createdBy: z.string().min(1),
  state: z.enum(['scheduled', 'active', 'completed']),
  suppressAlerts: z.boolean(),
});

/** CL-05: maintenance windows were read-only in the prototype; these are the write shapes. */
export const MaintenanceWindowCreateRequestSchema = z.object({
  scope: z.string().min(1),
  instanceId: IdSchema.nullable().optional(),
  startsAt: TimestampSchema,
  endsAt: TimestampSchema,
});

export const MaintenanceWindowPatchRequestSchema = z.object({
  startsAt: TimestampSchema.optional(),
  endsAt: TimestampSchema.optional(),
});

/** CL-11: "Verify chain" proves a range, not only the newest row. */
export const AuditRangeVerifyRequestSchema = z.object({
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
});

export const AuditRangeVerificationSchema = z.object({
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
  valid: z.boolean(),
  /** `null` when the range verifies; otherwise the first row whose link does not hold. */
  firstBrokenSeq: z.number().int().positive().nullable(),
  checked: z.number().int().nonnegative(),
  verifiedAt: TimestampSchema,
});

/** CL-12 / CL-17: the one-time credential for an active elevation, valid for seconds. */
export const BreakGlassRevealSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  /** How the account was created in the product: `api` when the product allows it, else `manual`. */
  methodNote: z.string().min(1),
  expiresAt: TimestampSchema,
});

export const DsarRequestSchema = z.object({
  id: IdSchema,
  subjectRef: z.string().min(1),
  kind: z.enum(['export', 'delete']),
  state: z.enum(['open', 'running', 'complete', 'failed']),
  openedBy: z.string().min(1),
  openedAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
  evidence: z.array(z.string()),
});

export const AccessRequestSchema = z.object({
  id: IdSchema,
  requester: z.object({ id: IdSchema, name: z.string().min(1) }),
  kind: z.enum(ACCESS_REQUEST_KINDS),
  target: z.string().min(1),
  justification: z.string().min(1),
  state: z.enum(ACCESS_REQUEST_STATES),
  createdAt: TimestampSchema,
  decidedBy: z.string().nullable(),
  decidedAt: TimestampSchema.nullable(),
  domain: z.string().min(1),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditProof = z.infer<typeof AuditProofSchema>;
export type LicenseRecord = z.infer<typeof LicenseRecordSchema>;
export type LicenseGate = z.infer<typeof LicenseGateSchema>;
export type LicenseReviewRequest = z.infer<typeof LicenseReviewRequestSchema>;
export type PatchRecord = z.infer<typeof PatchRecordSchema>;
export type UpstreamObservationResult = z.infer<typeof UpstreamObservationResultSchema>;
export type PostureSummary = z.infer<typeof PostureSummarySchema>;
export type NativeFloorDecision = z.infer<typeof NativeFloorDecisionSchema>;
export type NativeFloorDecisionRequest = z.infer<typeof NativeFloorDecisionRequestSchema>;
export type BreakGlassSession = z.infer<typeof BreakGlassSessionSchema>;
export type PolicyException = z.infer<typeof PolicyExceptionSchema>;
export type PolicyExceptionRequest = z.infer<typeof PolicyExceptionRequestSchema>;
export type MaintenanceWindow = z.infer<typeof MaintenanceWindowSchema>;
export type DsarRequest = z.infer<typeof DsarRequestSchema>;
export type AccessRequest = z.infer<typeof AccessRequestSchema>;
export type MaintenanceWindowCreateRequest = z.infer<typeof MaintenanceWindowCreateRequestSchema>;
export type MaintenanceWindowPatchRequest = z.infer<typeof MaintenanceWindowPatchRequestSchema>;
export type AuditRangeVerifyRequest = z.infer<typeof AuditRangeVerifyRequestSchema>;
export type AuditRangeVerification = z.infer<typeof AuditRangeVerificationSchema>;
export type BreakGlassReveal = z.infer<typeof BreakGlassRevealSchema>;
