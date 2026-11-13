import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { METRICS } from '../common/metrics/metrics';
import type { Metrics } from '../common/metrics/metrics';
import { AppError } from '../common/problem/app-error';
import { JOB_LOG_CHANNEL_PREFIX, JobService } from './job.service';
import { isTerminalJobState } from './job-state';

const HEARTBEAT_MS = 15_000;
const STATE_POLL_MS = 2_000;
const REPLAY_LIMIT = 1_000;

/**
 * SSE over Redis pub/sub (ADR-BE-07, deliverable 1.4).
 *
 * Replay comes from `job_log`, so a reload mid-job reconstructs what the browser missed; the
 * stream is an optimisation over `GET /jobs/{id}`, never the source of truth. The connection is
 * bounded per replica, because a long-lived stream costs a socket and a Redis subscriber.
 *
 * Three failure modes this implementation is built around, each of which lost data in the first
 * version:
 *   1. **subscribe before replay.** Reading the log and *then* subscribing leaves a gap: a line
 *      published between the two is never seen and the client is never told to reconnect.
 *   2. **a hijacked response has no Fastify pipeline.** The status, the request id and the
 *      security headers go on `raw` or they do not exist.
 *   3. **a slow client must not buffer the process.** `write()` returning false is backpressure,
 *      not an invitation to keep writing.
 */
@Injectable()
export class JobStreamService {
  private readonly logger = new Logger('job-stream');
  private active = 0;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(JobService) private readonly jobs: JobService,
  ) {}

  async open(
    reply: FastifyReply,
    jobId: string,
    lastEventId?: string,
    requestId?: string,
  ): Promise<void> {
    // Everything that can fail happens before the response is hijacked, so a refusal is still a
    // problem document rather than a broken stream.
    const initial = await this.jobs.get(jobId);

    if (this.active >= this.config.SEAMNEX_JOB_STREAM_MAX) {
      this.metrics.jobStreamRejected.inc();
      throw new AppError({
        code: 'STREAM_LIMIT',
        status: 429,
        detail: `This replica already serves ${this.config.SEAMNEX_JOB_STREAM_MAX} job streams.`,
      });
    }

    // An untrusted header decides a `bigint` comparison; a non-numeric value used to raise 22P02
    // after `hijack()`, i.e. after a problem document could still be rendered.
    const cursor = lastEventId !== undefined && /^\d+$/.test(lastEventId) ? Number(lastEventId) : 0;

    this.active += 1;
    this.metrics.jobStreamActive.set(this.active);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tell nginx/Traefik not to buffer the stream.
      'x-accel-buffering': 'no',
      // `reply.header()` is discarded once the response is hijacked, so the headers the plan
      // promises on *every* response are set here explicitly.
      ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });

    const writer = new SseWriter(raw);
    writer.write(': stream open\n\n');

    let closed = false;
    let lastId = cursor;
    let live = false;
    const pending: { id: number; payload: string }[] = [];
    const subscriber = this.redis.duplicate();
    const timers: NodeJS.Timeout[] = [];

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      void subscriber.quit().catch(() => undefined);
      this.active -= 1;
      this.metrics.jobStreamActive.set(this.active);
      writer.end();
    };

    const emit = (entry: { id: number; payload: string }): void => {
      if (entry.id <= lastId) return;
      lastId = entry.id;
      writer.write(`id: ${entry.id}\ndata: ${entry.payload}\n\n`);
    };

    raw.on('close', cleanup);
    raw.on('error', cleanup);

    try {
      // 1. Subscribe first, buffering anything that arrives while the replay is read.
      await subscriber.subscribe(`${JOB_LOG_CHANNEL_PREFIX}${jobId}`);
      subscriber.on('message', (_channel: string, payload: string) => {
        if (closed) return;
        const entry = parseEntry(payload);
        if (entry === undefined) return; // A malformed member must not kill the stream.
        if (!live) {
          pending.push(entry);
          return;
        }
        emit(entry);
      });

      // 2. Replay from the log. Anything already ingested is deduplicated by id below.
      const replay = await this.jobs.logs(jobId, String(cursor), REPLAY_LIMIT);
      for (const row of replay) {
        emit({ id: Number(row.id), payload: JSON.stringify(logPayload(row)) });
      }
      if (replay.length === REPLAY_LIMIT) {
        // The client is told the replay was truncated, so it can reload the page rather than
        // assume it has the whole history.
        writer.write(
          `event: truncated\ndata: ${JSON.stringify({ replayLimit: REPLAY_LIMIT })}\n\n`,
        );
      }

      live = true;
      for (const entry of pending) emit(entry);
      pending.length = 0;

      // 3. Re-check after the replay: the job may have finished while we were catching up.
      const job = await this.jobs.get(jobId);
      if (isTerminalJobState(job.state)) {
        writer.write(`data: ${JSON.stringify({ state: job.state, terminal: true })}\n\n`);
        cleanup();
        return;
      }

      timers.push(setInterval(() => writer.write(': heartbeat\n\n'), HEARTBEAT_MS));
      timers.push(
        setInterval(() => {
          void this.jobs
            .get(jobId)
            .then((current) => {
              if (!isTerminalJobState(current.state)) return;
              writer.write(`data: ${JSON.stringify({ state: current.state, terminal: true })}\n\n`);
              cleanup();
            })
            .catch((error: unknown) => {
              this.logger.warn(
                { jobId, err: error instanceof Error ? error.message : String(error) },
                'closing job stream: state poll failed',
              );
              cleanup();
            });
        }, STATE_POLL_MS),
      );

      // Mirrors the metric of a dropped client into the log once; the client reconnects with
      // Last-Event-ID, so a dropped connection is a latency event, not a data-loss event.
      raw.on('close', () => this.logger.debug({ jobId }, 'job stream closed'));
    } catch (error) {
      cleanup();
      // The response is already committed, so this is a log line, not a status code.
      this.logger.warn(
        { jobId, err: error instanceof Error ? error.message : String(error) },
        'job stream closed after an error',
      );
      return;
    }

    this.logger.debug({ jobId, state: initial.state }, 'job stream open');
  }
}

function parseEntry(payload: string): { id: number; payload: string } | undefined {
  try {
    const parsed = JSON.parse(payload) as { id?: unknown };
    const id = Number(parsed.id);
    return Number.isFinite(id) ? { id, payload } : undefined;
  } catch {
    return undefined;
  }
}

function logPayload(row: {
  seq: number;
  ts: Date;
  stream: string;
  line: string;
}): Record<string, unknown> {
  return { seq: row.seq, ts: row.ts.toISOString(), stream: row.stream, line: row.line };
}

/**
 * `ServerResponse.write` returning false means the socket buffer is full. The first version
 * ignored that return value, so a slow reader grew the process heap without bound.
 */
class SseWriter {
  private readonly queue: string[] = [];
  private blocked = false;
  private ended = false;

  constructor(private readonly raw: FastifyReply['raw']) {
    raw.on('drain', () => {
      this.blocked = false;
      this.flush();
    });
  }

  write(chunk: string): void {
    if (this.ended) return;
    if (this.blocked) {
      this.queue.push(chunk);
      return;
    }
    if (!this.raw.write(chunk)) this.blocked = true;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.queue.length = 0;
    if (!this.raw.writableEnded) this.raw.end();
  }

  private flush(): void {
    while (!this.blocked && this.queue.length > 0 && !this.ended) {
      const chunk = this.queue.shift();
      if (chunk === undefined) return;
      if (!this.raw.write(chunk)) this.blocked = true;
    }
  }
}
