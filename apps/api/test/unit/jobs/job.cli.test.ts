import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The operator entry point for the synthetic job. It is one line of argument parsing and one exit
 * code, and both are what a script or a CI step reads — so they are asserted, not left to a manual
 * run.
 */
const state = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  steps: vi.fn(),
  logs: vi.fn(),
  close: vi.fn(),
  appClose: vi.fn(),
}));

vi.mock('@nestjs/core', () => ({
  NestFactory: {
    createApplicationContext: vi.fn(async () => ({
      get: () => ({
        create: state.create,
        get: state.get,
        steps: state.steps,
        logs: state.logs,
        close: state.close,
      }),
      close: state.appClose,
    })),
  },
}));
vi.mock('../../../src/app.module', () => ({ AppModule: class AppModule {} }));

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.create.mockResolvedValue({
    job: { id: 'job-1', lane: 'platform' },
    created: true,
  });
  state.get.mockResolvedValue({ id: 'job-1', state: 'succeeded' });
  state.steps.mockResolvedValue([{ seq: 1, name: 'resolve' }]);
  state.logs.mockResolvedValue([{ seq: 1, line: 'started' }]);
  state.close.mockResolvedValue(undefined);
  state.appClose.mockResolvedValue(undefined);
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.exitCode = 0;
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
  process.exitCode = 0;
});

async function runWith(argv: string[]): Promise<void> {
  const saved = process.argv;
  process.argv = ['node', 'job.cli.ts', ...argv];
  try {
    await import('../../../src/jobs/job.cli');
    await vi.waitFor(() => {
      expect(state.appClose).toHaveBeenCalled();
    });
  } finally {
    process.argv = saved;
  }
}

describe('job.cli', () => {
  it('enqueues a synthetic job by default and prints its ids', async () => {
    await runWith([]);

    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'synthetic',
        requestedBy: 'cli',
        payload: { synthetic: true, createdBy: 'job.cli' },
      }),
    );
    expect(stdout).toHaveBeenCalledWith('{"jobId":"job-1","created":true,"lane":"platform"}\n');
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.appClose).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });

  it('shows a job, its steps and its last log lines', async () => {
    await runWith(['show', 'job-1']);

    expect(state.get).toHaveBeenCalledWith('job-1');
    expect(state.steps).toHaveBeenCalledWith('job-1');
    expect(state.logs).toHaveBeenCalledWith('job-1', '0', 100);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"line": "started"'));
    expect(process.exitCode).toBe(0);
  });

  it('answers a failing job with a non-zero exit code', async () => {
    state.get.mockResolvedValue({ id: 'job-1', state: 'failed' });
    await runWith(['show', 'job-1']);

    expect(process.exitCode).toBe(1);
  });

  it('refuses show without an id', async () => {
    await runWith(['show']);

    expect(stderr).toHaveBeenCalledWith('show requires a job id\n');
    expect(state.get).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('refuses an unknown command, naming both accepted ones', async () => {
    await runWith(['deploy']);

    expect(stderr).toHaveBeenCalledWith('Unknown command "deploy". Expected enqueue or show.\n');
    expect(process.exitCode).toBe(1);
  });

  it('always releases the job service and the container, even on a refusal', async () => {
    await runWith(['nonsense']);

    expect(state.close).toHaveBeenCalledOnce();
    expect(state.appClose).toHaveBeenCalledOnce();
  });
});
