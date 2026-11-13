import type { Backup, RestoreDrill, RestoreRun } from '@seamnex/domain';
import { at, daysAgo, hoursAgo } from './context';
import { INSTANCES } from './instances';

const GB = 1024 ** 3;

function includesFor(product: string, entryKey: string): string[] {
  return [
    `database dump — ${entryKey === 'D06-01' ? 'MariaDB' : 'PostgreSQL'} transactional snapshot`,
    `volumes — ${product} application data`,
    'render set and environment manifest',
  ];
}

export const BACKUPS: Backup[] = [
  ...INSTANCES.flatMap((instance, index) => {
    const latestHours = index % 3 === 0 ? 3 : 5;
    const size = (1.1 + index * 0.35) * GB;
    return [
      {
        id: `bkp-${instance.slug}-latest`,
        kind: 'instance' as const,
        instanceId: instance.id,
        instanceLabel: `${instance.entryKey} ${instance.product}`,
        state: 'succeeded' as const,
        startedAt: hoursAgo(latestHours),
        finishedAt: hoursAgo(latestHours - 0.4),
        sizeBytes: Math.round(size),
        objectKey: `s3://seamnex-backups/${instance.slug}/${instance.currentVersion}/latest.tar.zst.age`,
        includes: includesFor(instance.product, instance.entryKey),
        verifiedAt: instance.backup.verified ? daysAgo((index % 20) + 2) : null,
        verifyMethod: instance.backup.verified ? 'scratch-stack smoke test' : null,
        renderSetId: `rs-${instance.slug}-${instance.currentVersion.replace(/\./g, '')}`,
      },
      {
        id: `bkp-${instance.slug}-previous`,
        kind: 'instance' as const,
        instanceId: instance.id,
        instanceLabel: `${instance.entryKey} ${instance.product}`,
        state: 'succeeded' as const,
        startedAt: at(-(24 * 60 + latestHours * 60)),
        finishedAt: at(-(24 * 60 + latestHours * 60 - 25)),
        sizeBytes: Math.round(size * 0.94),
        objectKey: `s3://seamnex-backups/${instance.slug}/${instance.currentVersion}/previous.tar.zst.age`,
        includes: includesFor(instance.product, instance.entryKey),
        verifiedAt: null,
        verifyMethod: null,
        renderSetId: `rs-${instance.slug}-${instance.currentVersion.replace(/\./g, '')}`,
      },
    ];
  }),
  {
    id: 'bkp-platform-1022',
    kind: 'platform',
    instanceId: null,
    instanceLabel: 'Platform state (including IdP realm)',
    state: 'succeeded',
    startedAt: hoursAgo(6),
    finishedAt: hoursAgo(5.7),
    sizeBytes: Math.round(2.2 * GB),
    objectKey: 's3://seamnex-backups/platform/2026/10/22/platform-state.tar.zst.age',
    includes: [
      'entitlements and group mappings',
      'audit log and anchors',
      'job history',
      'workflow definitions',
      'secret-store root keys (escrowed separately)',
      'TLS material',
      'identity provider realm, database and configuration',
    ],
    verifiedAt: daysAgo(9),
    verifyMethod: 'platform restore drill with post-restore login',
    renderSetId: 'rs-platform-183',
  },
  {
    id: 'bkp-platform-1021',
    kind: 'platform',
    instanceId: null,
    instanceLabel: 'Platform state (including IdP realm)',
    state: 'succeeded',
    startedAt: at(-30 * 60),
    finishedAt: at(-30 * 60 + 20),
    sizeBytes: Math.round(2.1 * GB),
    objectKey: 's3://seamnex-backups/platform/2026/10/21/platform-state.tar.zst.age',
    includes: [
      'entitlements and group mappings',
      'audit log and anchors',
      'job history',
      'workflow definitions',
      'identity provider realm, database and configuration',
    ],
    verifiedAt: null,
    verifyMethod: null,
    renderSetId: 'rs-platform-182',
  },
];

export const RESTORE_RUNS: RestoreRun[] = [
  {
    id: 'rst-118',
    backupId: 'bkp-platform-1022',
    kind: 'platform',
    phase: 'complete',
    state: 'succeeded',
    startedAt: daysAgo(9),
    finishedAt: at(-9 * 24 * 60 + 44),
    loginVerifiedAt: at(-9 * 24 * 60 + 26),
    concurrency: 4,
    failedReason: null,
  },
  {
    id: 'rst-119',
    backupId: 'bkp-documents-latest',
    kind: 'instance',
    phase: 'complete',
    state: 'succeeded',
    startedAt: daysAgo(16),
    finishedAt: at(-16 * 24 * 60 + 34),
    loginVerifiedAt: null,
    concurrency: 4,
    failedReason: null,
  },
  {
    id: 'rst-120',
    backupId: 'bkp-projects-latest',
    kind: 'instance',
    phase: 'products',
    state: 'failed',
    startedAt: daysAgo(97),
    finishedAt: at(-97 * 24 * 60 + 12),
    loginVerifiedAt: null,
    concurrency: 4,
    failedReason:
      'Smoke test failed: work-package count 0 after restore; backup excluded the attachments volume.',
  },
];

export const RESTORE_DRILLS: RestoreDrill[] = INSTANCES.filter((_, index) => index !== 7).map(
  (instance, index) => ({
    id: `drill-${instance.slug}`,
    instanceId: instance.id,
    instanceLabel: `${instance.entryKey} ${instance.product}`,
    performedAt: daysAgo(8 + index * 9),
    smokeTest:
      instance.entryKey === 'D08-01'
        ? 'Document count matches the manifest (±0)'
        : instance.entryKey === 'D03-01'
          ? 'Ticket count and SLA clock state match'
          : 'Admin login and record count within tolerance',
    passed: instance.id !== 'inst-people',
    evidenceUrl: `https://evidence.seamnex.local/restore-drills/${instance.slug}`,
  }),
);
