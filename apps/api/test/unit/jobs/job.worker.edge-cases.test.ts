import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobWorker } from '../../../src/jobs/job.worker';

/**
 * Two arms of the failure path the main suite cannot reach: the stderr line that cannot be written
 * (the job must still be recorded as failed) and a payload that names its own action (a retry of a
 * rollback must not be reported as a deploy).
 */
const h = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: unknown) => Promise<void>),
  close: vi.fn(async () => undefined),
  constructed: 0,
}));

vi.mock('bullmq', () => ({
  Worker: class extends EventEmitter {
    close = h.close;
    constructor(_name: string, processor: (job: unknown) => Promise<void>) {
      super();
      h.processor = processor;
      h.constructed += 1;
    }
  },
}));

type Step = { job_id: string; seq: number; name: string; state: string; message: string | null };

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    instance_id: 'inst-1',
    lane: 'instance',
    kind: 'deploy',
    state: 'queued',
    requested_by: 'alice',
    payload: {},
    ...overrides,
  };
}

function setup(options: { stages?: unknown[]; failureHandler?: unknown } = {}) {
  let reads = 0;
  const jobs = {
    get: vi.fn(async () => {
      reads += 1;
      return jobRow({ state: reads === 1 ? 'queued' : 'running' });
    }),
    transition: vi.fn(async () => jobRow()),
    appendLog: vi.fn(async () => ({})),
    setStep: vi.fn(async () => undefined),
    steps: vi.fn(async (): Promise<Step[]> => []),
  };
  const pipelines = {
    stages: vi.fn(() => options.stages),
    failureHandler: vi.fn(() => options.failureHandler),
  };
  const worker = new JobWorker({} as never, jobs as never, pipelines as never);
  return { jobs, worker };
}

function bullJob() {
  return { data: { jobId: 'job-1', lane: 'instance', kind: 'deploy' } };
}

function processor(): (job: unknown) => Promise<void> {
  return h.processor as (job: unknown) => Promise<void>;
}

const stage = (name: string, run: () => Promise<void>) => ({ step: name, run: vi.fn(run) });

beforeEach(() => {
  vi.clearAllMocks();
  h.constructed = 0;
  h.processor = undefined;
});

describe('a failure whose log line cannot be written', () => {
  it('still records the job as failed with the real error detail', async () => {
    const stages = [
      stage('apply', async () => {
        throw new Error('the product refused the change');
      }),
    ];
    const { jobs, worker } = setup({ stages });
    // Call order: the "job started" line, the stage line, then the stderr line — which is the one
    // that fails. A log sink failure must never replace the job's own error.
    jobs.appendLog
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('log sink down'));
    worker.start();

    await expect(processor()(bullJob())).rejects.toThrow('the product refused the change');

    expect(jobs.appendLog).toHaveBeenCalledTimes(3);
    expect(jobs.appendLog).toHaveBeenLastCalledWith(
      'job-1',
      'stderr',
      'the product refused the change',
    );
    expect(jobs.transition).toHaveBeenLastCalledWith('job-1', 'failed', {
      errorCode: 'JOB_FAILED',
      errorDetail: 'the product refused the change',
      actorId: 'deploy-worker',
    });
  });
});

describe('a payload that names its own action', () => {
  it('hands the payload action to the pipeline instead of the job kind', async () => {
    let seen: Record<string, unknown> | undefined;
    const run = vi.fn(async (context: Record<string, unknown>) => {
      seen = context;
    });
    const { jobs, worker } = setup({ stages: [{ step: 'rollback', run }] });
    worker.start();
    jobs.get.mockResolvedValue(jobRow({ state: 'queued', payload: { action: 'rollback' } }));

    await processor()(bullJob());

    expect(seen).toMatchObject({ action: 'rollback', payload: { action: 'rollback' } });
    expect(jobs.transition).toHaveBeenLastCalledWith('job-1', 'succeeded', {
      actorId: 'deploy-worker',
    });
  });
});
