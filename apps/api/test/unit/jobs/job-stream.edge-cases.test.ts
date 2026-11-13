import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../../../src/config/config';
import { JobStreamService } from '../../../src/jobs/job-stream';

/**
 * One writer rule the main suite cannot reach: a frame produced *after* the socket was ended must be
 * dropped, not written. The window is real — the state poll is in flight when the client goes away,
 * and its promise still resolves into `SseWriter`. Writing there used to throw inside a timer, which
 * is an unhandled rejection in a process that is otherwise healthy.
 */
type Raw = EventEmitter & {
  writeHead: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  written: string[];
  accept: boolean;
  writableEnded: boolean;
};

function rawResponse(): Raw {
  const raw = new EventEmitter() as Raw;
  raw.written = [];
  raw.accept = true;
  raw.writableEnded = false;
  raw.writeHead = vi.fn();
  raw.write = vi.fn((chunk: string) => {
    if (raw.accept) raw.written.push(chunk);
    return raw.accept;
  });
  raw.end = vi.fn(() => {
    raw.writableEnded = true;
  });
  return raw;
}

function replyWith(raw: Raw): FastifyReply {
  return { hijack: vi.fn(), raw } as unknown as FastifyReply;
}

function subscriberDouble() {
  const subscriber = new EventEmitter() as EventEmitter & {
    subscribe: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
  };
  subscriber.subscribe = vi.fn().mockResolvedValue(1);
  subscriber.quit = vi.fn().mockResolvedValue('OK');
  return subscriber;
}

const CONFIG = { SEAMNEX_JOB_STREAM_MAX: 4 } as unknown as AppConfig;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a state poll that lands after the client left', () => {
  it('discards the terminal frame instead of writing to an ended response', async () => {
    let settle: ((job: { state: string }) => void) | undefined;
    const jobs = {
      get: vi
        .fn()
        // The existence check, then the post-replay read, then a poll that never answers in time.
        .mockResolvedValueOnce({ state: 'running' })
        .mockResolvedValueOnce({ state: 'running' })
        .mockImplementationOnce(
          () =>
            new Promise<{ state: string }>((resolve) => {
              settle = resolve;
            }),
        ),
      logs: vi.fn().mockResolvedValue([]),
    };
    const subscriber = subscriberDouble();
    const service = new JobStreamService(
      { duplicate: vi.fn(() => subscriber) } as never,
      CONFIG,
      { jobStreamRejected: { inc: vi.fn() }, jobStreamActive: { set: vi.fn() } } as never,
      jobs as never,
    );
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');
    await vi.advanceTimersByTimeAsync(2_000);

    raw.emit('close');
    const writtenBefore = raw.written.length;

    settle?.({ state: 'succeeded' });
    await vi.advanceTimersByTimeAsync(0);

    // Nothing reached a client that is gone, and the cleanup ran exactly once.
    expect(raw.written).toHaveLength(writtenBefore);
    expect(raw.end).toHaveBeenCalledOnce();
    expect(subscriber.quit).toHaveBeenCalledOnce();
  });
});

describe('a subscriber that cannot be released', () => {
  it('still finishes the cleanup when the quit itself fails', async () => {
    // Teardown runs on a `close` event, inside a listener: a rejection there would be unhandled in
    // a process that is otherwise healthy, so it is swallowed and the remaining teardown continues.
    const subscriber = subscriberDouble();
    subscriber.quit = vi.fn().mockRejectedValue(new Error('connection already gone'));
    const active = vi.fn();
    const jobs = {
      get: vi.fn().mockResolvedValue({ state: 'running' }),
      logs: vi.fn().mockResolvedValue([]),
    };
    const service = new JobStreamService(
      { duplicate: vi.fn(() => subscriber) } as never,
      CONFIG,
      { jobStreamRejected: { inc: vi.fn() }, jobStreamActive: { set: active } } as never,
      jobs as never,
    );
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');
    raw.emit('close');
    await vi.advanceTimersByTimeAsync(0);

    expect(raw.end).toHaveBeenCalledOnce();
    expect(active).toHaveBeenLastCalledWith(0);
  });
});
