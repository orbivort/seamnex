import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecError as ExecFailure } from '../../../../src/common/exec/exec';

/**
 * `spawn` is replaced so the three safety rules can be asserted without running a process: no shell,
 * a timeout that SIGKILLs, and an output cap that reports truncation instead of buffering forever.
 */
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { childEnvironment, ExecError, runOrThrow, spawnProcess } =
  await import('../../../../src/common/exec/exec');

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { ended: unknown; end: (value?: unknown) => void };
  kill: ReturnType<typeof vi.fn>;
  killed: string[];
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const killed: string[] = [];
  child.killed = killed;
  child.stdin = {
    ended: undefined,
    end(value?: unknown) {
      child.stdin.ended = value;
    },
  };
  child.kill = vi.fn((signal: string) => {
    killed.push(signal);
    return true;
  });
  return child;
}

let child: FakeChild;

beforeEach(() => {
  child = fakeChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('spawnProcess', () => {
  it('never uses a shell, pipes all three streams and hides the window', () => {
    spawnProcess('docker', ['ps', '-a'], { cwd: '/srv' });

    expect(spawnMock).toHaveBeenCalledWith(
      'docker',
      ['ps', '-a'],
      expect.objectContaining({
        cwd: '/srv',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
  });

  it('passes only the child environment unless the caller names one', () => {
    spawnProcess('git', ['status']);
    const options = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(Object.keys(options.env).sort()).toEqual(['HOME', 'LANG', 'PATH']);

    spawnProcess('git', ['status'], { env: { PATH: '/custom' } });
    expect((spawnMock.mock.calls[1]?.[2] as { env: NodeJS.ProcessEnv }).env).toEqual({
      PATH: '/custom',
    });
  });

  it('collects stdout and stderr and resolves the exit code', async () => {
    const { done } = spawnProcess('sh', ['-c', 'true']);
    child.stdout.emit('data', Buffer.from('hello '));
    child.stdout.emit('data', Buffer.from('world'));
    child.stderr.emit('data', Buffer.from('warning'));
    child.emit('close', 0);

    await expect(done).resolves.toEqual({
      code: 0,
      stdout: 'hello world',
      stderr: 'warning',
      truncated: false,
    });
  });

  it('reports -1 for a process killed by a signal instead of inventing a code', async () => {
    const { done } = spawnProcess('sh', []);
    child.emit('close', null);
    await expect(done).resolves.toMatchObject({ code: -1 });
  });

  it('caps the output and says so rather than buffering without bound', async () => {
    const { done } = spawnProcess('sh', [], { maxOutputBytes: 5 });
    child.stdout.emit('data', Buffer.from('abc'));
    child.stdout.emit('data', Buffer.from('de'));
    child.stdout.emit('data', Buffer.from('fghij'));
    child.emit('close', 0);

    const result = await done;
    expect(result.stdout).toBe('abcde');
    expect(result.truncated).toBe(true);
  });

  it('writes the provided input and closes stdin', () => {
    spawnProcess('cat', [], { input: 'payload' });
    expect(child.stdin.ended).toBe('payload');
  });

  it('closes stdin even when there is no input', () => {
    spawnProcess('cat', []);
    expect(child.stdin.ended).toBeUndefined();
  });

  it('rejects with an ExecError carrying the cause when the process cannot start', async () => {
    const { done } = spawnProcess('no-such-binary', []);
    const cause = new Error('ENOENT');
    child.emit('error', cause);

    let error: unknown;
    try {
      await done;
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ExecError);
    const failure = error as ExecFailure;
    expect(failure.file).toBe('no-such-binary');
    expect(failure.code).toBeNull();
    expect(failure.message).toContain('could not be started: ENOENT');
    expect((failure.cause as Error).message).toBe('ENOENT');
  });

  it('kills a hung process after the timeout and records why', async () => {
    vi.useFakeTimers();
    const { done } = spawnProcess('docker', ['save'], { timeoutMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    child.emit('close', null);

    const result = await done;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result.stderr).toContain('[killed after 1000 ms]');
  });

  it('does not kill a process that already exited before the timeout', async () => {
    vi.useFakeTimers();
    const { done } = spawnProcess('true', [], { timeoutMs: 1_000 });
    child.emit('close', 0);
    await done;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it('kills on an abort signal and records it', async () => {
    const controller = new AbortController();
    const { done } = spawnProcess('pg_dump', [], { signal: controller.signal });

    controller.abort();
    child.emit('close', null);

    const result = await done;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result.stderr).toContain('[aborted]');
  });

  it('ignores an abort after the process settled', async () => {
    const controller = new AbortController();
    const { done } = spawnProcess('true', [], { signal: controller.signal });
    child.emit('close', 0);
    await done;

    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('runOrThrow', () => {
  it('returns the result of a successful process', async () => {
    const promise = runOrThrow('git', ['rev-parse', 'HEAD']);
    child.stdout.emit('data', Buffer.from('abc123\n'));
    child.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ code: 0, stdout: 'abc123\n' });
  });

  it('rejects on a non-zero exit code with the reason from stderr', async () => {
    const promise = runOrThrow('git', ['clone', 'x']);
    child.stderr.emit('data', Buffer.from("Cloning into 'x'...\nfatal: repository not found\n"));
    child.emit('close', 128);

    await expect(promise).rejects.toMatchObject({
      name: 'ExecError',
      code: 128,
      message: expect.stringContaining('fatal: repository not found'),
    });
  });

  it('prefers an explicit error line on stdout over the progress line on stderr', async () => {
    const promise = runOrThrow('docker', ['buildx', 'build']);
    child.stdout.emit('data', Buffer.from('ERROR: failed to solve: not found\n'));
    child.stderr.emit('data', Buffer.from('Image seamnex/x Building\n'));
    child.emit('close', 1);

    let error: unknown;
    try {
      await promise;
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain('ERROR: failed to solve: not found');
  });

  it('falls back to the first stderr line, then the last stdout line, then no output', async () => {
    const first = runOrThrow('a', []);
    child.stderr.emit('data', Buffer.from('first line\nsecond line\n'));
    child.emit('close', 1);
    await expect(first).rejects.toThrow(/first line/);

    const second = runOrThrow('b', []);
    child.stdout.emit('data', Buffer.from('progress\nconclusion\n'));
    child.emit('close', 1);
    await expect(second).rejects.toThrow(/conclusion/);

    const third = runOrThrow('c', []);
    child.emit('close', 1);
    await expect(third).rejects.toThrow(/\(no output\)/);
  });

  it('does not report truncation as success incorrectly — it returns the capped result', async () => {
    const promise = runOrThrow('docker', ['inspect'], { maxOutputBytes: 4 });
    child.stdout.emit('data', Buffer.from('abcd'));
    child.stdout.emit('data', Buffer.from('efgh'));
    child.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ truncated: true, stdout: 'abcd' });
  });
});

describe('childEnvironment', () => {
  it('includes PATH, HOME and a locale, with caller extras winning', () => {
    const env = childEnvironment({ SEAMNEX_ROLE: 'api' });
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBeTruthy();
    expect(env.LANG).toBeTruthy();
    expect(env.SEAMNEX_ROLE).toBe('api');
  });

  it('supplies defaults when the parent process has none', () => {
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG };
    try {
      delete process.env.PATH;
      delete process.env.HOME;
      delete process.env.LANG;
      expect(childEnvironment()).toEqual({
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/tmp',
        LANG: 'C.UTF-8',
      });
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
