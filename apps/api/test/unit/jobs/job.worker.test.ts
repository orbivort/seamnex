import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobWorker } from '../../../src/jobs/job.worker';
import { AppError } from '../../../src/common/problem/app-error';

/**
 * The deploy worker owns the lifecycle of a job and nothing else. The two rules that keep a fleet
 * consistent are asserted here: a stale Redis entry for a job that is no longer `queued` must not
 * start (a cancelled job cannot be resurrected), and a job that fails must be recorded as failed
 * even when its own failure handler throws — a cancelled job is terminal, so the transition guard
 * is the transition table rather than an assumption.
 */
const h = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: unknown) => Promise<void>),
  options: undefined as unknown,
  close: vi.fn(async () => undefined),
  constructed: 0,
  instance: undefined as undefined | EventEmitter,
}));

vi.mock('bullmq', () => ({
  Worker: class extends EventEmitter {
    close = h.close;
    constructor(_name: string, processor: (job: unknown) => Promise<void>, options: unknown) {
      super();
      h.processor = processor;
      h.options = options;
      h.constructed += 1;
      h.instance = this;
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

function setup(options: { stages?: unknown[] | undefined; failureHandler?: unknown } = {}) {
  /**
   * The first read is the "is it still queued?" check; every later read observes the job the worker
   * just moved to `running`. Tests that care about a state change override the sequence.
   */
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
  return { jobs, pipelines, worker };
}

function bullJob(data: Record<string, unknown> = {}) {
  return { data: { jobId: 'job-1', lane: 'instance', kind: 'deploy', ...data } };
}

const stage = (name: string) => ({ step: name, run: vi.fn(async () => undefined) });

beforeEach(() => {
  vi.clearAllMocks();
  h.constructed = 0;
  h.processor = undefined;
});

describe('start', () => {
  it('runs four jobs at a time and subscribes to both worker events', async () => {
    const { worker } = setup();

    worker.start();
    worker.start();

    expect(h.constructed).toBe(1);
    expect(h.options).toEqual({ connection: {}, concurrency: 4 });
    // A lost Redis connection must be a log line, not an uncaught exception that kills the role
    // in the middle of a stage.
    expect(h.instance?.listenerCount('error')).toBe(1);
    expect(h.instance?.listenerCount('failed')).toBe(1);
    expect(() => h.instance?.emit('error', new Error('redis blip'))).not.toThrow();
    expect(() =>
      h.instance?.emit('failed', { id: 'job-1' }, new Error('stage died')),
    ).not.toThrow();
    expect(() => h.instance?.emit('failed', undefined, new Error('no job'))).not.toThrow();
  });

  it('closes the worker on shutdown, and does nothing when it never started', async () => {
    const { worker } = setup();
    await expect(worker.onApplicationShutdown()).resolves.toBeUndefined();

    worker.start();
    await worker.onApplicationShutdown();
    expect(h.close).toHaveBeenCalledOnce();
  });
});

describe('process', () => {
  function processor(): (job: unknown) => Promise<void> {
    return h.processor as (job: unknown) => Promise<void>;
  }

  it('leaves a manual job for its creator', async () => {
    const { jobs, worker } = setup();
    worker.start();

    await processor()(bullJob({ manual: true }));

    // Two writers owning one state machine is the defect this prevents.
    expect(jobs.get).not.toHaveBeenCalled();
  });

  it('skips a job that is no longer queued', async () => {
    const { jobs, worker } = setup();
    jobs.get.mockResolvedValue(jobRow({ state: 'cancelled' }));
    worker.start();

    await processor()(bullJob());

    expect(jobs.transition).not.toHaveBeenCalled();
  });

  it('runs every stage and marks the job succeeded', async () => {
    const stages = [stage('prepare'), stage('apply')];
    const { jobs, worker } = setup({ stages });
    worker.start();

    await processor()(bullJob());

    expect(jobs.transition).toHaveBeenNthCalledWith(1, 'job-1', 'running', {
      actorId: 'deploy-worker',
    });
    expect(stages[0]?.run).toHaveBeenCalledOnce();
    expect(stages[1]?.run).toHaveBeenCalledOnce();
    expect(jobs.setStep).toHaveBeenCalledWith('job-1', 1, 'running');
    expect(jobs.setStep).toHaveBeenCalledWith('job-1', 1, 'succeeded');
    expect(jobs.transition).toHaveBeenLastCalledWith('job-1', 'succeeded', {
      actorId: 'deploy-worker',
    });
  });

  it('fails a job whose kind has no registered pipeline, and says so', async () => {
    const { jobs, worker } = setup({ stages: undefined });
    worker.start();

    await expect(processor()(bullJob())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    expect(jobs.transition).toHaveBeenLastCalledWith(
      'job-1',
      'failed',
      expect.objectContaining({ errorCode: 'INTERNAL_ERROR' }),
    );
  });

  it('records a failed stage, keeps the real error and fails the job with JOB_FAILED', async () => {
    const stages = [
      {
        step: 'apply',
        run: vi.fn(async () => {
          throw new Error('the product refused the change');
        }),
      },
    ];
    const failureHandler = vi.fn(async () => undefined);
    const { jobs, worker } = setup({ stages, failureHandler });
    worker.start();

    await expect(processor()(bullJob())).rejects.toThrow('the product refused the change');

    expect(jobs.setStep).toHaveBeenCalledWith(
      'job-1',
      1,
      'failed',
      'the product refused the change',
    );
    expect(jobs.appendLog).toHaveBeenCalledWith(
      'job-1',
      'stderr',
      'the product refused the change',
    );
    expect(failureHandler).toHaveBeenCalledOnce();
    expect(jobs.transition).toHaveBeenLastCalledWith('job-1', 'failed', {
      errorCode: 'JOB_FAILED',
      errorDetail: 'the product refused the change',
      actorId: 'deploy-worker',
    });
  });

  it('uses the problem code of an AppError', async () => {
    const stages = [
      {
        step: 'verify',
        run: vi.fn(async () => {
          throw new AppError({ code: 'HTTP_PORT_NOT_EXPOSED', detail: 'no port' });
        }),
      },
    ];
    const { jobs, worker } = setup({ stages });
    worker.start();

    await expect(processor()(bullJob())).rejects.toMatchObject({ code: 'HTTP_PORT_NOT_EXPOSED' });
    expect(jobs.transition).toHaveBeenLastCalledWith(
      'job-1',
      'failed',
      expect.objectContaining({ errorCode: 'HTTP_PORT_NOT_EXPOSED' }),
    );
  });

  it('records a non-Error stage failure by its string form', async () => {
    const stages = [
      {
        step: 'apply',
        run: vi.fn(async () => {
          throw 'strings are not errors';
        }),
      },
    ];
    const { jobs, worker } = setup({ stages });
    worker.start();

    await expect(processor()(bullJob())).rejects.toBe('strings are not errors');
    expect(jobs.setStep).toHaveBeenCalledWith('job-1', 1, 'failed', 'strings are not errors');
  });

  it('keeps a failed job failed even when its own failure handler throws', async () => {
    const stages = [
      {
        step: 'apply',
        run: vi.fn(async () => {
          throw new Error('stage died');
        }),
      },
    ];
    const failureHandler = vi.fn(async () => {
      throw new Error('handler died');
    });
    const { jobs, worker } = setup({ stages, failureHandler });
    worker.start();

    await expect(processor()(bullJob())).rejects.toThrow('stage died');
    expect(jobs.transition).toHaveBeenLastCalledWith(
      'job-1',
      'failed',
      expect.objectContaining({ errorDetail: 'stage died' }),
    );
  });

  it('records a non-Error failure-handler fault without replacing the job error', async () => {
    const stages = [
      {
        step: 'apply',
        run: vi.fn(async () => {
          throw new Error('stage died');
        }),
      },
    ];
    const failureHandler = vi.fn(async () => {
      throw 'handler died';
    });
    const { worker } = setup({ stages, failureHandler });
    worker.start();

    await expect(processor()(bullJob())).rejects.toThrow('stage died');
  });

  it('does not fail a cancelled job a second time', async () => {
    const stages = [
      {
        step: 'apply',
        run: vi.fn(async () => {
          throw new Error('stage died');
        }),
      },
    ];
    const { jobs, worker } = setup({ stages });
    // The stage's failure raced a cancellation: `cancelled` is terminal.
    jobs.get
      .mockResolvedValueOnce(jobRow({ state: 'queued' }))
      .mockResolvedValueOnce(jobRow({ state: 'running' }))
      .mockResolvedValue(jobRow({ state: 'cancelled' }));
    worker.start();

    await expect(processor()(bullJob())).rejects.toThrow('stage died');
    expect(jobs.transition).not.toHaveBeenCalledWith('job-1', 'failed', expect.anything());
  });

  it('keeps the original error when the job cannot be re-read after a failure', async () => {
    const stages = [
      {
        step: 'apply',
        run: vi.fn(async () => {
          throw new Error('stage died');
        }),
      },
    ];
    const { jobs, worker } = setup({ stages });
    worker.start();
    jobs.get
      .mockResolvedValueOnce(jobRow({ state: 'queued' }))
      .mockResolvedValueOnce(jobRow({ state: 'running' }))
      .mockRejectedValueOnce(new Error('database gone'));

    await expect(processor()(bullJob())).rejects.toThrow('stage died');
    expect(jobs.transition).toHaveBeenCalledTimes(1);
  });

  it('keeps the original error when the failure transition itself fails', async () => {
    const stages = [
      {
        step: 'apply',
        run: vi.fn(async () => {
          throw new Error('stage died');
        }),
      },
    ];
    const { jobs, worker } = setup({ stages });
    worker.start();
    jobs.transition.mockResolvedValueOnce(jobRow()).mockRejectedValueOnce(new Error('db gone'));

    await expect(processor()(bullJob())).rejects.toThrow('stage died');
  });

  it('skips the remaining steps when a job is cancelled before its next stage', async () => {
    const stages = [stage('prepare'), stage('apply')];
    const { jobs, worker } = setup({ stages });
    worker.start();
    // First read (queued check) → running; the stage loop then sees `cancelled`.
    jobs.get.mockResolvedValueOnce(jobRow()).mockResolvedValue(jobRow({ state: 'cancelled' }));
    jobs.steps.mockResolvedValue([
      { job_id: 'job-1', seq: 1, name: 'prepare', state: 'succeeded', message: null },
      { job_id: 'job-1', seq: 2, name: 'apply', state: 'pending', message: null },
    ]);

    await processor()(bullJob());

    expect(jobs.setStep).toHaveBeenCalledWith('job-1', 2, 'skipped', 'job cancelled');
    expect(stages[0]?.run).not.toHaveBeenCalled();
    expect(jobs.transition).not.toHaveBeenCalledWith('job-1', 'succeeded', expect.anything());
  });

  it('marks the current step skipped when the cancellation lands during it', async () => {
    const applied = stage('apply');
    const { jobs, worker } = setup({ stages: [applied] });
    worker.start();
    jobs.get
      .mockResolvedValueOnce(jobRow())
      .mockResolvedValueOnce(jobRow({ state: 'running' }))
      .mockResolvedValue(jobRow({ state: 'cancelled' }));

    await processor()(bullJob());

    expect(jobs.setStep).toHaveBeenCalledWith('job-1', 1, 'skipped', 'job cancelled');
    expect(jobs.appendLog).toHaveBeenCalledWith('job-1', 'system', 'job cancelled by request');
    expect(jobs.transition).not.toHaveBeenCalledWith('job-1', 'succeeded', expect.anything());
  });

  it('does not report success for a job cancelled after its last stage', async () => {
    const stages = [stage('apply')];
    const { jobs, worker } = setup({ stages });
    worker.start();
    jobs.get
      .mockResolvedValueOnce(jobRow())
      .mockResolvedValueOnce(jobRow({ state: 'running' }))
      .mockResolvedValueOnce(jobRow({ state: 'running' }))
      .mockResolvedValue(jobRow({ state: 'cancelled' }));

    await processor()(bullJob());

    expect(jobs.transition).not.toHaveBeenCalledWith('job-1', 'succeeded', expect.anything());
  });

  it('settles a cancelled job even when the cancellation line cannot be written', async () => {
    const { jobs, worker } = setup({ stages: [stage('apply')] });
    jobs.get
      .mockResolvedValueOnce(jobRow({ state: 'queued' }))
      .mockResolvedValue(jobRow({ state: 'cancelled' }));
    // The "job started" line lands; the cancellation line does not.
    jobs.appendLog.mockResolvedValueOnce({}).mockRejectedValue(new Error('redis down'));
    worker.start();

    await expect(processor()(bullJob())).resolves.toBeUndefined();
    // The instance is settled regardless: a cancellation must not leave a transitional state behind.
    expect(jobs.steps).toHaveBeenCalled();
  });

  it('passes the payload action, the actor and a cancellation probe into the context', async () => {
    let seen: Record<string, unknown> | undefined;
    const stages = [
      {
        step: 'apply',
        run: vi.fn(async (context: Record<string, unknown>) => {
          seen = context;
          await (context.log as (stream: string, line: string) => Promise<void>)('stdout', 'hello');
        }),
      },
    ];
    const { jobs, worker } = setup({ stages });
    worker.start();
    jobs.get.mockResolvedValue(jobRow({ state: 'queued', requested_by: null, instance_id: null }));

    await processor()(bullJob());

    expect(seen).toMatchObject({
      jobId: 'job-1',
      instanceId: '',
      actorId: 'deploy-worker',
      action: 'deploy',
      payload: {},
    });
    expect(jobs.appendLog).toHaveBeenCalledWith('job-1', 'stdout', 'hello');
    await expect((seen?.cancelled as () => Promise<boolean>)()).resolves.toBe(false);
  });
});
