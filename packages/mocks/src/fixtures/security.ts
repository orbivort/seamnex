import type { ImageScanReport, TrustedRegistryState } from '@seamnex/domain';
import { at, daysAgo, hoursAgo } from './context';

/**
 * NFR-4.16 — the allow-list the pull and build paths enforce.
 *
 * The entries are the namespaces the deployed fixtures actually come from, which is what makes the
 * screen checkable against the instance list: every `imageRef` in `instances-base.ts` resolves to one
 * of these, and a namespace that is removed here must visibly cost a product its next deploy.
 *
 * Version 4 exists so the screen has a history to show. A list with only "today" tells an operator
 * nothing about whether the control is maintained or was written once and forgotten.
 */
export const TRUSTED_REGISTRIES: TrustedRegistryState = {
  current: {
    version: 4,
    contentHash: 'sha256:91c4d8a7f0e2b6d35c8a1470e9b2d6f4a0c3e8b1d5f7924a6c0e3b8d1f4a7c25',
    entries: [
      'docker.io/aquasec',
      'docker.io/espocrm',
      'docker.io/frappe',
      'docker.io/library',
      'docker.io/mautic',
      'docker.io/metabase',
      'docker.io/openproject',
      'docker.io/orangehrm',
      'ghcr.io/seamnex',
    ],
    note: 'Added the Mautic and Metabase namespaces for the D02-01 and D11-01 catalogue entries.',
    createdBy: 'usr-sofia',
    createdAt: hoursAgo(26),
  },
  history: [
    {
      version: 4,
      createdAt: hoursAgo(26),
      createdBy: 'usr-sofia',
      note: 'Added the Mautic and Metabase namespaces for the D02-01 and D11-01 catalogue entries.',
      entryCount: 9,
    },
    {
      version: 3,
      createdAt: daysAgo(12),
      createdBy: 'usr-sofia',
      note: 'Removed docker.io/bitnami after the image was republished under a paid namespace.',
      entryCount: 7,
    },
    {
      version: 2,
      createdAt: daysAgo(41),
      createdBy: 'usr-sofia',
      note: 'Added the platform registry ghcr.io/seamnex for our own wrapper images.',
      entryCount: 8,
    },
    {
      version: 1,
      createdAt: daysAgo(96),
      createdBy: 'system',
      note: 'Shipped default from packages/db/src/seed/trusted-registries.json (NFR-4.16).',
      entryCount: 7,
    },
  ],
};

/**
 * NFR-4.6 / S-10 — the retained scans, one per instance and digest.
 *
 * Three states are represented on purpose, because the screen's job is to tell them apart:
 * `passed` (…marketing), `blocked` with findings (…collab), and `error` — the scanner could not
 * finish, which is *not* a pass. The deployments with no row at all are the fourth state: never
 * scanned, rendered as such rather than as healthy.
 */
export const IMAGE_SCANS: ImageScanReport[] = [
  {
    instanceId: 'inst-collab',
    imageRef: 'nextcloud:31.0.2-apache',
    imageDigest: 'sha256:6b21f4a9c7e038d5b1a9046f2e83c7d15a0b96e4f3c28d710a5b9e2c64f0d8a3',
    verdict: 'blocked',
    scanner: 'trivy',
    scannerVersion: '0.57.1',
    scannedAt: hoursAgo(9),
    severityCounts: { critical: 2, high: 7, medium: 24, low: 41, unknown: 0 },
    blockingSeverities: ['critical'],
    findings: [
      {
        id: 'CVE-2026-31884',
        package: 'libxml2',
        installedVersion: '2.12.7-r1',
        fixedVersion: '2.12.9-r0',
        severity: 'critical',
        title: 'Use-after-free in xmlParseChunk allows remote code execution',
        url: 'https://osv.dev/vulnerability/CVE-2026-31884',
      },
      {
        id: 'CVE-2026-30112',
        package: 'php83-openssl',
        installedVersion: '3.3.2-r0',
        fixedVersion: null,
        severity: 'critical',
        title: 'Certificate verification bypass on renegotiation',
        url: 'https://osv.dev/vulnerability/CVE-2026-30112',
      },
      {
        id: 'CVE-2026-28455',
        package: 'nginx-mod-http-dav-ext',
        installedVersion: '1.0.3-r2',
        fixedVersion: '1.0.4-r0',
        severity: 'high',
        title: 'Path traversal in the WebDAV extension',
        url: 'https://osv.dev/vulnerability/CVE-2026-28455',
      },
    ],
    reportKey: 'scans/inst-collab/sha256-6b21f4a9.json',
  },
  {
    instanceId: 'inst-marketing',
    imageRef: 'mautic/mautic:7.2.2-apache',
    imageDigest: 'sha256:9c1f4a7e2b6d8035af17c4e9d02b8a63f5e1c7409d2ab38e6f01c5b7a4d9821',
    verdict: 'passed',
    scanner: 'trivy',
    scannerVersion: '0.57.1',
    scannedAt: hoursAgo(9),
    severityCounts: { critical: 0, high: 1, medium: 9, low: 22, unknown: 0 },
    blockingSeverities: ['critical'],
    findings: [
      {
        id: 'GHSA-7c2m-x9fp-3h4q',
        package: 'composer/composer',
        installedVersion: '2.7.6',
        fixedVersion: '2.8.1',
        severity: 'high',
        title: 'Archive extraction writes outside the target directory',
        url: 'https://osv.dev/vulnerability/GHSA-7c2m-x9fp-3h4q',
      },
    ],
    reportKey: 'scans/inst-marketing/sha256-9c1f4a7e.json',
  },
  {
    instanceId: 'inst-erp',
    imageRef: 'frappe/erpnext:v16.53.0',
    imageDigest: 'sha256:3e5ba1d7c904f28a6b0e13d47c9f52a8e0b6d1f4c73a928e5d0b1c6a7f3e204d',
    verdict: 'error',
    scanner: 'trivy',
    scannerVersion: '0.57.1',
    scannedAt: hoursAgo(20),
    severityCounts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    blockingSeverities: ['critical'],
    findings: [],
    reportKey: null,
  },
  {
    instanceId: 'inst-documents',
    imageRef: 'ghcr.io/seamnex/paperless-ngx:2.15.1',
    imageDigest: 'sha256:1c7a04e9b25d83f6a0e1c47d92b38f50c6a1d7e4b92f038c6d51e8a04b7c3a91',
    verdict: 'passed',
    scanner: 'trivy',
    scannerVersion: '0.57.1',
    scannedAt: daysAgo(3),
    severityCounts: { critical: 0, high: 0, medium: 4, low: 18, unknown: 0 },
    blockingSeverities: ['critical'],
    findings: [],
    reportKey: 'scans/inst-documents/sha256-1c7a04e9.json',
  },
  {
    instanceId: 'inst-shop',
    imageRef: 'ghcr.io/seamnex/shopware:6.7.1',
    imageDigest: 'sha256:8d0f5b2a64c31e97d5a0b8f4c1e6d29a73b5c8e0f4d1a6b9c2e7f3a0d5b8146c',
    verdict: 'passed',
    scanner: 'trivy',
    scannerVersion: '0.57.1',
    scannedAt: at(-52),
    severityCounts: { critical: 0, high: 2, medium: 11, low: 27, unknown: 0 },
    blockingSeverities: ['critical'],
    findings: [],
    reportKey: 'scans/inst-shop/sha256-8d0f5b2a.json',
  },
];
