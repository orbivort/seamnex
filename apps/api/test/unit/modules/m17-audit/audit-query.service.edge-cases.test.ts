import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { AuditQueryService } from '../../../../src/modules/m17-audit/audit-query.service';

/**
 * The cursor is derived from the last row of the page. When that row carries no `seq` there is no
 * key to resume from: the honest answer is "no next cursor" rather than a page that repeats the
 * same rows forever on every `next` click.
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

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  const audit = {
    verify: vi.fn(async () => ({ valid: true, checked: 0, firstBrokenSeq: null })),
    append: vi.fn(),
    lockChain: vi.fn(),
    denied: vi.fn(),
  };
  return { db, service: new AuditQueryService(db.pool, audit as never) };
}

describe('page', () => {
  it('reports no cursor when the last row of the page carries no sequence', async () => {
    const { service } = setup([
      ['SELECT count(*)', [{ count: '2' }]],
      [
        'ORDER BY audit_event.seq DESC',
        // One row over the limit, so a next page exists — but the page's last row cannot key it.
        { rows: [row({ seq: null }), row({ seq: '9' })], rowCount: 2 },
      ],
    ]);

    const result = await service.page({ limit: '1' });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});
