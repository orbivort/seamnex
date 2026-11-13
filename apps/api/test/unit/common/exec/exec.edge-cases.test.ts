import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two rules the happy path never exercises: the timeout that applies when the caller names
 * none, and the output cap measured in **bytes** on both streams.
 *
 * `maxOutputBytes` is a memory ceiling for the control plane, so it counts what the buffer costs
 * (`Buffer.byteLength`), not characters: a caller that capped at 4 MiB would otherwise hold 8 MiB
 * of a UTF-8 document. And the default timeout is the only thing between a hung `docker save` and a
 * job lane held forever, so it is asserted rather than assumed.
 */
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { spawnProcess } = await import('../../../../src/common/exec/exec');

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { ended: unknown; end: (value?: unknown) => void };
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    ended: undefined,
    end(value?: unknown) {
      child.stdin.ended = value;
    },
  };
  child.kill = vi.fn(() => true);
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

describe('the default timeout', () => {
  it('kills a hung process after 120 s of its own clock', async () => {
    vi.useFakeTimers();
    const { done } = spawnProcess('docker', ['save']);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(child.kill).not.toHaveBeenCalled();

    child.stderr.emit('data', Buffer.from('saving layer 1'));
    await vi.advanceTimersByTimeAsync(1_000);
    child.emit('close', null);

    const result = await done;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // The reason is appended to what the tool already printed, not instead of it.
    expect(result.stderr).toBe('saving layer 1\n[killed after 120000 ms]');
    expect(result.code).toBe(-1);
  });
});

describe('the output cap', () => {
  it('caps stderr as well as stdout and reports the truncation once', async () => {
    const { done } = spawnProcess('docker', ['build'], { maxOutputBytes: 3 });
    child.stderr.emit('data', Buffer.from('abc'));
    child.stderr.emit('data', Buffer.from('def'));
    child.emit('close', 1);

    const result = await done;
    expect(result.stderr).toBe('abc');
    expect(result.truncated).toBe(true);
  });

  it('counts bytes rather than characters, so a multi-byte payload cannot double the ceiling', async () => {
    const { done } = spawnProcess('docker', ['inspect'], { maxOutputBytes: 2 });
    // 'é' is two bytes: one character into a two-byte budget leaves nothing for the next chunk.
    child.stdout.emit('data', Buffer.from('é', 'utf8'));
    child.stdout.emit('data', Buffer.from('x'));
    child.emit('close', 0);

    const result = await done;
    expect(result.stdout).toBe('é');
    expect(result.truncated).toBe(true);
  });
});

describe('stdin', () => {
  it('writes a Buffer request body and closes the stream', async () => {
    const payload = Buffer.from('{"enabled":false}');
    spawnProcess('curl', ['-d', '@-'], { input: payload });

    expect(child.stdin.ended).toBe(payload);
  });
});
