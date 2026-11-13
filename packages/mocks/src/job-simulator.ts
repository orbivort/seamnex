import type { Job, JobKind, JobLogLine } from '@seamnex/domain';
import { at } from './fixtures/context';
import { getState, refreshCapacity } from './store';
import { schedule } from './timers';

const TICK_MS = 900;

const LOG_TEMPLATES: Record<JobKind, string[]> = {
  deploy: [
    'resolving deployment source and policy verdict',
    'pulling image layers (digest pinned)',
    'creating isolated network and volumes',
    'starting service web with expose only',
    'registering IdP client, route and backup job',
  ],
  reconfigure: [
    're-rendering the definition with the current environment',
    'reconciling the identity client and route',
    'recreating changed services',
    'readiness probe passed',
  ],
  build: [
    'resolving Dockerfile at the recorded revision',
    'building image layers (cache hit on 4 of 6)',
    'tagging immutably and recording the digest',
    'retaining the previous image for rollback',
  ],
  start: ['starting service db', 'starting service web', 'readiness probe passed'],
  stop: ['stopping service web', 'route unpublished', 'volumes retained'],
  restart: ['recreating service web', 'readiness probe passed'],
  upgrade: [
    'pre-upgrade backup created',
    'pulling new image digest',
    'recreating services',
    'readiness probe GET / -> 503',
  ],
  rollback: ['restoring previous render set', 'starting previous image', 'readiness probe passed'],
  delete: ['exporting data', 'removing containers and network', 'slug reserved for 30 days'],
  backup: [
    'quiescing database',
    'dumping database',
    'archiving volumes',
    'uploading encrypted artefact',
  ],
  restore: [
    'preparing scratch stack',
    'restoring database',
    'extracting volumes',
    'running smoke test',
  ],
  export: ['building portable archive', 'writing manifest'],
  prepull: ['pre-pulling image layers', 'layers cached'],
  scaffold: ['generating compose artefacts', 'validating compose policy', 'committing draft'],
  verify: ['restoring into a scratch stack', 'running the smoke test', 'recording evidence'],
  dsar: ['locating the subject references', 'exporting the personal data', 'recording evidence'],
  'platform-backup': [
    'dumping platform state',
    'exporting the identity-provider realm',
    'uploading encrypted artefact',
  ],
  'platform-restore': [
    'restoring identity provider',
    'restoring control plane',
    'holding the gate for login verification',
  ],
  synthetic: ['resolving the check', 'certifying the target'],
};

function pushLog(job: Job, line: string, stream: JobLogLine['stream'] = 'stdout'): void {
  const logs = getState().jobLogs[job.id] ?? [];
  logs.push({ seq: logs.length, ts: at(0), stream, line });
  getState().jobLogs[job.id] = logs;
}

function finishJob(job: Job, failed: boolean): void {
  const state = getState();
  job.state = failed ? 'failed' : 'succeeded';
  job.progress = 100;
  job.finishedAt = at(0);
  job.steps = job.steps.map((step) =>
    step.state === 'pending'
      ? { ...step, state: failed ? 'skipped' : 'succeeded', finishedAt: at(0) }
      : step,
  );
  if (failed) {
    job.errorCode = 'HEALTHCHECK_FAILED';
    job.errorMessage = 'Readiness did not pass within 300 s after the change.';
    pushLog(job, 'error: readiness probe failed; rollback is available', 'stderr');
  }

  const instance = job.instanceId
    ? state.instances.find((item) => item.id === job.instanceId)
    : undefined;
  if (!instance) return;
  const status = state.statuses[instance.id];

  if (!failed) {
    if (job.kind === 'stop' || job.kind === 'delete') {
      instance.state = job.kind === 'delete' ? 'deleted' : 'stopped';
      instance.ready = false;
      instance.desiredState = 'stopped';
      instance.route.published = false;
      if (status) {
        status.state = instance.state;
        status.ready = false;
        status.plainStatus = 'unavailable';
      }
      if (job.kind === 'delete') {
        state.instances = state.instances.filter((item) => item.id !== instance.id);
        delete state.statuses[instance.id];
      }
    } else {
      instance.state = 'ready';
      instance.ready = true;
      instance.stateReason = null;
      instance.observedAt = at(0);
      instance.route.published = true;
      instance.integrationVerified = true;
      if (status) {
        status.state = 'ready';
        status.ready = true;
        status.plainStatus = instance.maintenance?.active ? 'maintenance' : 'available';
        status.reason = null;
        status.observedAt = at(0);
      }
      const containers = state.containers[instance.id] ?? [];
      state.containers[instance.id] = containers.map((container) => ({
        ...container,
        state: 'running',
        health: 'healthy',
        startedAt: at(0),
      }));
    }
  } else {
    instance.state = 'degraded';
    instance.ready = false;
    instance.stateReason = job.errorMessage ?? 'The last operation did not complete.';
    if (status) {
      status.state = 'degraded';
      status.ready = false;
      status.plainStatus = 'degraded';
      status.reason = instance.stateReason;
    }
  }
  refreshCapacity(state);
}

/** Advances a job through its steps and writes terminal state back into the store. */
export function simulateJob(jobId: string): void {
  const state = getState();
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job || job.state !== 'queued') return;

  job.state = 'running';
  job.startedAt = at(0);
  job.progress = 4;
  pushLog(job, `job ${job.id} started (${job.kind})`, 'system');

  let cursor = 0;
  const templates = LOG_TEMPLATES[job.kind];

  const tick = () => {
    if (cursor >= job.steps.length) {
      const shouldFail = job.kind === 'upgrade' && job.instanceId === 'inst-people';
      finishJob(job, shouldFail);
      return;
    }
    job.steps = job.steps.map((step, index) => {
      if (index < cursor) return step;
      if (index === cursor) {
        return { ...step, state: 'running', startedAt: at(0) };
      }
      return step;
    });
    const step = job.steps[cursor];
    if (step) pushLog(job, `==> ${step.name}`, 'system');
    const template = templates[cursor % Math.max(templates.length, 1)];
    if (template) pushLog(job, template);

    cursor += 1;
    job.progress = Math.min(96, Math.round((cursor / job.steps.length) * 100));

    schedule(() => {
      job.steps = job.steps.map((item, index) =>
        index === cursor - 1
          ? {
              ...item,
              state: 'succeeded',
              finishedAt: at(0),
              message: item.message ?? 'Completed.',
            }
          : item,
      );
      tick();
    }, TICK_MS);
  };

  schedule(tick, TICK_MS / 2);
}

export function newJobId(): string {
  const count = getState().jobs.length + 1;
  return `job-${2000 + count}`;
}
