import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../../../src/config/config';
import { AppError } from '../../../src/common/problem/app-error';
import { JobStreamService } from '../../../src/jobs/job-stream';

/**
 * SSE is the one endpoint that hijacks the reply, so the properties worth pinning are the ones a
 * problem document can no longer express once the head is written: subscribe-before-replay, the
 * headers that must be set on `raw`, deduplication by id, and closing exactly once.
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
    // A real socket buffers what it cannot flush; the test only records what the client received.
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

type Subscriber = EventEmitter & {
  subscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
};

function subscriberDouble(): Subscriber {
  const subscriber = new EventEmitter() as Subscriber;
  subscriber.subscribe = vi.fn().mockResolvedValue(1);
  subscriber.quit = vi.fn().mockResolvedValue('OK');
  return subscriber;
}

const CONFIG = { SEAMNEX_JOB_STREAM_MAX: 4 } as unknown as AppConfig;

type JobsDouble = {
  get: ReturnType<typeof vi.fn>;
  logs: ReturnType<typeof vi.fn>;
};

function jobsDouble(
  options: {
    states?: string[];
    logs?: Array<{ id: number; seq: number; ts: Date; stream: string; line: string }>;
  } = {},
): JobsDouble {
  const states = options.states ?? ['running', 'succeeded'];
  let index = 0;
  return {
    get: vi.fn().mockImplementation(() => {
      const state = states[Math.min(index, states.length - 1)];
      index += 1;
      return Promise.resolve({ id: 'job-1', state });
    }),
    logs: vi.fn().mockResolvedValue(options.logs ?? []),
  };
}

function build(
  options: {
    config?: Partial<AppConfig>;
    jobs?: JobsDouble;
    subscriber?: Subscriber;
  } = {},
) {
  const subscriber = options.subscriber ?? subscriberDouble();
  const redis = { duplicate: vi.fn(() => subscriber) };
  const metrics = {
    jobStreamRejected: { inc: vi.fn() },
    jobStreamActive: { set: vi.fn() },
  };
  const jobs = options.jobs ?? jobsDouble();
  const service = new JobStreamService(
    redis as never,
    { ...CONFIG, ...options.config } as AppConfig,
    metrics as never,
    jobs as never,
  );
  return { service, subscriber, metrics, jobs };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JobStreamService refusals', () => {
  it('refuses with STREAM_LIMIT before hijacking the reply', async () => {
    const { service, metrics } = build({ config: { SEAMNEX_JOB_STREAM_MAX: 0 } });
    const raw = rawResponse();
    const reply = replyWith(raw);

    await expect(service.open(reply, 'job-1')).rejects.toMatchObject({
      code: 'STREAM_LIMIT',
      status: 429,
    });
    expect(reply.hijack).not.toHaveBeenCalled();
    expect(metrics.jobStreamRejected.inc).toHaveBeenCalledOnce();
    expect(raw.written).toEqual([]);
  });

  it('propagates a missing job before hijacking, so the answer is still a problem document', async () => {
    const jobs = jobsDouble();
    jobs.get.mockRejectedValue(new AppError({ code: 'NOT_FOUND', detail: 'no such job' }));
    const { service } = build({ jobs });
    const reply = replyWith(rawResponse());

    await expect(service.open(reply, 'job-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reply.hijack).not.toHaveBeenCalled();
  });
});

describe('JobStreamService stream', () => {
  it('writes the event-stream head on raw, including request id and security headers', async () => {
    const { service } = build();
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1', undefined, 'rid-9');

    const [status, headers] = raw.writeHead.mock.calls[0] as [number, Record<string, string>];
    expect(status).toBe(200);
    expect(headers).toMatchObject({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': 'rid-9',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    expect(raw.written[0]).toBe(': stream open\n\n');
  });

  it('omits the request id header when none was supplied', async () => {
    const { service } = build();
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');

    const [, headers] = raw.writeHead.mock.calls[0] as [number, Record<string, string>];
    expect(headers['x-request-id']).toBeUndefined();
  });

  it('subscribes before replaying the log, then emits each replayed line', async () => {
    const order: string[] = [];
    const subscriber = subscriberDouble();
    subscriber.subscribe.mockImplementation(async () => {
      order.push('subscribe');
      return 1;
    });
    const jobs = jobsDouble({
      states: ['running'],
      logs: [
        { id: 1, seq: 1, ts: new Date('2026-01-01T00:00:00.000Z'), stream: 'stdout', line: 'one' },
        { id: 2, seq: 2, ts: new Date('2026-01-01T00:00:01.000Z'), stream: 'stderr', line: 'two' },
      ],
    });
    jobs.logs.mockImplementation(async () => {
      order.push('logs');
      return [
        { id: 1, seq: 1, ts: new Date('2026-01-01T00:00:00.000Z'), stream: 'stdout', line: 'one' },
        { id: 2, seq: 2, ts: new Date('2026-01-01T00:00:01.000Z'), stream: 'stderr', line: 'two' },
      ];
    });
    const { service } = build({ jobs, subscriber });
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');

    expect(order).toEqual(['subscribe', 'logs']);
    expect(raw.written.filter((chunk) => chunk.startsWith('id: '))).toHaveLength(2);
    expect(raw.written.find((chunk) => chunk.includes('"line":"one"'))).toBeDefined();
  });

  it('resumes from a numeric Last-Event-ID and ignores one that is not', async () => {
    const jobs = jobsDouble({ states: ['running'], logs: [] });
    const { service } = build({ jobs });

    await service.open(replyWith(rawResponse()), 'job-1', '42');
    expect(jobs.logs).toHaveBeenLastCalledWith('job-1', '42', 1_000);

    await service.open(replyWith(rawResponse()), 'job-1', 'not-a-number');
    expect(jobs.logs).toHaveBeenLastCalledWith('job-1', '0', 1_000);
  });

  it('tells the client when the replay was truncated by the limit', async () => {
    const logs = Array.from({ length: 1_000 }, (_, index) => ({
      id: index + 1,
      seq: index + 1,
      ts: new Date(0),
      stream: 'stdout',
      line: `line ${index}`,
    }));
    const { service } = build({ jobs: jobsDouble({ states: ['running'], logs }) });
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');

    expect(raw.written.some((chunk) => chunk.startsWith('event: truncated'))).toBe(true);
  });

  it('ends immediately when the job is already terminal after the replay', async () => {
    const { service, subscriber } = build({ jobs: jobsDouble({ states: ['succeeded'] }) });
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');

    expect(raw.written.some((chunk) => chunk.includes('"terminal":true'))).toBe(true);
    expect(subscriber.quit).toHaveBeenCalledOnce();
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('sends a heartbeat and closes when the state poll sees a terminal job', async () => {
    const jobs = {
      get: vi.fn().mockResolvedValue({ state: 'running' }),
      logs: vi.fn().mockResolvedValue([]),
    };
    const { service, subscriber } = build({ jobs });
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(raw.written).toContain(': heartbeat\n\n');

    jobs.get.mockResolvedValue({ state: 'failed' });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(raw.written.some((chunk) => chunk.includes('"state":"failed"'))).toBe(true);
    expect(subscriber.quit).toHaveBeenCalledOnce();
  });

  it('buffers a message that arrives while the replay is still being read', async () => {
    const subscriber = subscriberDouble();
    const jobs = {
      get: vi.fn().mockResolvedValue({ state: 'running' }),
      logs: vi.fn().mockImplementation(async () => {
        // Arrives after the subscription exists but before the replay is complete.
        subscriber.emit('message', 'channel', JSON.stringify({ id: 3, line: 'during replay' }));
        return [];
      }),
    };
    const { service } = build({ jobs, subscriber });
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');

    expect(raw.written.some((chunk) => chunk.includes('during replay'))).toBe(true);
  });

  it('closes the stream when a non-Error state poll failure occurs', async () => {
    const jobs = jobsDouble({ states: ['running', 'running'] });
    jobs.get
      .mockImplementationOnce(() => Promise.resolve({ state: 'running' }))
      .mockImplementationOnce(() => Promise.resolve({ state: 'running' }))
      .mockImplementationOnce(() => Promise.reject('socket gone'));
    const { service, subscriber } = build({ jobs });

    await service.open(replyWith(rawResponse()), 'job-1');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(subscriber.quit).toHaveBeenCalledOnce();
  });

  it('closes the stream when the subscription fails with a non-Error', async () => {
    const subscriber = subscriberDouble();
    subscriber.subscribe.mockRejectedValue('redis down');
    const { service } = build({ subscriber });
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');

    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('does not call end on a response the socket already ended', async () => {
    const { service } = build({ jobs: jobsDouble({ states: ['succeeded'] }) });
    const raw = rawResponse();
    raw.writableEnded = true;

    await service.open(replyWith(raw), 'job-1');

    expect(raw.end).not.toHaveBeenCalled();
  });

  it('closes the stream when the state poll fails rather than polling forever', async () => {
    const jobs = jobsDouble({ states: ['running', 'running'] });
    jobs.get.mockImplementationOnce(() => Promise.resolve({ state: 'running' }));
    jobs.get.mockImplementationOnce(() => Promise.resolve({ state: 'running' }));
    jobs.get.mockImplementationOnce(() => Promise.reject(new Error('database gone')));
    const { service, subscriber } = build({ jobs });

    await service.open(replyWith(rawResponse()), 'job-1');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(subscriber.quit).toHaveBeenCalledOnce();
  });

  it('emits live messages, deduplicates by id and ignores a malformed member', async () => {
    const subscriber = subscriberDouble();
    const jobs = jobsDouble({ states: ['running'], logs: [] });
    const { service } = build({ jobs, subscriber });
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');

    subscriber.emit('message', 'channel', JSON.stringify({ id: 1, line: 'early' }));
    expect(raw.written.some((chunk) => chunk.includes('early'))).toBe(true);

    subscriber.emit('message', 'channel', JSON.stringify({ id: 1, line: 'again' }));
    expect(raw.written.filter((chunk) => chunk.includes('again'))).toHaveLength(0);

    subscriber.emit('message', 'channel', 'not json');
    subscriber.emit('message', 'channel', JSON.stringify({ id: 'x' }));
    expect(raw.written.some((chunk) => chunk.includes('not json'))).toBe(false);
  });

  it('stops emitting live messages once the stream is closed', async () => {
    const subscriber = subscriberDouble();
    const { service } = build({ jobs: jobsDouble({ states: ['running'] }), subscriber });
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');
    raw.emit('close');
    const before = raw.written.length;

    subscriber.emit('message', 'channel', JSON.stringify({ id: 99, line: 'late' }));
    expect(raw.written).toHaveLength(before);
  });

  it('cleans up once on a client close and stops accepting writes', async () => {
    const { service, subscriber, metrics } = build();
    const raw = rawResponse();

    await service.open(replyWith(raw), 'job-1');

    raw.emit('close');
    raw.emit('close');
    raw.emit('error', new Error('socket reset'));

    expect(subscriber.quit).toHaveBeenCalledOnce();
    expect(raw.end).toHaveBeenCalledOnce();
    expect(metrics.jobStreamActive.set).toHaveBeenLastCalledWith(0);
  });

  it('closes the stream and logs when the subscription cannot be made', async () => {
    const subscriber = subscriberDouble();
    subscriber.subscribe.mockRejectedValue(new Error('redis down'));
    const { service } = build({ subscriber });
    const raw = rawResponse();

    await expect(service.open(replyWith(raw), 'job-1')).resolves.toBeUndefined();

    expect(raw.end).toHaveBeenCalledOnce();
    expect(subscriber.quit).toHaveBeenCalledOnce();
  });

  it('queues writes while the socket is blocked and flushes them on drain', async () => {
    const { service } = build({ jobs: jobsDouble({ states: ['running'] }) });
    const raw = rawResponse();
    raw.accept = false;

    await service.open(replyWith(raw), 'job-1');
    // The opening write reported backpressure, so the heartbeat is queued rather than written.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(raw.written).not.toContain(': heartbeat\n\n');

    // A drain while the socket still refuses writes keeps the writer blocked.
    raw.emit('drain');
    expect(raw.written).not.toContain(': heartbeat\n\n');

    await vi.advanceTimersByTimeAsync(15_000);
    raw.accept = true;
    raw.emit('drain');

    expect(raw.written).toContain(': heartbeat\n\n');
  });
});
