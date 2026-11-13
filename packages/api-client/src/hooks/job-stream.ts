import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { JobLogLineSchema, JobSchema, type JobLogLine, type JobState } from '@seamnex/domain';
import { openEventStream } from '../http';
import { queryKeys } from '../query-keys';

/**
 * `/jobs/:id/stream` is a server-sent event stream with three frame shapes (see
 * `apps/api/src/jobs/job-stream.ts`):
 *
 * ```text
 * id: 42
 * data: {"seq":42,"ts":"…","stream":"stdout","line":"…"}   ← one log line, unnamed event
 *
 * data: {"state":"succeeded","terminal":true}               ← terminal state, unnamed event
 *
 * event: truncated
 * data: {"replayLimit":1000}                                ← replay was longer than the buffer
 * ```
 *
 * The mock platform names its frames (`event: job` / `event: log`) because that was the prototype
 * protocol. Both are decoded here: the screen must render the same thing whether it is talking to
 * MSW or to the real API, and an unnamed frame must never be silently dropped.
 */
export type JobStreamEvent =
  | { kind: 'log'; line: JobLogLine }
  | { kind: 'job'; job: unknown }
  | { kind: 'terminal'; state: JobState }
  | { kind: 'truncated'; replayLimit: number };

export type DecodedFrame = { id: string | null; event: JobStreamEvent | null };

const TERMINAL_STATES: readonly JobState[] = ['succeeded', 'failed', 'cancelled'];

export function decodeJobStreamFrame(raw: string): DecodedFrame {
  let name = '';
  let id: string | null = null;
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    // A comment (`: heartbeat`) carries no data; it only keeps the connection alive.
    if (line.startsWith(':')) continue;
    if (line.startsWith('id:')) {
      const value = line.slice(3).trim();
      if (value.length > 0) id = value;
      continue;
    }
    if (line.startsWith('event:')) {
      name = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }

  if (data.length === 0) return { id, event: null };

  let payload: unknown;
  try {
    payload = JSON.parse(data.join('\n'));
  } catch {
    return { id, event: null };
  }

  if (name === 'truncated') {
    const limit = (payload as { replayLimit?: unknown }).replayLimit;
    return { id, event: { kind: 'truncated', replayLimit: typeof limit === 'number' ? limit : 0 } };
  }

  if (name === 'log') {
    const parsed = JobLogLineSchema.safeParse(payload);
    return { id, event: parsed.success ? { kind: 'log', line: parsed.data } : null };
  }

  if (name === 'job') {
    const parsed = JobSchema.safeParse(payload);
    if (parsed.success) return { id, event: { kind: 'job', job: parsed.data } };
    return { id, event: null };
  }

  // Unnamed frames: discriminate on the payload, which is all the backend sends.
  const logLine = JobLogLineSchema.safeParse(payload);
  if (logLine.success) return { id, event: { kind: 'log', line: logLine.data } };

  const terminal = payload as { state?: unknown; terminal?: unknown };
  if (terminal.terminal === true && typeof terminal.state === 'string') {
    return { id, event: { kind: 'terminal', state: terminal.state as JobState } };
  }

  const job = JobSchema.safeParse(payload);
  if (job.success) return { id, event: { kind: 'job', job: job.data } };

  return { id, event: null };
}

/** Splits a text buffer into complete frames, keeping the trailing partial frame for the next read. */
export function takeFrames(buffer: string): { frames: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts, rest };
}

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 6;
/** Decoded lines are gathered for this long before one cache write. */
const FLUSH_INTERVAL_MS = 100;
/**
 * Retained lines. The server keeps the job's full output for its retention window; the panel
 * needs enough context to see what just happened, and an unbounded array grew for the life of
 * the tab — one copy per frame, one DOM node per line.
 */
export const MAX_LOG_LINES = 500;

/**
 * Union of two log slices, ordered by sequence and deduplicated by it.
 *
 * Two subscribers replaying the same job produce overlapping batches; the second one must not
 * double every line already on screen. Sequence is the identity of a line — the server numbers
 * them, and a resumed stream repeats the ones it re-sends.
 */
export function mergeBySeq(
  existing: readonly JobLogLine[],
  batch: readonly JobLogLine[],
): JobLogLine[] {
  if (batch.length === 0) return existing as JobLogLine[];
  const bySeq = new Map<number, JobLogLine>();
  for (const line of existing) bySeq.set(line.seq, line);
  for (const line of batch) if (!bySeq.has(line.seq)) bySeq.set(line.seq, line);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/**
 * Subscribes to `/jobs/:id/stream` and writes frames into the query cache.
 *
 * This is an enhancement, not the source of truth: if the stream cannot be opened or drops, the
 * polling queries behind `useJob` keep the screen correct. A dropped connection resumes from
 * `Last-Event-ID` so the log is not replayed from the beginning; a terminal frame stops the loop
 * and invalidates the job so the polling query settles on the final state.
 *
 * Writes are batched rather than applied per frame. A chatty container emits several lines a
 * second, and each one used to cost an O(n) duplicate scan plus an O(n) array copy on the main
 * thread — the cost grew with the length of the log, on the one screen that must stay live.
 */
export function useJobStream(id: string, enabled: boolean): void {
  const client = useQueryClient();

  useEffect(() => {
    if (!enabled || id.length === 0) return;

    const controller = new AbortController();
    let cancelled = false;

    // Resume from what the cache already holds, so a re-subscription does not re-append lines.
    const cached = client.getQueryData<JobLogLine[]>(queryKeys.jobLogs(id));
    let lastSeq =
      cached === undefined || cached.length === 0 ? 0 : (cached[cached.length - 1]?.seq ?? 0);
    let pending: JobLogLine[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      client.setQueryData<JobLogLine[]>(queryKeys.jobLogs(id), (current) => {
        const lines = current ?? [];
        /*
         * Dedupe against the cache, not only against this subscription's `lastSeq`.
         *
         * More than one subscriber can follow the same job — the instance drawer and the job
         * screen both mount this hook — and each opens its own stream, which replays from the
         * beginning. With a per-subscription cursor, the second connection re-appended every line
         * the first had already written and each log line rendered twice.
         *
         * The common case is a batch strictly ahead of what is stored, which stays one concat. An
         * overlapping batch is merged by sequence instead, so a gap is never left behind whichever
         * connection writes first.
         */
        const tail = lines.length === 0 ? 0 : (lines[lines.length - 1]?.seq ?? 0);
        const firstSeq = batch[0]?.seq ?? 0;
        const next = firstSeq > tail ? lines.concat(batch) : mergeBySeq(lines, batch);
        return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
      });
    };

    const scheduleFlush = (): void => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    };

    const apply = (event: JobStreamEvent): boolean => {
      if (event.kind === 'log') {
        // O(1) duplicate check. The stream resumes from `Last-Event-ID`, so a resumed frame can
        // repeat a line the cache already holds.
        if (event.line.seq <= lastSeq) return false;
        lastSeq = event.line.seq;
        pending.push(event.line);
        scheduleFlush();
        return false;
      }
      if (event.kind === 'job') {
        client.setQueryData(queryKeys.job(id), event.job);
        return false;
      }
      if (event.kind === 'truncated') {
        // The replay was clipped, so the cache is no longer the whole story: drop what is held
        // and let the query refetch instead of appending onto a gap.
        flush();
        void client.invalidateQueries({ queryKey: queryKeys.jobLogs(id) });
        return false;
      }
      // Terminal: the server stops writing after this frame, so nothing may stay buffered.
      flush();
      void client.invalidateQueries({ queryKey: queryKeys.job(id) });
      void client.invalidateQueries({ queryKey: queryKeys.jobLogs(id) });
      return TERMINAL_STATES.includes(event.state);
    };

    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    const run = async (): Promise<void> => {
      let lastEventId: string | null = null;
      let attempt = 0;

      while (!cancelled && attempt < MAX_RETRIES) {
        try {
          const response = await openEventStream(
            `/jobs/${id}/stream`,
            controller.signal,
            lastEventId === null ? {} : { 'Last-Event-ID': lastEventId },
          );
          const reader = response.body?.getReader();
          if (!reader) return;

          const decoder = new TextDecoder();
          let buffer = '';
          let terminal = false;

          while (!cancelled && !terminal) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { frames, rest } = takeFrames(buffer);
            buffer = rest;
            for (const frame of frames) {
              const decoded = decodeJobStreamFrame(frame);
              if (decoded.id !== null) lastEventId = decoded.id;
              if (decoded.event === null) continue;
              attempt = 0;
              terminal = apply(decoded.event) || terminal;
            }
          }

          if (terminal || cancelled) return;
          // The server closed a stream that is not finished (replica restart, idle timeout).
          attempt += 1;
          await wait(RETRY_DELAY_MS);
        } catch {
          if (cancelled) return;
          // Stream unavailable: polling remains authoritative. Retry a bounded number of times.
          attempt += 1;
          await wait(RETRY_DELAY_MS);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      controller.abort();
      if (flushTimer !== null) clearTimeout(flushTimer);
    };
  }, [client, enabled, id]);
}
