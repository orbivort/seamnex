import { describe, expect, it, vi } from 'vitest';
import {
  AuditAnchorJob,
  lastClosedUtcDay,
  startOfUtcDay,
} from '../../../../src/modules/m17-audit/audit-anchor.job';

const ANCHOR = {
  day: '2026-05-05',
  lastSeq: '42',
  lastHash: 'h42',
  signature: 'ed25519:key:c2ln',
  storedAt: '2026-05-06T00:01:00.000Z',
};

function setup(
  options: {
    anchor?: ReturnType<typeof vi.fn>;
    exportAnchors?: ReturnType<typeof vi.fn>;
    append?: ReturnType<typeof vi.fn>;
    put?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const audit = {
    anchor: vi.fn().mockResolvedValue(ANCHOR),
    exportAnchors: vi.fn().mockResolvedValue({
      anchors: [ANCHOR],
      signing: { algorithm: 'ed25519', keyId: 'key', publicKey: 'pem' },
      chainHead: { seq: '42', hash: 'h42', ts: '2026-05-05T23:59:00.000Z' },
    }),
    append: vi.fn().mockResolvedValue({ seq: '43', hash: 'h43' }),
    ...options,
  };
  const store = {
    put: vi.fn().mockResolvedValue('audit-anchors/2026-05-05.json'),
    keyFor: (day: string) => `audit-anchors/${day}.json`,
    ...options,
  };
  return { audit, store, job: new AuditAnchorJob(audit as never, store as never) };
}

describe('utc day helpers', () => {
  it('truncates to midnight UTC', () => {
    expect(startOfUtcDay(new Date('2026-03-04T17:45:12.345Z')).toISOString()).toBe(
      '2026-03-04T00:00:00.000Z',
    );
  });

  it('is idempotent', () => {
    const day = new Date('2026-03-04T00:00:00.000Z');
    expect(startOfUtcDay(day).toISOString()).toBe(day.toISOString());
  });

  it('uses the UTC day even when the local date differs', () => {
    // 00:30 UTC is still the previous local day in the Americas; the anchor follows UTC.
    expect(startOfUtcDay(new Date('2026-01-01T00:30:00.000Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('names the day that has fully elapsed, never the one in progress', () => {
    expect(lastClosedUtcDay(new Date('2026-05-06T00:00:30.000Z')).toISOString()).toBe(
      '2026-05-05T00:00:00.000Z',
    );
  });
});

describe('AuditAnchorJob', () => {
  it('anchors the day that just closed and copies it off-host', async () => {
    const { audit, store, job } = setup();
    const day = new Date('2026-05-05T00:00:00.000Z');

    await expect(job.run(day)).resolves.toEqual(ANCHOR);

    expect(audit.anchor).toHaveBeenCalledWith(day);
    expect(store.put).toHaveBeenCalledWith(ANCHOR, expect.objectContaining({ keyId: 'key' }), {
      seq: '42',
      hash: 'h42',
      ts: '2026-05-05T23:59:00.000Z',
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'audit.anchor.recorded',
        detail: expect.objectContaining({ offHostKey: 'audit-anchors/2026-05-05.json' }),
      }),
    );
  });

  it('defaults to the last closed day, not to the day in progress', async () => {
    const { audit, job } = setup();
    await job.run();

    const day = audit.anchor.mock.calls[0]?.[0] as Date;
    expect(day.toISOString()).toBe(lastClosedUtcDay(new Date()).toISOString());
  });

  it('does nothing when the day has no events', async () => {
    const { audit, store, job } = setup({ anchor: vi.fn().mockResolvedValue(null) });

    await expect(job.run(new Date('2026-05-05T00:00:00.000Z'))).resolves.toBeNull();
    expect(store.put).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  /**
   * NFR-4.10: an anchor that never left the host is not evidence. The failure is recorded in the
   * chain and rethrown, so the scheduler retries on the next pass instead of marking the day done.
   */
  it('records and rethrows an off-host failure, so the copy is retried', async () => {
    const { audit, store, job } = setup({
      put: vi.fn().mockRejectedValue(new Error('S3 is down')),
    });

    await expect(job.run(new Date('2026-05-05T00:00:00.000Z'))).rejects.toThrow('S3 is down');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'audit.anchor.offhost_failed',
        outcome: 'failure',
        detail: expect.objectContaining({ reason: 'S3 is down' }),
      }),
    );
    expect(audit.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'audit.anchor.recorded' }),
    );
    expect(store.put).toHaveBeenCalled();
  });

  it('reports a repeated failure once per day rather than once per pass', async () => {
    const put = vi.fn().mockRejectedValue(new Error('S3 is down'));
    const { audit, job } = setup({ put });

    await expect(job.run(new Date('2026-05-05T00:00:00.000Z'))).rejects.toThrow();
    await expect(job.run(new Date('2026-05-05T00:00:00.000Z'))).rejects.toThrow();

    expect(
      audit.append.mock.calls.filter(
        (call) => (call[0] as { action: string }).action === 'audit.anchor.offhost_failed',
      ),
    ).toHaveLength(1);
  });

  it('propagates an audit failure, because a silent anchor is a broken chain', async () => {
    const { job } = setup({ anchor: vi.fn().mockRejectedValue(new Error('chain locked')) });

    await expect(job.run(new Date('2026-05-05T00:00:00.000Z'))).rejects.toThrow('chain locked');
  });

  it('records a legacy unsigned anchor as unsigned rather than implying it was signed', async () => {
    const { audit, job } = setup({
      anchor: vi.fn().mockResolvedValue({ ...ANCHOR, signature: null }),
    });

    await job.run(new Date('2026-05-05T00:00:00.000Z'));

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'audit.anchor.recorded',
        detail: expect.objectContaining({ signed: false }),
      }),
    );
  });

  it('quotes a non-Error failure and never fails the pass from its own report', async () => {
    const { audit, job } = setup({
      put: vi.fn().mockRejectedValue('S3 is down'),
      // The report itself cannot be written: the log line in `run` is then the only trace.
      append: vi.fn().mockRejectedValue(new Error('chain locked')),
    });

    await expect(job.run(new Date('2026-05-05T00:00:00.000Z'))).rejects.toBe('S3 is down');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'audit.anchor.offhost_failed',
        detail: expect.objectContaining({ reason: 'S3 is down' }),
      }),
    );
  });

  it('does not retry the copy because its own receipt could not be appended', async () => {
    const { job } = setup({ append: vi.fn().mockRejectedValue(new Error('chain locked')) });

    // The object is already off-host; failing the pass would rewrite it every tick for the rest of
    // the day without improving the evidence.
    await expect(job.run(new Date('2026-05-05T00:00:00.000Z'))).resolves.toEqual(ANCHOR);
  });

  it('quotes a non-Error receipt failure without failing the pass', async () => {
    const { job } = setup({ append: vi.fn().mockRejectedValue('chain locked') });

    await expect(job.run(new Date('2026-05-05T00:00:00.000Z'))).resolves.toEqual(ANCHOR);
  });
});
