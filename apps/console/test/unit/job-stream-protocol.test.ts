import { describe, expect, it } from 'vitest';
import type { JobLogLine } from '@seamnex/domain';
import { decodeJobStreamFrame, mergeBySeq, takeFrames } from '@seamnex/api-client';

/**
 * `/jobs/:id/stream` is consumed by the console, produced by two different servers: MSW in mock
 * mode (named `job`/`log` frames) and the real API (unnamed `data:` frames plus a terminal marker).
 * This test pins both wire formats, because a decoder that only understands one of them renders a
 * live job console that never moves.
 */
describe('job stream frame protocol', () => {
  it('decodes an unnamed log frame from the real API', () => {
    const frame = [
      'id: 42',
      'data: {"seq":42,"ts":"2026-10-24T09:00:00.000Z","stream":"stdout","line":"applying plan"}',
    ].join('\n');

    const decoded = decodeJobStreamFrame(frame);

    expect(decoded.id).toBe('42');
    expect(decoded.event).toEqual({
      kind: 'log',
      line: { seq: 42, ts: '2026-10-24T09:00:00.000Z', stream: 'stdout', line: 'applying plan' },
    });
  });

  it('decodes the terminal marker and stops the caller', () => {
    const decoded = decodeJobStreamFrame('data: {"state":"succeeded","terminal":true}');

    expect(decoded.event).toEqual({ kind: 'terminal', state: 'succeeded' });
  });

  it('decodes the named frames the mock platform sends', () => {
    const job = {
      id: 'job-3001',
      kind: 'backup',
      instanceId: null,
      entryKey: 'D01-01',
      label: 'Backup D01-01 EspoCRM',
      state: 'running',
      progress: 40,
      createdAt: '2026-10-24T09:00:00.000Z',
      startedAt: '2026-10-24T09:00:01.000Z',
      finishedAt: null,
      requestedBy: 'Sofia Almeida',
      summary: 'On-demand backup.',
      errorCode: null,
      errorMessage: null,
      steps: [],
    };

    expect(decodeJobStreamFrame(`event: job\ndata: ${JSON.stringify(job)}`).event).toEqual({
      kind: 'job',
      job,
    });
    expect(
      decodeJobStreamFrame(
        'event: log\ndata: {"seq":1,"ts":"2026-10-24T09:00:00.000Z","stream":"system","line":"queued"}',
      ).event,
    ).toEqual({
      kind: 'log',
      line: { seq: 1, ts: '2026-10-24T09:00:00.000Z', stream: 'system', line: 'queued' },
    });
  });

  it('reports a truncated replay instead of pretending the log is complete', () => {
    const decoded = decodeJobStreamFrame('event: truncated\ndata: {"replayLimit":1000}');

    expect(decoded.event).toEqual({ kind: 'truncated', replayLimit: 1000 });
  });

  it('ignores heartbeats, the open comment and malformed data', () => {
    expect(decodeJobStreamFrame(': heartbeat').event).toBeNull();
    expect(decodeJobStreamFrame(': stream open').event).toBeNull();
    expect(decodeJobStreamFrame('data: not-json').event).toBeNull();
    expect(decodeJobStreamFrame('data: {"unknown":true}').event).toBeNull();
  });

  /**
   * Two surfaces can follow one job at the same time (the instance drawer and the job screen),
   * and each stream replays from the beginning. The writer must union by sequence; a per-stream
   * cursor rendered every replayed line twice.
   */
  it('merges an overlapping replay without duplicating or reordering lines', () => {
    const line = (seq: number): JobLogLine => ({
      seq,
      ts: '2026-10-24T09:00:00.000Z',
      stream: 'stdout',
      line: `line ${seq}`,
    });
    const cached = [line(0), line(1), line(2)];

    expect(mergeBySeq(cached, [line(0), line(1), line(2), line(3)]).map((l) => l.line)).toEqual([
      'line 0',
      'line 1',
      'line 2',
      'line 3',
    ]);
    // A batch that arrives before the cached slice fills the gap instead of being dropped.
    expect(mergeBySeq([line(2), line(3)], [line(0), line(1)]).map((l) => l.seq)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(mergeBySeq(cached, [])).toHaveLength(3);
  });

  it('splits complete frames and keeps the partial tail', () => {
    const buffer =
      'data: {"state":"running","terminal":false}\n\nid: 7\ndata: {"seq":7,"ts":"2026-10-24T09:00:02.000Z","stream":"stdout","line":"half';

    const { frames, rest } = takeFrames(buffer);

    expect(frames).toHaveLength(1);
    expect(rest).toContain('"seq":7');
  });

  it('accepts CRLF frame separators', () => {
    const { frames } = takeFrames('data: {"state":"running","terminal":false}\r\n\r\n');

    expect(frames).toHaveLength(1);
    expect(decodeJobStreamFrame(frames[0] ?? '').event).toBeNull();
  });
});
