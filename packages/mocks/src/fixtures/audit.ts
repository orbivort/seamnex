import type { AuditEvent, AuditProof } from '@seamnex/domain';
import { at, daysAgo } from './context';

const ZERO_HASH = `sha256:${'0'.repeat(64)}`;

function hashFor(seq: number): string {
  let body = '';
  for (let i = 0; i < 32; i += 1) {
    body += ((seq * 37 + i * 53) % 256).toString(16).padStart(2, '0');
  }
  return `sha256:${body}`;
}

type EventSeed = {
  minutesAgo: number;
  actorType: AuditEvent['actorType'];
  actorId: string;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  outcome: AuditEvent['outcome'];
  detail: string;
  subjectRef: string;
};

const SEEDS: EventSeed[] = [
  {
    minutesAgo: 2,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'instance.env.changed',
    targetType: 'instance',
    targetId: 'inst-documents',
    targetLabel: 'D08-01 Paperless-ngx',
    outcome: 'success',
    detail:
      'PAPERLESS_OCR_LANGUAGE changed; recreate required. Diff recorded in render set rs-documents-2184.',
    subjectRef: 'sub_7a1c',
  },
  {
    minutesAgo: 44,
    actorType: 'user',
    actorId: 'usr-anja-keller',
    actorName: 'Anja Keller',
    action: 'instance.upgrade.failed',
    targetType: 'instance',
    targetId: 'inst-people',
    targetLabel: 'D07-01 OrangeHRM',
    outcome: 'failure',
    detail: 'Upgrade to 5.8.1 left readiness failing; error_code HEALTHCHECK_FAILED.',
    subjectRef: 'sub_2b90',
  },
  {
    minutesAgo: 95,
    actorType: 'user',
    actorId: 'usr-mara-vogel',
    actorName: 'Mara Vogel',
    action: 'instance.upgrade.denied',
    targetType: 'instance',
    targetId: 'inst-crm',
    targetLabel: 'D01-01 EspoCRM',
    outcome: 'denied',
    detail: 'Upgrade refused: image 10.0.11 has no pinned digest in catalog revision 9c2f1ab.',
    subjectRef: 'sub_4d18',
  },
  {
    minutesAgo: 120,
    actorType: 'system',
    actorId: 'scheduler',
    actorName: 'Scheduler',
    action: 'workflow.run.failed',
    targetType: 'workflow',
    targetId: 'wf-lead-capture',
    targetLabel: 'Lead captured → CRM contact',
    outcome: 'failure',
    detail:
      'Run run-8799 failed after 3 retries (HTTP 429). Alert sent to owner and failure queue.',
    subjectRef: 'sub_sys',
  },
  {
    minutesAgo: 180,
    actorType: 'service',
    actorId: 'broker-proxy',
    actorName: 'Credential broker',
    action: 'credential.use',
    targetType: 'workflow',
    targetId: 'wf-won-to-project',
    targetLabel: 'Won opportunity → project kickoff',
    outcome: 'success',
    detail:
      'Scoped credential cs-301 used for work_packages.write; secret never exposed to the author.',
    subjectRef: 'sub_svc',
  },
  {
    minutesAgo: 240,
    actorType: 'system',
    actorId: 'backup-runner',
    actorName: 'Backup runner',
    action: 'backup.completed',
    targetType: 'instance',
    targetId: 'inst-collab',
    targetLabel: 'D10-01 Nextcloud Hub',
    outcome: 'success',
    detail: 'Database-consistent dump plus volume capture; 8.4 GB; verified_at not set.',
    subjectRef: 'sub_sys',
  },
  {
    minutesAgo: 310,
    actorType: 'system',
    actorId: 'drift-check',
    actorName: 'Drift reconciler',
    action: 'instance.drift.detected',
    targetType: 'instance',
    targetId: 'inst-documents',
    targetLabel: 'D08-01 Paperless-ngx',
    outcome: 'success',
    detail: 'Two drift records: PAPERLESS_OCR_LANGUAGE mismatch and one undeclared variable.',
    subjectRef: 'sub_sys',
  },
  {
    minutesAgo: 420,
    actorType: 'user',
    actorId: 'usr-tomas-reiter',
    actorName: 'Tomas Reiter',
    action: 'workflow.validate.failed',
    targetType: 'workflow',
    targetId: 'wf-sla-to-erp',
    targetLabel: 'SLA breach → ERP service order',
    outcome: 'failure',
    detail: 'Two node-level errors: unbound customer mapping and insufficient credential scope.',
    subjectRef: 'sub_9e42',
  },
  {
    minutesAgo: 480,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'breakglass.approved',
    targetType: 'instance',
    targetId: 'inst-erp',
    targetLabel: 'D06-01 ERPNext',
    outcome: 'success',
    detail:
      'Read-only session bg-2291 approved by Helena Brandt for 60 minutes; justification recorded.',
    subjectRef: 'sub_7a1c',
  },
  {
    minutesAgo: 540,
    actorType: 'user',
    actorId: 'usr-helena-brandt',
    actorName: 'Helena Brandt',
    action: 'audit.export',
    targetType: 'platform',
    targetId: 'audit',
    targetLabel: 'Audit log',
    outcome: 'success',
    detail: 'Exported 1 240 events for the October review; hash-chain proof included.',
    subjectRef: 'sub_31ff',
  },
  {
    minutesAgo: 720,
    actorType: 'system',
    actorId: 'scheduler',
    actorName: 'Scheduler',
    action: 'certificate.renewed',
    targetType: 'platform',
    targetId: 'seamnex.local',
    targetLabel: 'Wildcard certificate *.seamnex.local',
    outcome: 'success',
    detail: 'ACME renewal succeeded; 89 days remaining.',
    subjectRef: 'sub_sys',
  },
  {
    minutesAgo: 900,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'metadata.verified',
    targetType: 'catalog',
    targetId: 'D03-01',
    targetLabel: 'D03-01 Zammad',
    outcome: 'success',
    detail:
      'Authentication capability and operation inventory re-verified; next review 2027-01-15.',
    subjectRef: 'sub_7a1c',
  },
  {
    minutesAgo: 1320,
    actorType: 'user',
    actorId: 'usr-priya-raman',
    actorName: 'Priya Raman',
    action: 'instance.stop',
    targetType: 'instance',
    targetId: 'inst-shop',
    targetLabel: 'D04-01 WooCommerce',
    outcome: 'success',
    detail: 'Stopped for payment-provider migration; route unpublished, data retained.',
    subjectRef: 'sub_5c02',
  },
  {
    minutesAgo: 2880,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'instance.rollback',
    targetType: 'instance',
    targetId: 'inst-erp',
    targetLabel: 'D06-01 ERPNext',
    outcome: 'success',
    detail: 'Rolled back to 15.41.2 after a failed upgrade; readiness restored in 9 minutes.',
    subjectRef: 'sub_7a1c',
  },
  {
    minutesAgo: 3000,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'entitlement.granted',
    targetType: 'group',
    targetId: 'grp-helpdesk-agents',
    targetLabel: 'helpdesk-agents',
    outcome: 'success',
    detail: 'Added Lena Hoff to the group; product role agent propagates at the next sync cycle.',
    subjectRef: 'sub_7a1c',
  },
  {
    minutesAgo: 4320,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'secret.rotated',
    targetType: 'instance',
    targetId: 'inst-insights',
    targetLabel: 'D11-01 Metabase',
    outcome: 'success',
    detail: 'Database credential rotated; recreate plan applied with no downtime.',
    subjectRef: 'sub_7a1c',
  },
  {
    minutesAgo: 5760,
    actorType: 'user',
    actorId: 'usr-lena-hoff',
    actorName: 'Lena Hoff',
    action: 'auth.login',
    targetType: 'platform',
    targetId: 'portal',
    targetLabel: 'Portal session',
    outcome: 'success',
    detail: 'OIDC code flow with MFA (WebAuthn). No platform password exists.',
    subjectRef: 'sub_88a1',
  },
  {
    minutesAgo: 7200,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'policy.exception.approved',
    targetType: 'instance',
    targetId: 'inst-shop',
    targetLabel: 'D04-01 WooCommerce',
    outcome: 'success',
    detail: `Host bind mount exception PE-104 approved by Priya Raman; expires ${daysAgo(-39).slice(0, 10)}.`,
    subjectRef: 'sub_7a1c',
  },
  {
    minutesAgo: 8640,
    actorType: 'system',
    actorId: 'scheduler',
    actorName: 'Scheduler',
    action: 'metadata.stale',
    targetType: 'catalog',
    targetId: 'D13-01',
    targetLabel: 'D13-01 GLPI',
    outcome: 'success',
    detail: 'Integration metadata older than one quarter; staleness flag returned by the registry.',
    subjectRef: 'sub_sys',
  },
  {
    minutesAgo: 10080,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'user.disabled',
    targetType: 'user',
    targetId: 'usr-mila-novak',
    targetLabel: 'Mila Novak',
    outcome: 'success',
    detail:
      'Disabled in the IdP; 4 product entitlements enumerated and revoked within the sync cycle.',
    subjectRef: 'sub_44c1',
  },
  {
    minutesAgo: 11520,
    actorType: 'user',
    actorId: 'usr-helena-brandt',
    actorName: 'Helena Brandt',
    action: 'access.request.approved',
    targetType: 'group',
    targetId: 'grp-finance-owners',
    targetLabel: 'finance-owners',
    outcome: 'success',
    detail:
      'Request ar-3201 approved with a recorded justification; membership effective at next sync.',
    subjectRef: 'sub_31ff',
  },
  {
    minutesAgo: 14400,
    actorType: 'system',
    actorId: 'scheduler',
    actorName: 'Scheduler',
    action: 'backup.verified',
    targetType: 'instance',
    targetId: 'inst-documents',
    targetLabel: 'D08-01 Paperless-ngx',
    outcome: 'success',
    detail: 'Scratch-stack restore passed; document count matched the manifest.',
    subjectRef: 'sub_sys',
  },
  {
    minutesAgo: 20160,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'catalog.reload',
    targetType: 'catalog',
    targetId: 'D02-01',
    targetLabel: 'D02-01 Mautic',
    outcome: 'success',
    detail: 'Catalog repository reloaded; one scaffold artefact revision applied.',
    subjectRef: 'sub_7a1c',
  },
  {
    minutesAgo: 25920,
    actorType: 'user',
    actorId: 'usr-diego-salas',
    actorName: 'Diego Salas',
    action: 'workflow.activated',
    targetType: 'workflow',
    targetId: 'wf-won-to-project',
    targetLabel: 'Won opportunity → project kickoff',
    outcome: 'success',
    detail: 'Version 4 activated after validation; write targets authorised for domain owner.',
    subjectRef: 'sub_9120',
  },
  {
    minutesAgo: 30240,
    actorType: 'user',
    actorId: 'usr-sofia',
    actorName: 'Sofia Almeida',
    action: 'platform.restore.drill',
    targetType: 'platform',
    targetId: 'rst-118',
    targetLabel: 'Platform-state restore',
    outcome: 'success',
    detail:
      'IdP restored first, control plane second, products third; post-restore admin login verified.',
    subjectRef: 'sub_7a1c',
  },
  {
    minutesAgo: 40320,
    actorType: 'user',
    actorId: 'usr-anja-keller',
    actorName: 'Anja Keller',
    action: 'instance.deploy',
    targetType: 'instance',
    targetId: 'inst-people',
    targetLabel: 'D07-01 OrangeHRM',
    outcome: 'success',
    detail: 'Deployed from the approved scaffold in 28 minutes; no manual shell work.',
    subjectRef: 'sub_2b90',
  },
  {
    minutesAgo: 44640,
    actorType: 'system',
    actorId: 'auth-gateway',
    actorName: 'Forward-auth gateway',
    action: 'forwardauth.denied',
    targetType: 'instance',
    targetId: 'inst-insights',
    targetLabel: 'D11-01 Metabase',
    outcome: 'denied',
    detail: 'Anonymous request to /question/42 refused; no session and no entitlement.',
    subjectRef: 'sub_sys',
  },
];

/** Sequence increases with time, so appended events are always the newest. */
export const AUDIT_EVENTS: AuditEvent[] = [...SEEDS].reverse().map((seed, index) => {
  const seq = index + 1;
  return {
    seq,
    id: `evt-${String(seq).padStart(5, '0')}`,
    ts: at(-seed.minutesAgo),
    actorType: seed.actorType,
    actorId: seed.actorId,
    actorName: seed.actorName,
    action: seed.action,
    targetType: seed.targetType,
    targetId: seed.targetId,
    targetLabel: seed.targetLabel,
    outcome: seed.outcome,
    detail: seed.detail,
    subjectRef: seed.subjectRef,
    prevHash: seq === 1 ? ZERO_HASH : hashFor(seq - 1),
    hash: hashFor(seq),
  };
});

/** Deterministic link hash used by appended events, so `auditProof()` resolves for them too. */
export function auditHashFor(seq: number): string {
  return hashFor(seq);
}

export const AUDIT_ZERO_HASH = ZERO_HASH;

export function auditProof(seq: number): AuditProof {
  return {
    seq,
    hash: hashFor(seq),
    prevHash: seq === 1 ? ZERO_HASH : hashFor(seq - 1),
    algorithm: 'SHA-256 hash chain',
    chainValid: true,
    verifiedAt: at(-8),
    // The daily anchor is the day the chain was last anchored, so it follows the fixture clock.
    anchoredDay: daysAgo(0).slice(0, 10),
    anchorSignature: 'age1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mu',
    path: [
      { seq: 1, hash: hashFor(1) },
      { seq: Math.ceil(seq / 2), hash: hashFor(Math.ceil(seq / 2)) },
      { seq, hash: hashFor(seq) },
    ],
  };
}

/**
 * One anchor per day, the newest today. `storedAt` has always been relative; `day` is derived from
 * the same offset so the anchor list cannot name a date its own timestamp contradicts.
 */
export const AUDIT_ANCHORS = Array.from({ length: 7 }, (_, index) => ({
  day: daysAgo(index).slice(0, 10),
  lastSeq: 26 - index * 3,
  lastHash: hashFor(26 - index * 3),
  storedAt: daysAgo(index),
}));
