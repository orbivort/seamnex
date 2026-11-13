import { describe, expect, it, vi } from 'vitest';
import type { OutboxRow } from '@seamnex/db';
import { OutboxService } from '../../../../src/modules/m17-audit/outbox';
import { fakeDb, type Row } from '../../../support/fakes';

function outboxRow(overrides: Row = {}): Row {
  return {
    id: '1',
    aggregate_type: 'job',
    aggregate_id: 'job-1',
    event_type: 'job.succeeded',
    payload: {},
    created_at: new Date(),
    claimed_at: new Date(),
    dispatched_at: null,
    attempts: 1,
    last_error: null,
    ...overrides,
  };
}

function metrics() {
  return { outboxDispatched: { labels: vi.fn(() => ({ inc: vi.fn() })) } };
}

describe('OutboxService.emit', () => {
  it('writes the event inside the caller transaction', async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const service = new OutboxService(fakeDb().pool, metrics() as never);

    await service.emit(tx as never, {
      aggregateType: 'job',
      aggregateId: 'job-1',
      eventType: 'job.succeeded',
    });

    expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO outbox'), [
      'job',
      'job-1',
      'job.succeeded',
      '{}',
    ]);
  });

  it('serialises the payload when one is supplied', async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await new OutboxService(fakeDb().pool, metrics() as never).emit(tx as never, {
      aggregateType: 'job',
      aggregateId: 'job-1',
      eventType: 'job.failed',
      payload: { code: 'X' },
    });

    expect(tx.query.mock.calls[0]?.[1]?.[3]).toBe('{"code":"X"}');
  });
});

describe('OutboxService.claim', () => {
  it('claims with the bounded attempt count and the reclaim window', async () => {
    const fake = fakeDb([['UPDATE outbox', [outboxRow()]]]);
    const rows = await new OutboxService(fake.pool, metrics() as never).claim(10);

    expect(rows).toHaveLength(1);
    expect(fake.calls[0]?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(fake.calls[0]?.params).toEqual([10, 5, String(5 * 60 * 1000)]);
  });

  it('defaults to a batch of fifty', async () => {
    const fake = fakeDb([['UPDATE outbox', []]]);
    await new OutboxService(fake.pool, metrics() as never).claim();
    expect(fake.calls[0]?.params?.[0]).toBe(50);
  });
});

describe('OutboxService.dispatchBatch', () => {
  it('runs every handler registered for the event type and marks the row dispatched', async () => {
    const fake = fakeDb([
      ['SET claimed_at = now(), attempts', [outboxRow()]],
      ['UPDATE outbox SET dispatched_at', []],
    ]);
    const dispatched = metrics();
    const service = new OutboxService(fake.pool, dispatched as never);
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    service.on('job.succeeded', first);
    service.on('job.succeeded', second);

    const count = await service.dispatchBatch(10);

    expect(count).toBe(1);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(dispatched.outboxDispatched.labels).toHaveBeenCalledWith('job.succeeded');
    expect(fake.calls.some((call) => call.sql.includes('SET dispatched_at'))).toBe(true);
  });

  it('dispatches a row with no handler, because the event is still delivered', async () => {
    const fake = fakeDb([
      ['SET claimed_at = now(), attempts', [outboxRow({ event_type: 'unheard' })]],
      ['UPDATE outbox SET dispatched_at', []],
    ]);
    const count = await new OutboxService(fake.pool, metrics() as never).dispatchBatch();
    expect(count).toBe(1);
  });

  it('records the failure, keeps the batch going and does not count the row', async () => {
    const fake = fakeDb([
      ['SET claimed_at = now(), attempts', [outboxRow({ id: '1' }), outboxRow({ id: '2' })]],
      ['UPDATE outbox SET last_error', []],
      ['UPDATE outbox SET dispatched_at', []],
    ]);
    const service = new OutboxService(fake.pool, metrics() as never);
    service.on('job.succeeded', vi.fn().mockRejectedValue(new Error('n8n down')));

    const count = await service.dispatchBatch();

    expect(count).toBe(0);
    const failure = fake.calls.find((call) => call.sql.includes('SET last_error'));
    expect(failure?.params).toEqual(['1', 'n8n down']);
  });

  it('truncates a long failure message to what the column holds', async () => {
    const fake = fakeDb([
      ['SET claimed_at = now(), attempts', [outboxRow()]],
      ['UPDATE outbox SET last_error', []],
      ['UPDATE outbox SET dispatched_at', []],
    ]);
    const service = new OutboxService(fake.pool, metrics() as never);
    service.on('job.succeeded', vi.fn().mockRejectedValue(new Error('x'.repeat(800))));

    await service.dispatchBatch();

    const failure = fake.calls.find((call) => call.sql.includes('SET last_error'));
    expect(String(failure?.params?.[1]).length).toBe(500);
  });

  it('stringifies a non-Error handler failure', async () => {
    const fake = fakeDb([
      ['SET claimed_at = now(), attempts', [outboxRow()]],
      ['UPDATE outbox SET last_error', []],
      ['UPDATE outbox SET dispatched_at', []],
    ]);
    const service = new OutboxService(fake.pool, metrics() as never);
    service.on('job.succeeded', vi.fn().mockRejectedValue('nope'));

    await service.dispatchBatch();

    const failure = fake.calls.find((call) => call.sql.includes('SET last_error'));
    expect(failure?.params?.[1]).toBe('nope');
  });

  it('dispatches nothing when nothing is claimable', async () => {
    const fake = fakeDb([['UPDATE outbox', []]]);
    expect(await new OutboxService(fake.pool, metrics() as never).dispatchBatch()).toBe(0);
  });

  it('passes the claimed row to the handler', async () => {
    const fake = fakeDb([
      ['SET claimed_at = now(), attempts', [outboxRow()]],
      ['UPDATE outbox SET dispatched_at', []],
    ]);
    const service = new OutboxService(fake.pool, metrics() as never);
    const handler = vi.fn().mockResolvedValue(undefined);
    service.on('job.succeeded', handler);

    await service.dispatchBatch();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining<Partial<OutboxRow>>({ id: '1' }));
  });
});
