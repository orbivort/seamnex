import type { EntrySeed } from './catalog-seed';

/** D08-01–D13-01: documents, delivery work, enabling platforms and ITSM. */
export const ENTRY_SEEDS_B: EntrySeed[] = [
  {
    key: 'D08-01',
    domain: 'Document & Content Management',
    cluster: 'Core Operations',
    product: 'Paperless-ngx',
    description:
      'Scan-and-forget archive with OCR, automatic tagging, full-text search and retention for invoices, contracts and certificates.',
    repoUrl: 'https://github.com/paperless-ngx/paperless-ngx',
    licenseId: 'GPL-3.0',
    stack: 'Python / Postgres',
    guaranteeClass: 'native',
    authMethod: 'OIDC (authorization code + PKCE)',
    packaging: 'compose',
    packagingSource: 'upstream docker-compose.yml @ v2.18.4',
    primaryInstanceId: 'inst-documents',
    sharedWith: [],
    httpPort: 8000,
    resources: { cpu: 1.5, memoryMb: 3072, diskMb: 102_400 },
    dependencies: ['database', 'cache', 'worker'],
    volumes: [
      { name: 'media', mountPath: '/usr/src/paperless/media', quotaMb: 71_680 },
      { name: 'data', mountPath: '/usr/src/paperless/data', quotaMb: 10_240 },
      { name: 'db-data', mountPath: '/var/lib/postgresql/data', quotaMb: 20_480 },
    ],
    operations: [
      {
        id: 'documents.read',
        label: 'Read documents',
        mode: 'read',
        description: 'Document metadata, correspondents and tags.',
      },
      {
        id: 'documents.write',
        label: 'Upload document',
        mode: 'write',
        description: 'Ingest a file and attach metadata before OCR.',
      },
      {
        id: 'tags.write',
        label: 'Apply tags',
        mode: 'write',
        description: 'Tag a consumed document for retention rules.',
      },
    ],
    events: [
      { mode: 'webhook', label: 'document.consumed' },
      { mode: 'poll', label: 'Poll new documents', minimumIntervalMinutes: 10 },
    ],
    credentialGranularity: 'scoped',
    sessionMaxMinutes: 480,
    sloSupported: true,
    owner: { name: 'Lukas Berg', team: 'Records & Compliance' },
    notes:
      'OCR languages DEU and ENG installed. Controlled-document workflows are deferred; this is an archive of record, not an EDMS.',
    deviation: 'E-signature (DocuSeal/Documenso) is not deployed in MVP (Q-3).',
    verifiedDaysAgo: 11,
    reviewDaysFromNow: 80,
  },
  {
    key: 'D09-01',
    domain: 'Project & Work Management',
    cluster: 'Core Operations',
    product: 'OpenProject',
    description:
      'Gantt, baseline and budget reporting alongside agile boards, backlogs and time tracking for delivery teams.',
    repoUrl: 'https://github.com/opf/openproject',
    licenseId: 'GPL-3.0',
    stack: 'Ruby / Postgres',
    // Published as `openproject/openproject`; the derived name would be `openproject` alone, which
    // resolves to docker.io/library and does not exist. Same defect class as D1's explicit ref.
    imageRef: 'openproject/openproject:17.9.6',
    latestVersion: '17.9.6',
    // A gate, not header injection. OpenProject reads no forwarded identity header: the edge
    // requires a platform session and the product then asks for its own password, which is the
    // definition of `fa_gate` (FR-2.16 c). It carried `fa_header` because "SSO is an Enterprise
    // feature" was recorded in the wrong field — `fa_header` is a promise that the user arrives
    // signed in, and no OpenProject deployment on this platform does (ADR-BE-15).
    guaranteeClass: 'fa_gate',
    authMethod:
      'Proxy gate only: the product keeps its own local credential (native OIDC/SAML needs the Enterprise token for `sso_auth_providers`)',
    // The vendored tree is a Compose file pinning the all-in-one image (17.9.6); the entry still
    // said `dockerfile` at 16.4.1, which the console renders as the packaging column and which was
    // two releases behind the image the deployment actually runs. The live catalogue document
    // already reads `compose`; the fixture had drifted, exactly as it had for `httpPort`.
    packaging: 'compose',
    packagingSource:
      'vendored definition (platform/upstream/D09-01) pinning the published all-in-one image @ 17.9.6',
    primaryInstanceId: 'inst-projects',
    sharedWith: [],
    // The container port, not the host side of the canonical `8080:80` example: the compose policy
    // rewrites every published port to `expose:` and the platform never binds a host port, so 8080
    // is never addressed and `render` would refuse the entry with HTTP_PORT_NOT_EXPOSED. The live
    // catalog document already says 80; the fixture had drifted.
    httpPort: 80,
    resources: { cpu: 1, memoryMb: 2048, diskMb: 51_200 },
    dependencies: ['database', 'cache', 'worker'],
    volumes: [
      { name: 'pgdata', mountPath: '/var/openproject/pgdata', quotaMb: 30_720 },
      { name: 'assets', mountPath: '/var/openproject/assets', quotaMb: 20_480 },
    ],
    operations: [
      {
        id: 'work_packages.read',
        label: 'Read work packages',
        mode: 'read',
        description: 'Work package status, assignee and dates.',
      },
      {
        id: 'work_packages.write',
        label: 'Create work package',
        mode: 'write',
        description: 'Create a task or milestone in a project.',
      },
      {
        id: 'time_entries.write',
        label: 'Log time entry',
        mode: 'write',
        description: 'Record hours against a work package.',
      },
    ],
    events: [
      { mode: 'webhook', label: 'work_package.updated' },
      { mode: 'poll', label: 'Poll overdue work packages', minimumIntervalMinutes: 15 },
    ],
    credentialGranularity: 'account',
    sessionMaxMinutes: 120,
    sloSupported: false,
    owner: { name: 'Diego Salas', team: 'Delivery' },
    notes:
      'Free core is genuinely capable. Advanced boards are paid features and are not assumed; the seeded administrator is the only account that exists before the opt-in sign-in relay provisions one per person (ADR-BE-22), and that path is not yet verified end to end.',
    deviation:
      'Native OIDC/SAML is Enterprise-gated (`sso_auth_providers`): measured on 17.9.6 with `OPENPROJECT_EDITION=standard`, the OmniAuth strategy is filtered at boot and no provider can be signed in with, so the free core runs behind the proxy gate. The gate protects the route; it does not sign anyone in. ADR-BE-22 adds an opt-in relay that may sign a person in afterwards, and the class stays `fa_gate` either way. ADR-BE-15 records the flip to native OIDC once a token exists.',
    verifiedDaysAgo: 18,
    reviewDaysFromNow: 73,
  },
  {
    key: 'D10-01',
    domain: 'Collaboration & Communication',
    cluster: 'Enabling Platform',
    product: 'Nextcloud Hub',
    description:
      'Consolidation hub for files, calendar, contacts, chat and Talk meetings with external sharing controls.',
    repoUrl: 'https://github.com/nextcloud/server',
    licenseId: 'AGPL-3.0',
    stack: 'PHP / Postgres',
    guaranteeClass: 'native',
    authMethod: 'OIDC (authorization code + PKCE)',
    packaging: 'compose',
    packagingSource: 'upstream compose.yaml @ 31.0.2',
    primaryInstanceId: 'inst-collab',
    sharedWith: [],
    httpPort: 8080,
    resources: { cpu: 1.5, memoryMb: 3072, diskMb: 102_400 },
    dependencies: ['database', 'cache', 'worker'],
    volumes: [
      { name: 'nextcloud-html', mountPath: '/var/www/html', quotaMb: 20_480 },
      { name: 'nextcloud-data', mountPath: '/var/www/html/data', quotaMb: 71_680 },
      { name: 'db-data', mountPath: '/var/lib/postgresql/data', quotaMb: 10_240 },
    ],
    operations: [
      {
        id: 'files.read',
        label: 'Read files',
        mode: 'read',
        description: 'List folders and download file metadata.',
      },
      {
        id: 'files.write',
        label: 'Upload file',
        mode: 'write',
        description: 'Write a file into a user or group folder.',
      },
      {
        id: 'calendar.write',
        label: 'Create calendar event',
        mode: 'write',
        description: 'Add an event to a shared calendar.',
      },
      {
        id: 'talk.write',
        label: 'Post to Talk conversation',
        mode: 'write',
        description: 'Send a message to a channel or user.',
      },
    ],
    events: [
      { mode: 'webhook', label: 'file.created' },
      { mode: 'poll', label: 'Poll share changes', minimumIntervalMinutes: 10 },
    ],
    credentialGranularity: 'scoped',
    sessionMaxMinutes: 480,
    sloSupported: true,
    owner: { name: 'Sofia Almeida', team: 'IT Operations' },
    notes:
      'Consolidation hub: replacing separate file, chat and meeting tools is the main consolidation win for SMBs.',
    deviation:
      'Jitsi is not deployed as a separate product; Nextcloud Talk covers internal meetings.',
    verifiedDaysAgo: 7,
    reviewDaysFromNow: 84,
  },
  {
    key: 'D11-01',
    domain: 'Data, Reporting & BI',
    cluster: 'Enabling Platform',
    product: 'Metabase',
    description:
      'Visual query builder, dashboards, alerts and subscriptions for non-technical managers.',
    repoUrl: 'https://github.com/metabase/metabase',
    licenseId: 'AGPL-3.0',
    stack: 'JVM / Postgres',
    guaranteeClass: 'fa_gate',
    authMethod: 'Proxy gate only: the product keeps its own credential (SSO is a paid tier)',
    packaging: 'dockerfile',
    packagingSource: 'repository Dockerfile @ v0.57.3',
    primaryInstanceId: 'inst-insights',
    sharedWith: [],
    httpPort: 3000,
    resources: { cpu: 1, memoryMb: 2048, diskMb: 20_480 },
    dependencies: ['database'],
    volumes: [{ name: 'mb-data', mountPath: '/metabase-data', quotaMb: 20_480 }],
    operations: [
      {
        id: 'cards.read',
        label: 'Read cards and dashboards',
        mode: 'read',
        description: 'Saved questions and dashboard definitions.',
      },
      {
        id: 'datasets.read',
        label: 'Read datasets',
        mode: 'read',
        description: 'Query results for reporting extracts.',
      },
    ],
    events: [
      { mode: 'schedule', label: 'Scheduled dashboard subscription', minimumIntervalMinutes: 60 },
    ],
    credentialGranularity: 'none',
    sessionMaxMinutes: 30,
    sloSupported: false,
    owner: { name: 'Noah Fischer', team: 'Business Intelligence' },
    notes:
      'Read-only for workflows: the product cannot issue scoped credentials (C-11), so no write workflow may target it.',
    deviation:
      'SSO, sandboxing and audit logs are paid tiers in the source document; the free edition runs behind forward-auth.',
    verifiedDaysAgo: 25,
    reviewDaysFromNow: 65,
  },
  {
    key: 'D12-01',
    domain: 'Integration, Workflow & Automation',
    cluster: 'Enabling Platform',
    product: 'n8n',
    description:
      'Visual automation engine with branching, retries and a code node, used as the execution layer for platform workflows.',
    repoUrl: 'https://github.com/n8n-io/n8n',
    licenseId: 'Sustainable Use (fair-code)',
    licenseNote:
      'Free for internal business use; resale and hosted-service provision are restricted.',
    stack: 'Node.js / Postgres',
    guaranteeClass: 'fa_header',
    authMethod: 'Forward-auth header injection (community-edition SSO is not assumed)',
    packaging: 'compose',
    packagingSource: 'upstream docker-compose.yml @ 1.114.3 (queue mode)',
    primaryInstanceId: 'inst-automation',
    sharedWith: [],
    httpPort: 5678,
    resources: { cpu: 1, memoryMb: 2048, diskMb: 40_960 },
    dependencies: ['database', 'cache', 'worker'],
    volumes: [
      { name: 'n8n-data', mountPath: '/home/node/.n8n', quotaMb: 20_480 },
      { name: 'db-data', mountPath: '/var/lib/postgresql/data', quotaMb: 20_480 },
    ],
    operations: [
      {
        id: 'workflows.read',
        label: 'Read workflows',
        mode: 'read',
        description: 'Workflow definitions and activation state.',
      },
      {
        id: 'executions.read',
        label: 'Read executions',
        mode: 'read',
        description: 'Execution outcome and per-node data.',
      },
      {
        id: 'workflows.write',
        label: 'Toggle workflow',
        mode: 'write',
        description: 'Activate or pause a compiled workflow.',
      },
    ],
    events: [
      { mode: 'webhook', label: 'workflow.execution_finished' },
      { mode: 'poll', label: 'Poll failed executions', minimumIntervalMinutes: 5 },
    ],
    credentialGranularity: 'scoped',
    sessionMaxMinutes: 120,
    sloSupported: false,
    owner: { name: 'Sofia Almeida', team: 'IT Operations' },
    notes:
      'Execution engine only: workflows are authored in the platform workspace and compiled here. n8n never holds product secrets.',
    deviation:
      'Community-edition SSO is not assumed and is verified at onboarding; forward-auth is the fallback path.',
    verifiedDaysAgo: 5,
    reviewDaysFromNow: 86,
  },
  {
    key: 'D13-01',
    domain: 'IT Infrastructure, Security & ITSM',
    cluster: 'Enabling Platform',
    product: 'GLPI',
    description:
      'Incident, request, change and problem management with asset inventory, SLA tracking and licence records.',
    repoUrl: 'https://github.com/glpi-project/glpi',
    licenseId: 'GPL-3.0',
    stack: 'PHP / MySQL',
    guaranteeClass: 'native',
    authMethod: 'SAML 2.0 (verified)',
    packaging: 'compose',
    packagingSource: 'upstream docker-compose.yml @ 10.0.19',
    primaryInstanceId: 'inst-itsm',
    sharedWith: [],
    httpPort: 80,
    resources: { cpu: 0.5, memoryMb: 2048, diskMb: 20_480 },
    dependencies: ['database'],
    volumes: [
      { name: 'glpi-data', mountPath: '/var/www/html/files', quotaMb: 10_240 },
      { name: 'db-data', mountPath: '/var/lib/mysql', quotaMb: 10_240 },
    ],
    operations: [
      {
        id: 'tickets.read',
        label: 'Read IT tickets',
        mode: 'read',
        description: 'Incidents and requests with SLA state.',
      },
      {
        id: 'tickets.write',
        label: 'Create IT ticket',
        mode: 'write',
        description: 'Raise an incident from a monitoring alert.',
      },
      {
        id: 'assets.read',
        label: 'Read asset inventory',
        mode: 'read',
        description: 'Computers, software and licence assignments.',
      },
    ],
    events: [{ mode: 'poll', label: 'Poll new incidents', minimumIntervalMinutes: 10 }],
    credentialGranularity: 'scoped',
    sessionMaxMinutes: 480,
    sloSupported: true,
    owner: { name: 'Sofia Almeida', team: 'IT Operations' },
    notes:
      'Supplies the ITSM capability the domain nominally covers. Identity, backup and monitoring remain platform-native.',
    deviation:
      'Appendix D specifies a bundle (Proxmox + Keycloak + Restic + Zabbix). Keycloak is platform infrastructure, Proxmox is outside a Docker-on-one-host MVP, and Zabbix is replaced by platform observability.',
    verifiedDaysAgo: 126,
    reviewDaysFromNow: -34,
    stale: true,
  },
];
