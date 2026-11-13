import type { Job, JobAccepted, JobKind } from '@seamnex/domain';
import { at } from '../fixtures/context';
import { simulateJob } from '../job-simulator';
import { getState } from '../store';

export type EnqueueInput = {
  kind: JobKind;
  instanceId: string | null;
  entryKey: string | null;
  label: string;
  requestedBy: string;
  summary: string;
  steps: string[];
};

export function enqueueJob(input: EnqueueInput): JobAccepted {
  const state = getState();
  const id = `job-${3000 + state.jobs.length}`;
  const job: Job = {
    id,
    kind: input.kind,
    instanceId: input.instanceId,
    entryKey: input.entryKey,
    label: input.label,
    state: 'queued',
    progress: 0,
    createdAt: at(0),
    startedAt: null,
    finishedAt: null,
    requestedBy: input.requestedBy,
    summary: input.summary,
    errorCode: null,
    errorMessage: null,
    steps: input.steps.map((name, index) => ({
      seq: index + 1,
      name,
      state: 'pending',
      startedAt: null,
      finishedAt: null,
      message: null,
    })),
  };
  state.jobs = [job, ...state.jobs];
  state.jobLogs[id] = [];
  simulateJob(id);
  return { jobId: id, links: { self: `/api/v1/jobs/${id}`, logs: `/api/v1/jobs/${id}/logs` } };
}

export const DEPLOY_STEPS = [
  'Pre-flight validation',
  'Resolve source',
  'Render definition',
  'Create network and volumes',
  'Start services',
  'Register integration',
  'Verify readiness',
];

export const LIFECYCLE_STEPS = [
  'Pre-flight validation',
  'Snapshot render set',
  'Apply change',
  'Verify readiness',
];

export const BACKUP_STEPS = [
  'Quiesce database',
  'Dump database',
  'Capture volumes',
  'Encrypt and upload',
  'Register verification',
];
