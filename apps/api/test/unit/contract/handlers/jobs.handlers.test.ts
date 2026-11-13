import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobHandlers } from '../../../../src/contract/handlers/jobs.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { AppError } from '../../../../src/common/problem/app-error';
import { callHandler, operationInput } from '../../../support/operation-input';

const JOB_ID = '018f0000-0000-4000-8000-000000000000';

let s: ReturnType<typeof services>;
let handlers: ReadonlyMap<string, OperationHandler>;

function services() {
  return {
    jobs: {
      logs: vi.fn().mockResolvedValue([
        {
          seq: '7',
          ts: new Date('2026-01-01T00:00:00.000Z'),
          stream: 'stdout',
          line: 'started',
        },
      ]),
      cancel: vi.fn().mockResolvedValue({ id: JOB_ID }),
      retry: vi.fn().mockResolvedValue({ job: { id: 'new-job' } }),
    },
    query: {
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }),
      detail: vi.fn().mockResolvedValue({ id: JOB_ID }),
    },
    streams: { open: vi.fn().mockResolvedValue(undefined) },
  };
}

beforeEach(() => {
  s = services();
  handlers = new JobHandlers(s.jobs as never, s.query as never, s.streams as never).handlers();
});

const call = (key: string, overrides = {}) =>
  callHandler(handlers, key, operationInput(key, overrides));

describe('GET /jobs', () => {
  it('forwards no filter keys when the query is empty', async () => {
    await call('GET /jobs');
    expect(s.query.list).toHaveBeenCalledWith({});
  });

  it('forwards every declared filter that is present', async () => {
    await call('GET /jobs', {
      query: {
        instanceId: 'i1',
        kind: 'deploy',
        state: 'running',
        cursor: 'abc',
        limit: '10',
      },
    });

    expect(s.query.list).toHaveBeenCalledWith({
      instanceId: 'i1',
      kind: 'deploy',
      state: 'running',
      cursor: 'abc',
      limit: '10',
    });
  });
});

describe('job detail', () => {
  it('returns the projected job', async () => {
    const result = await call('GET /jobs/:id', { params: { id: JOB_ID } });
    expect(s.query.detail).toHaveBeenCalledWith(JOB_ID);
    expect(result).toEqual({ kind: 'body', body: { id: JOB_ID } });
  });

  it('refuses an id that is not a uuid before querying', async () => {
    await expect(call('GET /jobs/:id', { params: { id: 'not-a-uuid' } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(s.query.detail).not.toHaveBeenCalled();
  });

  it('refuses a missing id', async () => {
    await expect(call('GET /jobs/:id')).rejects.toBeInstanceOf(AppError);
  });
});

describe('GET /jobs/:id/logs', () => {
  it('projects log rows into the wire shape', async () => {
    const result = await call('GET /jobs/:id/logs', { params: { id: JOB_ID } });

    expect(s.jobs.logs).toHaveBeenCalledWith(JOB_ID, '0', 500);
    expect(result).toEqual({
      kind: 'body',
      body: [{ seq: 7, ts: '2026-01-01T00:00:00.000Z', stream: 'stdout', line: 'started' }],
    });
  });

  it('refuses an invalid id', async () => {
    await expect(call('GET /jobs/:id/logs', { params: { id: '../etc' } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('POST /jobs/:id/cancel', () => {
  it('cancels as the caller and answers with the refreshed detail', async () => {
    const result = await call('POST /jobs/:id/cancel', { params: { id: JOB_ID } });

    expect(s.jobs.cancel).toHaveBeenCalledWith(JOB_ID, 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: JOB_ID } });
  });

  it('refuses an invalid id', async () => {
    await expect(call('POST /jobs/:id/cancel', { params: { id: 'x' } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(s.jobs.cancel).not.toHaveBeenCalled();
  });
});

describe('POST /jobs/:id/retry', () => {
  it('answers 202 with the new job id', async () => {
    const result = await call('POST /jobs/:id/retry', { params: { id: JOB_ID } });

    expect(s.jobs.retry).toHaveBeenCalledWith(JOB_ID, 'sub-1');
    expect(result).toEqual({ kind: 'accepted', jobId: 'new-job' });
  });

  it('refuses an invalid id', async () => {
    await expect(call('POST /jobs/:id/retry', { params: { id: 'x' } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('GET /jobs/:id/stream', () => {
  it('opens the stream with the single last-event-id and reports stream ownership', async () => {
    const result = await call('GET /jobs/:id/stream', {
      params: { id: JOB_ID },
      headers: { 'last-event-id': '42' },
    });

    expect(s.streams.open).toHaveBeenCalledWith(expect.anything(), JOB_ID, '42', 'rid-test');
    expect(result).toEqual({ kind: 'stream' });
  });

  it('takes the first value of a repeated last-event-id', async () => {
    await call('GET /jobs/:id/stream', {
      params: { id: JOB_ID },
      headers: { 'last-event-id': ['7', '8'] },
    });
    expect(s.streams.open).toHaveBeenCalledWith(expect.anything(), JOB_ID, '7', 'rid-test');
  });

  it('passes undefined when there is no resume header', async () => {
    await call('GET /jobs/:id/stream', { params: { id: JOB_ID } });
    expect(s.streams.open.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('refuses an invalid id before hijacking the reply', async () => {
    await expect(
      call('GET /jobs/:id/stream', { params: { id: 'not-a-job' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.streams.open).not.toHaveBeenCalled();
  });
});

describe('job handler registry', () => {
  it('implements the six job operations', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'GET /jobs',
      'GET /jobs/:id',
      'GET /jobs/:id/logs',
      'GET /jobs/:id/stream',
      'POST /jobs/:id/cancel',
      'POST /jobs/:id/retry',
    ]);
  });
});
