import type { CatalogEntry, EnvSchemaVar, ScaffoldDraft } from '@seamnex/domain';
import { ENTRY_SEEDS_A } from './catalog-entries-a';
import { ENTRY_SEEDS_B } from './catalog-entries-b';
import { buildEntry } from './catalog-seed';
import { at } from './context';
import { envSchemaFor } from './env-schema';

export const CATALOG_ENTRIES: CatalogEntry[] = [...ENTRY_SEEDS_A, ...ENTRY_SEEDS_B].map(buildEntry);

export const CATALOG_BY_KEY: Record<string, CatalogEntry> = Object.fromEntries(
  CATALOG_ENTRIES.map((entry) => [entry.key, entry]),
);

export const ENV_SCHEMAS: Record<string, EnvSchemaVar[]> = Object.fromEntries(
  CATALOG_ENTRIES.map((entry) => [entry.key, envSchemaFor(entry)]),
);

export const SCAFFOLD_DRAFTS: Record<string, ScaffoldDraft> = {
  'D02-01': {
    entryKey: 'D02-01',
    draftId: 'draft-d2-20260918',
    createdAt: at(-34 * 24 * 60),
    approvedBy: 'Sofia Almeida',
    files: [
      {
        path: 'catalog/D02-01/compose.yaml',
        language: 'yaml',
        content: [
          'name: seamnex-inst-mautic',
          'services:',
          '  web:',
          '    image: mautic/mautic:6.0.2@sha256:9c1f4a7e2b',
          '    expose: ["8080"]',
          '    environment:',
          '      MAUTIC_DB_HOST: db',
          '      MAUTIC_DB_PASSWORD: ${DB_PASSWORD}',
          '      MAUTIC_TRUSTED_PROXIES: ["172.20.0.0/16"]',
          '    volumes: [app-data:/var/www/html/data]',
          '    healthcheck:',
          '      test: ["CMD", "curl", "-fsS", "http://localhost:8080/login"]',
          '      interval: 30s',
          '  db:',
          '    image: mariadb:11.8@sha256:4bd2ee81da',
          '    expose: ["3306"]',
          '    volumes: [db-data:/var/lib/mysql]',
          'volumes: { app-data: {}, db-data: {} }',
        ].join('\n'),
      },
      {
        path: 'catalog/D02-01/.env.example',
        language: 'dotenv',
        content: [
          'ADMIN_EMAIL=portal-admin@seamnex.local',
          'SMTP_HOST=smtp.seamnex.local',
          'SMTP_PORT=587',
          'TZ=Europe/Berlin',
        ].join('\n'),
      },
    ],
    diagnostics: [
      {
        id: 'port',
        label: 'HTTP port exposed',
        state: 'pass',
        detail: 'Service `web` exposes 8080; no published ports.',
        remediation: null,
      },
      {
        id: 'volume',
        label: 'Persistent volumes declared',
        state: 'pass',
        detail: 'app-data and db-data declared with quotas.',
        remediation: null,
      },
      {
        id: 'health',
        label: 'Health check present',
        state: 'pass',
        detail: 'HTTP health check on /login every 30 s.',
        remediation: null,
      },
      {
        id: 'restart',
        label: 'Restart policy set',
        state: 'pass',
        detail: 'Inherited `unless-stopped` from the platform override.',
        remediation: null,
      },
      {
        id: 'digest',
        label: 'Images pinned by digest',
        state: 'pass',
        detail: 'Both images resolve to an immutable digest.',
        remediation: null,
      },
      {
        id: 'proxy',
        label: 'Proxy headers accepted',
        state: 'warn',
        detail: 'MAUTIC_TRUSTED_PROXIES must include the edge network.',
        remediation:
          'Confirm 172.20.0.0/16 matches the seamnex-control network range before deployment.',
      },
    ],
  },
  'D07-01': {
    entryKey: 'D07-01',
    draftId: 'draft-d7-20260930',
    createdAt: at(-22 * 24 * 60),
    approvedBy: 'Sofia Almeida',
    files: [
      {
        path: 'catalog/D07-01/compose.yaml',
        language: 'yaml',
        content: [
          'name: seamnex-inst-people',
          'services:',
          '  web:',
          '    image: orangehrm/orangehrm:5.8@sha256:7d0c33ba91',
          '    expose: ["80"]',
          '    environment:',
          '      ORANGEHRM_DB_HOST: db',
          '      ORANGEHRM_DB_PASSWORD: ${DB_PASSWORD}',
          '    volumes: [app-data:/var/www/html/lib/conftmp]',
          '    healthcheck:',
          '      test: ["CMD", "curl", "-fsS", "http://localhost/"]',
          '      interval: 30s',
          '  db:',
          '    image: mysql:8.4@sha256:11ab7f4c02',
          '    expose: ["3306"]',
          '    volumes: [db-data:/var/lib/mysql]',
          'volumes: { app-data: {}, db-data: {} }',
        ].join('\n'),
      },
    ],
    diagnostics: [
      {
        id: 'port',
        label: 'HTTP port exposed',
        state: 'pass',
        detail: 'Service `web` exposes 80.',
        remediation: null,
      },
      {
        id: 'volume',
        label: 'Persistent volumes declared',
        state: 'pass',
        detail: 'app-data and db-data declared.',
        remediation: null,
      },
      {
        id: 'health',
        label: 'Health check present',
        state: 'warn',
        detail:
          'Health check hits the login page, which returns 302 when the session cookie is set.',
        remediation: 'Accept 200 or 302 in the readiness assertion.',
      },
      {
        id: 'restart',
        label: 'Restart policy set',
        state: 'pass',
        detail: 'Inherited from the platform override.',
        remediation: null,
      },
      {
        id: 'digest',
        label: 'Images pinned by digest',
        state: 'pass',
        detail: 'Both images pinned.',
        remediation: null,
      },
    ],
  },
};
