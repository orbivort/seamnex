import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, skipUnlessDatabase, type TestDatabase } from '@seamnex/db/testing';
import type { AuditEvent } from '@seamnex/domain';
import { AuditQueryService } from '../../src/modules/m17-audit/audit-query.service';
import type { AuditService } from '../../src/modules/m17-audit/audit.contract';

/**
 * Read-side coverage for the audit trail (FR-4.3, AC-15).
 *
 * The regression this file exists for: the page query selected `seq::text` and then ordered by a
 * bare `seq`, which PostgreSQL resolves against the *output* column. The trail therefore came back
 * lexicographically — 99, 98, … 9, 105, 104 — and the keyset cursor, which compares `bigint`,
 * skipped every row above the last digit-length boundary while repeating others.
 *
 * The dataset is deliberately larger than 100 rows so its sequence numbers cross a digit
 * boundary; a smaller fixture passes under both orderings.
 */
const ROWS = 105;

let database: TestDatabase | undefined;
let pool: Pool;
let audit: AuditQueryService;

const STUB_AUDIT = {
  verify: () => Promise.resolve({ valid: true, checked: 0, firstBrokenSeq: null }),
} as unknown as AuditService;

beforeAll(async () => {
  if (skipUnlessDatabase() !== false) return;
  database = await createTestDatabase();
  pool = database.pool;
  audit = new AuditQueryService(pool, STUB_AUDIT);

  for (let index = 0; index < ROWS; index += 1) {
    await append('instance.deploy.succeeded');
  }
  await append('auth.session.created');
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

async function append(action: string): Promise<void> {
  await pool.query(
    `INSERT INTO audit_event (actor_type, actor_id, action, target_type, target_id, outcome, detail)
     VALUES ('user', 'dev-auditor', $1, 'instance', 'inst-people', 'success', '{}'::jsonb)`,
    [action],
  );
}

async function drain(pageSize: number): Promise<AuditEvent[]> {
  const collected: AuditEvent[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page: { items: AuditEvent[]; nextCursor: string | null } = await audit.page({
      limit: String(pageSize),
      ...(cursor === undefined ? {} : { cursor }),
    });
    collected.push(...page.items);
    if (page.nextCursor === null) return collected;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

describe.skipIf(skipUnlessDatabase() !== false)('audit trail read surface', () => {
  it('pages newest first by sequence, not by its decimal spelling', async () => {
    const first = await audit.page({ limit: '10' });

    expect(first.total).toBe(ROWS + 1);
    expect(first.items.map((event) => event.seq)).toEqual([
      106, 105, 104, 103, 102, 101, 100, 99, 98, 97,
    ]);
  });

  it('walks the whole trail once, in order, without repeating or skipping a row', async () => {
    const events = await drain(10);
    const seqs = events.map((event) => event.seq);

    expect(seqs).toHaveLength(ROWS + 1);
    expect(new Set(seqs).size).toBe(ROWS + 1);
    expect(seqs).toEqual([...seqs].sort((left, right) => right - left));
  });

  it('exports exactly the range it reports, newest row included', async () => {
    const page = await audit.page({ limit: '5' });
    const newest = page.items[0];
    const oldest = page.items[page.items.length - 1];
    // The console derives the range from the rows on screen, so `to` is the millisecond spelling
    // of a microsecond timestamp.
    const exported = await audit.exportRange(
      new Date(oldest?.ts ?? '').toISOString(),
      new Date(newest?.ts ?? '').toISOString(),
    );

    expect(exported.count).toBe(exported.events.length);
    expect(exported.events.at(-1)?.seq).toBe(newest?.seq);
  });

  it('reports the daily anchor signature the proof drawer claims', async () => {
    const page = await audit.page({ limit: '1' });
    const newest = page.items[0];
    const day = new Date(newest?.ts ?? '').toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO audit_anchor (day, last_seq, last_hash, signature)
       VALUES ($1::date, $2, repeat('0', 64), 'anchor-signature-fixture')
       ON CONFLICT (day) DO UPDATE SET signature = EXCLUDED.signature`,
      [day, newest?.seq ?? 0],
    );

    const proof = await audit.proof(String(newest?.seq));

    expect(proof.anchoredDay).toBe(day);
    expect(proof.anchorSignature).toBe('anchor-signature-fixture');
  });

  it('filters by a dotted action namespace as well as by the full action', async () => {
    const byNamespace = await audit.page({ limit: '10', action: 'auth' });
    expect(byNamespace.items.map((event) => event.action)).toEqual(['auth.session.created']);

    const byAction = await audit.page({ limit: '10', action: 'auth.session.created' });
    expect(byAction.total).toBe(1);

    // A prefix must not swallow a namespace that merely starts with the same characters.
    const byLongerPrefix = await audit.page({ limit: '10', action: 'auth.session.created.extra' });
    expect(byLongerPrefix.total).toBe(0);
  });
});
