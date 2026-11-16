import type {
  AccessRequest,
  BreakGlassSession,
  DsarRequest,
  LicenseRecord,
  MaintenanceWindow,
  PatchRecord,
  PolicyException,
  PostureSummary,
} from '@seamnex/domain';
import { licenseTerms } from '@seamnex/domain';
import { at, daysAgo, hoursAgo } from './context';
import { CATALOG_BY_KEY } from './catalog';
import { INSTANCES } from './instances';

/**
 * One deployment is deliberately left unreviewed so the demo always shows the state the register
 * exists to surface; the restricted n8n deployment is reviewed, so its refusal is the licensing
 * one rather than the missing-review one.
 */
const REVIEW_PENDING_ENTRY = 'D09-01';

export const LICENSES: LicenseRecord[] = INSTANCES.map((instance) => {
  const reviewed = instance.entryKey !== REVIEW_PENDING_ENTRY;
  const terms = licenseTerms(instance.licenseId);
  const restricted =
    instance.licenseRestricted ||
    (terms?.resaleRestricted ?? false) ||
    (terms?.hostedServiceRestricted ?? false);
  return {
    instanceId: instance.id,
    entryKey: instance.entryKey,
    product: instance.product,
    licenseId: instance.licenseId,
    // Same source as the API: the licence table states the obligations before a review exists.
    obligations: [
      ...(terms?.obligations ?? ['Verify the upstream LICENSE file before procurement']),
    ],
    resaleRestricted: restricted,
    hostedServiceRestricted: restricted,
    // The id traces the sign-off back to the audit trail; the register renders the name.
    reviewedBy: reviewed ? 'usr-ruth-adler' : null,
    reviewedByName: reviewed ? 'Ruth Adler' : null,
    reviewedAt: reviewed ? daysAgo(20) : null,
    // ADR-BE-25: a cleared row always carries the artefact the auditor checked it against. The
    // catalogue reference is text, not a URL, so the mock does not invent a link that 404s.
    upstreamRef: reviewed ? `Catalogue ${instance.entryKey} · ${instance.licenseId}` : null,
    reviewNote: reviewed ? 'Verified against the upstream LICENSE file before procurement.' : null,
    status: reviewed ? 'cleared' : 'review_required',
    hostedService: false,
  };
});

export const PATCHES: PatchRecord[] = INSTANCES.map((instance, index) => {
  const current = instance.currentVersion;
  const latest = instance.availableVersion ?? current;
  const behind = latest !== current;
  return {
    instanceId: instance.id,
    entryKey: instance.entryKey,
    product: instance.product,
    currentVersion: current,
    latestVersion: latest,
    lastUpgradeAt: daysAgo(20 + index * 4),
    oldestUnappliedSecurityDays: behind ? 12 + index * 2 : 0,
    severity: behind && index % 4 === 0 ? 'critical' : behind ? 'warning' : 'info',
    checkedAt: hoursAgo(3),
  };
});

export const BREAK_GLASS: BreakGlassSession[] = [
  {
    id: 'bg-2291',
    requester: { id: 'usr-sofia', name: 'Sofia Almeida' },
    instanceId: 'inst-erp',
    product: 'D06-01 ERPNext',
    domainOwner: 'Helena Brandt',
    domainOwnerEmail: 'helena.brandt@seamnex.local',
    accessMode: 'read_only',
    justification: 'Investigate why the 15.42.0 upgrade failed readiness before the vendor call.',
    approver: 'Helena Brandt',
    selfApproved: false,
    state: 'active',
    requestedAt: at(-35),
    grantedAt: at(-32),
    expiresAt: at(28),
    revokedAt: null,
    createdAccounts: 0,
    retentionReason: null,
  },
  {
    id: 'bg-2292',
    requester: { id: 'usr-sofia', name: 'Sofia Almeida' },
    instanceId: 'inst-people',
    product: 'D07-01 OrangeHRM',
    domainOwner: 'Anja Keller',
    domainOwnerEmail: 'anja.keller@seamnex.local',
    accessMode: 'read_write',
    justification: 'Repair the leave-entitlement import that failed after the upgrade.',
    approver: null,
    selfApproved: false,
    state: 'requested',
    requestedAt: at(-12),
    grantedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAccounts: 0,
    retentionReason: null,
  },
  {
    id: 'bg-2288',
    requester: { id: 'usr-diego-salas', name: 'Diego Salas' },
    instanceId: 'inst-projects',
    product: 'D09-01 OpenProject',
    domainOwner: 'Diego Salas',
    domainOwnerEmail: 'diego.salas@seamnex.local',
    accessMode: 'read_only',
    justification: 'Confirm baseline data before the quarterly steering meeting.',
    approver: 'Ruth Adler',
    selfApproved: false,
    state: 'expired',
    requestedAt: at(-1_500),
    grantedAt: at(-1_480),
    expiresAt: at(-1_420),
    revokedAt: null,
    createdAccounts: 0,
    retentionReason: null,
  },
  {
    id: 'bg-2285',
    requester: { id: 'usr-sofia', name: 'Sofia Almeida' },
    instanceId: 'inst-insights',
    product: 'D11-01 Metabase',
    domainOwner: 'Noah Fischer',
    domainOwnerEmail: 'noah.fischer@seamnex.local',
    accessMode: 'read_only',
    justification: 'Verify the revenue dashboard definition after the schema change.',
    approver: 'Ruth Adler',
    selfApproved: false,
    state: 'revoked',
    requestedAt: at(-4_300),
    grantedAt: at(-4_290),
    expiresAt: at(-4_230),
    revokedAt: at(-4_280),
    createdAccounts: 0,
    retentionReason: null,
  },
];

export const POLICY_EXCEPTIONS: PolicyException[] = [
  {
    id: 'pe-104',
    rule: 'host_path_mount',
    // The scope is the catalog entry key (NFR-4.15): the waiver is resolved by comparing it with the
    // product being deployed, so a human label here would waive nothing.
    scope: 'D04-01',
    justification:
      'The wp-content directory must stay on the host for the agency staging sync until the migration closes.',
    requester: 'Priya Raman',
    approver: 'Sofia Almeida',
    state: 'approved',
    requestedAt: daysAgo(40),
    expiresAt: at(39 * 24 * 60),
    patchDiff:
      '= host_path_mount kept as declared (wordpress): service wordpress binds a host path (/srv/agency/woocommerce/wp-content).\n~ services.wordpress.ports: ["8080:80"] → ["80"]',
  },
  {
    id: 'pe-105',
    rule: 'unpinned_image',
    scope: 'D04-01',
    justification:
      'The payment plugin ships only a floating tag while its vendor finishes the digest-pinned release.',
    requester: 'Priya Raman',
    approver: null,
    state: 'requested',
    requestedAt: at(-260),
    expiresAt: at(14 * 24 * 60),
    patchDiff:
      '= unpinned_image kept as declared (wordpress): stage wordpress builds from woo:latest.',
  },
];

export const MAINTENANCE_WINDOWS: MaintenanceWindow[] = [
  {
    id: 'mw-441',
    scope: 'instance',
    scopeLabel: 'D10-01 Nextcloud Hub — inst-collab',
    title: 'Nextcloud Hub 31.0.4 upgrade',
    startsAt: at(-30),
    endsAt: at(90),
    createdBy: 'Sofia Almeida',
    state: 'active',
    suppressAlerts: true,
  },
  {
    id: 'mw-442',
    scope: 'instance',
    scopeLabel: 'D06-01 ERPNext — inst-erp',
    title: 'Quarterly database maintenance',
    startsAt: at(3 * 24 * 60),
    endsAt: at(3 * 24 * 60 + 120),
    createdBy: 'Sofia Almeida',
    state: 'scheduled',
    suppressAlerts: true,
  },
];

export const DSAR_REQUESTS: DsarRequest[] = [
  {
    id: 'dsar-19',
    subjectRef: 'sub_44c1',
    kind: 'export',
    state: 'running',
    openedBy: 'Ruth Adler',
    openedAt: at(-220),
    closedAt: null,
    evidence: [
      'idp_user export complete',
      'audit_event rows: 34',
      'job_log rows: 12',
      'product scopes queued (D03-01, D10-01)',
    ],
  },
];

export const ACCESS_REQUESTS: AccessRequest[] = [
  {
    id: 'ar-3204',
    requester: { id: 'usr-lena-hoff', name: 'Lena Hoff' },
    kind: 'entitlement',
    target: 'D08-01 Paperless-ngx — documents',
    justification: 'Need read access to the supplier contract archive for the Q4 renewal review.',
    state: 'open',
    createdAt: at(-90),
    decidedBy: null,
    decidedAt: null,
    domain: 'Document & Content Management',
  },
  {
    id: 'ar-3203',
    requester: { id: 'usr-iris-nwosu', name: 'Iris Nwosu' },
    kind: 'membership',
    target: 'Group crm-power-users',
    justification: 'Campaign attribution needs write access to campaign member records.',
    state: 'approved',
    createdAt: daysAgo(2),
    decidedBy: 'Mara Vogel',
    decidedAt: daysAgo(1),
    domain: 'CRM & Sales Pipeline',
  },
  {
    id: 'ar-3198',
    requester: { id: 'usr-diego-salas', name: 'Diego Salas' },
    kind: 'instance_param',
    target: 'D09-01 OpenProject — CLIENT_MAX_BODY_SIZE',
    justification: 'Design attachments above 64 MB are rejected; request 256 MB.',
    state: 'rejected',
    createdAt: daysAgo(6),
    decidedBy: 'Sofia Almeida',
    decidedAt: daysAgo(5),
    domain: 'Project & Work Management',
  },
];

const staleEntries = Object.values(CATALOG_BY_KEY).filter((entry) => entry.integration.stale);
/** NFR-3.5: a verified restore is only current for a quarter. */
const RESTORE_INTERVAL_DAYS = 90;
const unverified = INSTANCES.filter((instance) => {
  if (instance.backup.lastVerifiedRestoreAt === null) return true;
  const ageDays =
    (Date.parse(at(0)) - Date.parse(instance.backup.lastVerifiedRestoreAt)) / 86_400_000;
  return ageDays > RESTORE_INTERVAL_DAYS;
});
/**
 * S-2 counts the native floor per deployment, not per catalog entry: D5 and D6 share the ERPNext
 * deployment. Counting entries made the same deployment count twice and overstated the floor.
 */
const deployed = INSTANCES.map((instance) => ({
  instance,
  guaranteeClass: CATALOG_BY_KEY[instance.entryKey]?.guaranteeClass,
}));
const nativeDeployments = deployed.filter((row) => row.guaranteeClass === 'native').length;
const forwardAuthDeployments = deployed.filter(
  (row) => row.guaranteeClass === 'fa_header' || row.guaranteeClass === 'fa_delegated',
).length;
// Unclassified cannot be claimed as SSO; it joins the proxy-gate bucket so the counts partition.
const signInRequiredDeployments = deployed.length - nativeDeployments - forwardAuthDeployments;
const missingHealthChecks: PostureSummary['missingHealthChecks'] = [];

export const POSTURE: PostureSummary = {
  generatedAt: at(-6),
  sso: {
    native: nativeDeployments,
    forwardAuth: forwardAuthDeployments,
    signInRequired: signInRequiredDeployments,
    totalEntries: Object.keys(CATALOG_BY_KEY).length,
    // ADR-BE-22: no deployment holds a platform-managed product credential in the fixture.
    platformManagedCredentials: 0,
  },
  missingHealthChecks,
  unverifiedRestores: unverified.map((instance) => ({
    instanceId: instance.id,
    product: instance.product,
    lastVerifiedAt: instance.backup.lastVerifiedRestoreAt,
  })),
  expiringCertificates: [
    { host: '*.seamnex.local', expiresAt: at(86 * 24 * 60), daysLeft: 86 },
    { host: 'evidence.seamnex.local', expiresAt: at(21 * 24 * 60), daysLeft: 21 },
    { host: 'hooks.seamnex.local', expiresAt: at(9 * 24 * 60), daysLeft: 9 },
  ],
  staleMetadata: staleEntries.map((entry) => ({
    entryKey: entry.key,
    product: entry.product,
    verifiedAt: entry.integration.verifiedAt,
    daysOverdue: Math.max(
      1,
      Math.round((Date.parse(at(0)) - Date.parse(entry.integration.nextReviewAt)) / 86_400_000),
    ),
  })),
  instancesWithoutHealthCheck: missingHealthChecks.length,
  totalInstances: INSTANCES.length,
  coveragePercent:
    INSTANCES.length === 0
      ? 0
      : Math.round(((INSTANCES.length - unverified.length) / INSTANCES.length) * 100),
};
