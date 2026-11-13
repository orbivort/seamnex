import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { AuditQueryService } from '../../../../src/modules/m17-audit/audit-query.service';

/**
 * The audit read surface. Three details are load-bearing and each was a bug once: an action filter
 * matches a namespace prefix without treating the caller's text as a LIKE pattern, the page is
 * keyed on `audit_event.seq` rather than the text output column, and an export upper bound covers
 * its whole millisecond (a truncated `to` silently dropped the newest row).
 */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: '10',
    id: 'evt-10',
    ts: new Date('2026-01-02T03:04:05.678Z'),
    actor_type: 'user',
    actor_id: 'user-1',
    action: 'auth.session.created',
    target_type: 'session',
    target_id: 'sess-1',
    outcome: 'success',
    detail: { subjectRef: 'uuid-1' },
    prev_hash: 'h9',
    hash: 'h10',
    ...overrides,
  };
}

function setup(
  routes: Parameters<typeof fakeDb>[0] = [],
  verify: { valid: boolean; checked: number; firstBrokenSeq: string | null } = {
    valid: true,
    checked: 1,
    firstBrokenSeq: null,
  },
) {
  const db = fakeDb(routes);
  const audit = {
    verify: vi.fn(async () => verify),
    append: vi.fn(),
    lockChain: vi.fn(),
    denied: vi.fn(),
  };
  const service = new AuditQueryService(db.pool, audit as never);
  return { db, audit, service };
}

describe('page', () => {
  it('applies every filter to both the page and the count, and returns a cursor', async () => {
    const { db, service } = setup([
      ['SELECT count(*)', [{ count: '57' }]],
      [
        'ORDER BY audit_event.seq DESC',
        { rows: [row({ seq: '3' }), row({ seq: '2' })], rowCount: 2 },
      ],
    ]);

    const result = await service.page({
      action: 'auth',
      outcome: 'success',
      actor: 'user',
      target: 'session',
      cursor: '42',
      limit: '1',
    });

    const page = db.calls.find((call) => call.sql.includes('ORDER BY audit_event.seq DESC'));
    expect(page?.sql).toContain('starts_with(action,');
    expect(page?.sql).toContain('outcome = $');
    expect(page?.sql).toContain('actor_id ILIKE');
    expect(page?.sql).toContain('target_id ILIKE');
    expect(page?.sql).toContain('seq < $');
    expect(page?.sql).toContain('ORDER BY audit_event.seq DESC');
    expect(page?.params).toEqual(['auth', 'success', '%user%', '%session%', '42', 2]);

    // One row over the limit is fetched to know whether a next page exists.
    expect(result.nextCursor).toBe('3');
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(57);
  });

  it('omits the WHERE clause when nothing is filtered', async () => {
    const { db, service } = setup([
      ['SELECT count(*)', [{ count: '1' }]],
      ['ORDER BY audit_event.seq DESC', { rows: [row()], rowCount: 1 }],
    ]);

    const result = await service.page({});

    expect(db.calls[0]?.sql).not.toContain('WHERE');
    expect(result.nextCursor).toBeNull();
  });

  it('ignores an empty filter value and a non-numeric cursor', async () => {
    const { db, service } = setup([
      ['SELECT count(*)', []],
      ['ORDER BY audit_event.seq DESC', { rows: [], rowCount: 0 }],
    ]);

    const result = await service.page({
      action: '',
      outcome: '',
      actor: '',
      target: '',
      cursor: 'abc',
    });

    expect(db.calls[0]?.sql).not.toContain('WHERE');
    expect(db.calls[0]?.params).toEqual([101]);
    expect(result.total).toBe(0);
  });

  it.each([
    ['0', 101],
    ['-5', 101],
    ['1000', 101],
    ['not-a-number', 101],
    ['50', 51],
    ['12.7', 13],
  ])('clamps limit %s', async (limit, expectedParam) => {
    const { db, service } = setup([
      ['SELECT count(*)', [{ count: '0' }]],
      ['ORDER BY audit_event.seq DESC', { rows: [], rowCount: 0 }],
    ]);

    await service.page({ limit });

    expect(db.calls[0]?.params).toEqual([expectedParam]);
  });

  it('defaults the limit when none is supplied', async () => {
    const { db, service } = setup([
      ['SELECT count(*)', [{ count: '0' }]],
      ['ORDER BY audit_event.seq DESC', { rows: [], rowCount: 0 }],
    ]);

    await service.page({});
    expect(db.calls[0]?.params).toEqual([101]);
  });

  it('projects each row, including the detail variants', async () => {
    const { service } = setup([
      ['SELECT count(*)', [{ count: '3' }]],
      [
        'ORDER BY audit_event.seq DESC',
        {
          rows: [
            row({ seq: '3', detail: 'already text' }),
            row({ seq: '2', detail: {} }),
            row({ seq: '1', detail: { subjectRef: 'uuid-9', other: 1 } }),
          ],
          rowCount: 3,
        },
      ],
    ]);

    const result = await service.page({});

    expect(result.items.map((item) => item.detail)).toEqual([
      'already text',
      'no detail',
      JSON.stringify({ subjectRef: 'uuid-9', other: 1 }),
    ]);
    expect(result.items[0]).toMatchObject({
      seq: 3,
      id: 'evt-10',
      ts: '2026-01-02T03:04:05.678Z',
      actorType: 'user',
      actorId: 'user-1',
      actorName: 'user-1',
      targetType: 'session',
      targetId: 'sess-1',
      targetLabel: 'sess-1',
      outcome: 'success',
      prevHash: 'h9',
      hash: 'h10',
    });
    // The subject reference is what the drawer shows, and it falls back to the target id.
    expect(result.items[2]?.subjectRef).toBe('uuid-9');
  });

  it('falls back to the target id when the detail carries no subject reference', async () => {
    const { service } = setup([
      ['SELECT count(*)', [{ count: '1' }]],
      ['ORDER BY audit_event.seq DESC', { rows: [row({ detail: {} })], rowCount: 1 }],
    ]);

    const result = await service.page({});
    expect(result.items[0]?.subjectRef).toBe('sess-1');
  });
});

describe('proof', () => {
  it('returns the row, its predecessor walk and the day anchor', async () => {
    const { audit, service } = setup([
      ['FROM audit_event WHERE seq = $1', [row({ seq: '10' })]],
      [
        'FROM audit_event WHERE seq <= $1',
        [
          { seq: '10', hash: 'h10' },
          { seq: '9', hash: 'h9' },
        ],
      ],
      ['FROM audit_anchor WHERE day', [{ signature: 'sig-1' }]],
    ]);

    const proof = await service.proof('10');

    expect(proof).toMatchObject({
      seq: 10,
      hash: 'h10',
      prevHash: 'h9',
      algorithm: 'sha256(prev_hash || canonical(row))',
      chainValid: true,
      anchoredDay: '2026-01-02',
      anchorSignature: 'sig-1',
    });
    expect(proof.path).toEqual([
      { seq: 10, hash: 'h10' },
      { seq: 9, hash: 'h9' },
    ]);
    expect(audit.verify).toHaveBeenCalledWith('10', '10');
  });

  it('says so when the day has not been anchored', async () => {
    const { service } = setup([
      ['FROM audit_event WHERE seq = $1', [row()]],
      ['FROM audit_event WHERE seq <= $1', [{ seq: '10', hash: 'h10' }]],
      ['FROM audit_anchor WHERE day', []],
    ]);

    await expect(service.proof('10')).resolves.toMatchObject({
      anchorSignature: 'not anchored yet',
    });
  });

  it('refuses a sequence that does not exist', async () => {
    const { service } = setup([['FROM audit_event WHERE seq = $1', []]]);

    await expect(service.proof('999')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('reports an invalid chain from the verifier, not a local recomputation', async () => {
    const { service } = setup(
      [
        ['FROM audit_event WHERE seq = $1', [row()]],
        ['FROM audit_event WHERE seq <= $1', []],
        ['FROM audit_anchor WHERE day', []],
      ],
      { valid: false, checked: 1, firstBrokenSeq: '10' },
    );

    await expect(service.proof('10')).resolves.toMatchObject({ chainValid: false });
  });
});

describe('exportRange', () => {
  it('exports the range with its own hash and the verifier answer', async () => {
    const rows = [row({ seq: '1', hash: 'h1' }), row({ seq: '2', hash: 'h2' })];
    const { audit, service } = setup([['WHERE ts >=', { rows, rowCount: 2 }]]);

    const exported = await service.exportRange(
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    );

    expect(exported).toMatchObject({
      count: 2,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      chainValid: true,
      downloadName: 'audit-2026-01-01-2026-01-02.json',
      sha256: createHash('sha256').update('h1h2').digest('hex'),
    });
    expect(exported.events).toHaveLength(2);
    expect(audit.verify).toHaveBeenCalledWith('1', '2');
  });

  it('covers the whole millisecond of the upper bound', async () => {
    const { db, service } = setup([['WHERE ts >=', { rows: [], rowCount: 0 }]]);

    await service.exportRange('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

    expect(db.calls[0]?.sql).toContain("interval '1 millisecond'");
  });

  it('verifies an empty range as 0..0', async () => {
    const { audit, service } = setup([['WHERE ts >=', { rows: [], rowCount: 0 }]]);

    const exported = await service.exportRange(
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    );

    expect(exported.count).toBe(0);
    expect(audit.verify).toHaveBeenCalledWith('0', '0');
  });
});
