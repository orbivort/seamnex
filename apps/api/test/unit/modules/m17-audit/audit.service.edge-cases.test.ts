import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { PostgresAuditService } from '../../../../src/modules/m17-audit/audit.service';

/**
 * The append that returns no row. `INSERT ... RETURNING` is the only statement whose emptiness the
 * writer has to check itself: a trigger that skipped the row, or a statement rewritten by a
 * migration, produces no exception and no audit event — so the refusal has to come from the reader,
 * and it has to arrive as the same coded `AUDIT_UNAVAILABLE` a driver error produces.
 */
const h = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));

function metrics() {
  const observe = vi.fn();
  return { auditAppendSeconds: { labels: vi.fn(() => ({ observe })) }, observe };
}

const INPUT = {
  actorType: 'user' as const,
  actorId: 'user-1',
  action: 'instance.deployed',
  targetType: 'instance',
  targetId: 'inst-1',
  outcome: 'success' as const,
  detail: { slug: 'shop' },
};

beforeEach(() => {
  h.withTransaction.mockReset();
});

describe('append', () => {
  it('refuses the change when the insert returns no row at all', async () => {
    const db = fakeDb([
      ['FROM audit_chain', []],
      ['INSERT INTO audit_event', []],
    ]);
    const m = metrics();
    const service = new PostgresAuditService(db.pool, m as never);

    const thrown = await service.append(INPUT, db.client).catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      code: 'AUDIT_UNAVAILABLE',
      detail: 'The change was refused because its audit row could not be written.',
    });
    // The empty result is the cause, not a driver error: it is preserved for the log line.
    expect((thrown as { cause?: Error }).cause?.message).toBe('audit append returned no row');
    expect(m.auditAppendSeconds.labels).toHaveBeenLastCalledWith('failure');
  });
});
