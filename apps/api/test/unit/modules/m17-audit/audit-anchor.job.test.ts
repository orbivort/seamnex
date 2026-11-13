import { describe, expect, it, vi } from 'vitest';
import { AuditAnchorJob, startOfUtcDay } from '../../../../src/modules/m17-audit/audit-anchor.job';

describe('startOfUtcDay', () => {
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
});

describe('AuditAnchorJob', () => {
  it('anchors the exclusive day boundary and logs the day', async () => {
    const anchor = vi.fn().mockResolvedValue(undefined);
    const job = new AuditAnchorJob({ anchor } as never);
    const day = new Date('2026-05-06T00:00:00.000Z');

    await job.run(day);

    expect(anchor).toHaveBeenCalledWith(day);
  });

  it('defaults to the start of today in UTC', async () => {
    const anchor = vi.fn().mockResolvedValue(undefined);
    await new AuditAnchorJob({ anchor } as never).run();

    const day = anchor.mock.calls[0]?.[0] as Date;
    expect(day.toISOString()).toBe(startOfUtcDay(new Date()).toISOString());
  });

  it('propagates an audit failure, because a silent anchor is a broken chain', async () => {
    const job = new AuditAnchorJob({
      anchor: vi.fn().mockRejectedValue(new Error('chain locked')),
    } as never);

    await expect(job.run(new Date())).rejects.toThrow('chain locked');
  });
});
