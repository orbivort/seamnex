import { z } from 'zod';
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
  reviewedAt: TimestampSchema.nullable(),
  status: z.enum(['cleared', 'review_required']),
  /** Whether this instance is offered as a hosted service (blocked for restricted licences). */
  hostedService: z.boolean(),
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

export const BreakGlassSessionSchema = z.object({
  id: IdSchema,
  requester: z.object({ id: IdSchema, name: z.string().min(1) }),
  instanceId: IdSchema,
  product: z.string().min(1),
  domainOwner: z.string().min(1),
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
  scope: z.string().min(1),
  justification: z.string().min(1),
  requester: z.string().min(1),
  approver: z.string().nullable(),
  state: z.enum(['requested', 'approved', 'rejected', 'expired']),
  requestedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  patchDiff: z.string().min(1),
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
export type PatchRecord = z.infer<typeof PatchRecordSchema>;
export type PostureSummary = z.infer<typeof PostureSummarySchema>;
export type BreakGlassSession = z.infer<typeof BreakGlassSessionSchema>;
export type PolicyException = z.infer<typeof PolicyExceptionSchema>;
export type MaintenanceWindow = z.infer<typeof MaintenanceWindowSchema>;
export type DsarRequest = z.infer<typeof DsarRequestSchema>;
export type AccessRequest = z.infer<typeof AccessRequestSchema>;
export type MaintenanceWindowCreateRequest = z.infer<typeof MaintenanceWindowCreateRequestSchema>;
export type MaintenanceWindowPatchRequest = z.infer<typeof MaintenanceWindowPatchRequestSchema>;
export type AuditRangeVerifyRequest = z.infer<typeof AuditRangeVerifyRequestSchema>;
export type AuditRangeVerification = z.infer<typeof AuditRangeVerificationSchema>;
export type BreakGlassReveal = z.infer<typeof BreakGlassRevealSchema>;
