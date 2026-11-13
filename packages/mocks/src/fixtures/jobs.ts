import type { Job, JobKind, JobStep, JobStepState } from '@seamnex/domain';
import { at } from './context';

type StepSeed = { name: string; message: string };

type JobSeed = {
  id: string;
  kind: JobKind;
  instanceId: string | null;
  entryKey: string | null;
  label: string;
  state: Job['state'];
  minutesAgo: number;
  durationMinutes: number;
  requestedBy: string;
  summary: string;
  error?: { code: string; message: string };
  steps: StepSeed[];
};

const DEPLOY_STEPS: StepSeed[] = [
  { name: 'Pre-flight validation', message: 'Catalog entry, parameters and capacity resolved.' },
  { name: 'Resolve source', message: 'Deployment source resolved and policy-checked.' },
  { name: 'Render definition', message: 'Compose project, override and env file rendered.' },
  { name: 'Create network and volumes', message: 'Isolated network and volume set created.' },
  { name: 'Start services', message: 'All required services started with pinned digests.' },
  {
    name: 'Register integration',
    message: 'IdP client, route, backup, logging and trigger registered.',
  },
  { name: 'Verify readiness', message: 'HTTP readiness and SSO test login passed.' },
];

const LIFECYCLE_STEPS: StepSeed[] = [
  {
    name: 'Pre-flight validation',
    message: 'Requested transition is allowed from the current state.',
  },
  { name: 'Snapshot render set', message: 'Current render set recorded for rollback.' },
  { name: 'Apply change', message: 'Docker resources updated through the socket proxy.' },
  { name: 'Verify readiness', message: 'Readiness probe and health check passed.' },
];

const BACKUP_STEPS: StepSeed[] = [
  { name: 'Quiesce database', message: 'Transactional snapshot started.' },
  { name: 'Dump database', message: 'Engine-native dump completed.' },
  { name: 'Capture volumes', message: 'Volume archive created and compressed.' },
  {
    name: 'Encrypt and upload',
    message: 'Artifact encrypted with age and uploaded to the off-host target.',
  },
  { name: 'Register verification', message: 'Manifest recorded; restore verification queued.' },
];

const JOB_SEEDS: JobSeed[] = [
  {
    id: 'job-1041',
    kind: 'deploy',
    instanceId: 'inst-helpdesk',
    entryKey: 'D03-01',
    label: 'Deploy D03-01 Zammad',
    state: 'succeeded',
    minutesAgo: 6_840,
    durationMinutes: 22,
    requestedBy: 'Sofia Almeida',
    summary: 'Zammad deployed from the upstream Compose file in 22 minutes.',
    steps: DEPLOY_STEPS,
  },
  {
    id: 'job-1042',
    kind: 'upgrade',
    instanceId: 'inst-erp',
    entryKey: 'D06-01',
    label: 'Upgrade D06-01 ERPNext to 15.42.0',
    state: 'failed',
    minutesAgo: 2_880,
    durationMinutes: 17,
    requestedBy: 'Sofia Almeida',
    summary:
      'Upgrade aborted: readiness failed after the new image started; one-step rollback offered.',
    error: {
      code: 'HEALTHCHECK_FAILED',
      message: 'HTTP readiness did not pass within 300 s after upgrade.',
    },
    steps: [
      { name: 'Pre-upgrade backup', message: 'Backup set bkp-erp-0918 created and verified.' },
      { name: 'Pull new digest', message: 'New image digest resolved and pulled.' },
      { name: 'Stop services', message: 'Services stopped in dependency order.' },
      { name: 'Start 15.42.0', message: 'New version started; readiness probe pending.' },
      { name: 'Verify readiness', message: 'Readiness failed after 300 s.' },
    ],
  },
  {
    id: 'job-1043',
    kind: 'rollback',
    instanceId: 'inst-erp',
    entryKey: 'D06-01',
    label: 'Roll back D06-01 ERPNext to 15.41.2',
    state: 'succeeded',
    minutesAgo: 2_840,
    durationMinutes: 9,
    requestedBy: 'Sofia Almeida',
    summary: 'Rolled back to the previously running version; ERPNext is ready.',
    steps: LIFECYCLE_STEPS,
  },
  {
    id: 'job-1044',
    kind: 'deploy',
    instanceId: 'inst-people',
    entryKey: 'D07-01',
    label: 'Deploy D07-01 OrangeHRM',
    state: 'succeeded',
    minutesAgo: 102_240,
    durationMinutes: 28,
    requestedBy: 'Sofia Almeida',
    summary: 'Scaffolded deployment confirmed and started in 28 minutes.',
    steps: DEPLOY_STEPS,
  },
  {
    id: 'job-1045',
    kind: 'backup',
    instanceId: 'inst-collab',
    entryKey: 'D10-01',
    label: 'Backup D10-01 Nextcloud Hub',
    state: 'succeeded',
    minutesAgo: 240,
    durationMinutes: 12,
    requestedBy: 'scheduler',
    summary: 'Database-consistent dump plus volume capture; 8.4 GB uploaded.',
    steps: BACKUP_STEPS,
  },
  {
    id: 'job-1046',
    kind: 'backup',
    instanceId: 'inst-erp',
    entryKey: 'D06-01',
    label: 'Backup D06-01 ERPNext',
    state: 'succeeded',
    minutesAgo: 180,
    durationMinutes: 26,
    requestedBy: 'scheduler',
    summary: 'Database-consistent dump plus volume capture; 14.1 GB uploaded.',
    steps: BACKUP_STEPS,
  },
  {
    id: 'job-1047',
    kind: 'deploy',
    instanceId: 'inst-itsm',
    entryKey: 'D13-01',
    label: 'Deploy D13-01 GLPI',
    state: 'succeeded',
    minutesAgo: 83_520,
    durationMinutes: 19,
    requestedBy: 'Sofia Almeida',
    summary: 'GLPI deployed from the upstream Compose file; SAML verified.',
    steps: DEPLOY_STEPS,
  },
  {
    id: 'job-1048',
    kind: 'upgrade',
    instanceId: 'inst-insights',
    entryKey: 'D11-01',
    label: 'Upgrade D11-01 Metabase to 0.57.3',
    state: 'succeeded',
    minutesAgo: 12_960,
    durationMinutes: 11,
    requestedBy: 'Sofia Almeida',
    summary: 'Upgrade completed after a verified pre-upgrade backup.',
    steps: LIFECYCLE_STEPS,
  },
  {
    id: 'job-1049',
    kind: 'deploy',
    instanceId: 'inst-automation',
    entryKey: 'D12-01',
    label: 'Deploy D12-01 n8n',
    state: 'succeeded',
    minutesAgo: 87_840,
    durationMinutes: 24,
    requestedBy: 'Sofia Almeida',
    summary: 'Queue-mode n8n deployed with two workers.',
    steps: DEPLOY_STEPS,
  },
  {
    id: 'job-1050',
    kind: 'stop',
    instanceId: 'inst-shop',
    entryKey: 'D04-01',
    label: 'Stop D04-01 WooCommerce',
    state: 'succeeded',
    minutesAgo: 3_120,
    durationMinutes: 2,
    requestedBy: 'Sofia Almeida',
    summary: 'Stopped for the payment-provider migration; route unpublished.',
    steps: LIFECYCLE_STEPS,
  },
  {
    id: 'job-1051',
    kind: 'upgrade',
    instanceId: 'inst-crm',
    entryKey: 'D01-01',
    label: 'Upgrade D01-01 EspoCRM to 10.0.11',
    state: 'failed',
    minutesAgo: 95,
    durationMinutes: 4,
    requestedBy: 'Mara Vogel',
    summary: 'Blocked by pre-flight: the requested version is not pinned in the catalog revision.',
    error: {
      code: 'UNPINNED_IMAGE',
      message: 'Catalog revision 9c2f1ab pins 9.2.4; 10.0.11 has no digest on record.',
    },
    steps: [
      { name: 'Pre-flight validation', message: 'Image reference 10.0.11 has no pinned digest.' },
      { name: 'Resolve plan', message: 'Plan refused before any container was touched.' },
    ],
  },
  {
    id: 'job-1052',
    kind: 'restore',
    instanceId: 'inst-documents',
    entryKey: 'D08-01',
    label: 'Restore drill D08-01 Paperless-ngx',
    state: 'succeeded',
    minutesAgo: 23_040,
    durationMinutes: 34,
    requestedBy: 'Sofia Almeida',
    summary: 'Scratch-stack restore passed with the document-count smoke test.',
    steps: BACKUP_STEPS,
  },
  {
    id: 'job-1053',
    kind: 'deploy',
    instanceId: 'inst-marketing',
    entryKey: 'D02-01',
    label: 'Deploy D02-01 Mautic',
    state: 'succeeded',
    minutesAgo: 138_240,
    durationMinutes: 31,
    requestedBy: 'Sofia Almeida',
    summary: 'Scaffolded deployment; forward-auth header verified.',
    steps: DEPLOY_STEPS,
  },
  {
    id: 'job-1054',
    kind: 'upgrade',
    instanceId: 'inst-people',
    entryKey: 'D07-01',
    label: 'Upgrade D07-01 OrangeHRM to 5.8.1',
    state: 'failed',
    minutesAgo: 44,
    durationMinutes: 6,
    requestedBy: 'Anja Keller',
    summary: 'Upgrade left the application unhealthy; readiness has failed since.',
    error: {
      code: 'HEALTHCHECK_FAILED',
      message: 'HTTP 503 from /symfony/web/index.php/auth/login.',
    },
    steps: [
      { name: 'Pre-upgrade backup', message: 'Backup set bkp-people-1022 created.' },
      { name: 'Pull new digest', message: 'Image digest resolved.' },
      { name: 'Recreate services', message: 'Services recreated with the new image.' },
      { name: 'Verify readiness', message: 'Readiness failed: HTTP 503.' },
    ],
  },
  {
    id: 'job-1055',
    kind: 'backup',
    instanceId: null,
    entryKey: null,
    label: 'Platform-state backup',
    state: 'succeeded',
    minutesAgo: 360,
    durationMinutes: 18,
    requestedBy: 'scheduler',
    summary: 'Platform state including the identity-provider realm and database; 2.2 GB uploaded.',
    steps: BACKUP_STEPS,
  },
  {
    id: 'job-1056',
    kind: 'scaffold',
    instanceId: null,
    entryKey: 'D02-01',
    label: 'Scaffold source for D02-01 Mautic',
    state: 'succeeded',
    minutesAgo: 48_960,
    durationMinutes: 8,
    requestedBy: 'Sofia Almeida',
    summary: 'Draft artefacts committed to the catalog repository; entry became deployable.',
    steps: [
      { name: 'Analyse repository', message: 'No Compose file or Dockerfile found.' },
      { name: 'Generate artefacts', message: 'Compose, env template and health check generated.' },
      { name: 'Policy check', message: 'No published ports, no host mounts, digests pinned.' },
      { name: 'Commit draft', message: 'Committed as catalog/D02-01 with review approval.' },
    ],
  },
  {
    id: 'job-1057',
    kind: 'deploy',
    instanceId: 'inst-projects',
    entryKey: 'D09-01',
    label: 'Deploy D09-01 OpenProject',
    state: 'succeeded',
    minutesAgo: 149_760,
    durationMinutes: 26,
    requestedBy: 'Sofia Almeida',
    summary: 'Built from the repository Dockerfile; image archived for rollback.',
    steps: DEPLOY_STEPS,
  },
  {
    id: 'job-1058',
    kind: 'restart',
    instanceId: 'inst-documents',
    entryKey: 'D08-01',
    label: 'Apply environment values to D08-01 Paperless-ngx',
    state: 'running',
    minutesAgo: 2,
    durationMinutes: 4,
    requestedBy: 'Sofia Almeida',
    summary: 'Recreate required: OCR language and admin variables changed.',
    steps: [
      { name: 'Validate values', message: 'Override ceilings respected; secrets resolved.' },
      { name: 'Render diff', message: 'Two variables changed; recreate required.' },
      { name: 'Recreate services', message: 'Recreating the web and worker services.' },
      { name: 'Verify readiness', message: 'Waiting for HTTP readiness.' },
    ],
  },
];

function stepState(jobState: Job['state'], index: number, total: number): JobStepState {
  if (jobState === 'succeeded') return 'succeeded';
  if (jobState === 'failed') {
    if (index < total - 1) return 'succeeded';
    return 'failed';
  }
  if (jobState === 'running') {
    if (index < total - 2) return 'succeeded';
    if (index === total - 2) return 'running';
    return 'pending';
  }
  if (jobState === 'cancelled') return index === 0 ? 'skipped' : 'skipped';
  return 'pending';
}

function buildSteps(seed: JobSeed, startedMs: number): JobStep[] {
  const span = Math.max(seed.durationMinutes, seed.steps.length) * 60_000;
  const slice = span / seed.steps.length;
  return seed.steps.map((step, index) => {
    const state = stepState(seed.state, index, seed.steps.length);
    const stepStart = startedMs + index * slice;
    const done = state === 'succeeded' || state === 'failed';
    return {
      seq: index + 1,
      name: step.name,
      state,
      startedAt:
        state === 'pending' ? null : new Date(stepStart).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      finishedAt: done
        ? new Date(stepStart + slice * 0.8).toISOString().replace(/\.\d{3}Z$/, 'Z')
        : null,
      message: state === 'pending' ? null : step.message,
    };
  });
}

export const JOBS: Job[] = JOB_SEEDS.map((seed) => {
  const startedMs = Date.parse(at(-seed.minutesAgo));
  const steps = buildSteps(seed, startedMs);
  const finished =
    seed.state === 'succeeded' || seed.state === 'failed' || seed.state === 'cancelled'
      ? at(-seed.minutesAgo + seed.durationMinutes)
      : null;
  return {
    id: seed.id,
    kind: seed.kind,
    instanceId: seed.instanceId,
    entryKey: seed.entryKey,
    label: seed.label,
    state: seed.state,
    progress:
      seed.state === 'succeeded' || seed.state === 'failed'
        ? 100
        : seed.state === 'running'
          ? 62
          : seed.state === 'queued'
            ? 0
            : 30,
    createdAt: at(-seed.minutesAgo),
    startedAt: seed.state === 'queued' ? null : at(-seed.minutesAgo),
    finishedAt: finished,
    requestedBy: seed.requestedBy,
    summary: seed.summary,
    errorCode: seed.error?.code ?? null,
    errorMessage: seed.error?.message ?? null,
    steps,
  };
});
