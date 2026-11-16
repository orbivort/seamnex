import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { PostgresAuditService } from '../../../../src/modules/m17-audit/audit.service';

/**
 * The append point is the platform's "fail closed" property: an audit row that cannot be written
 * must refuse the change, and it must do so through `AUDIT_UNAVAILABLE` even when the driver threw
 * something else. The chain itself is a database trigger, so what is asserted here is the ordering
 * (lock, then insert, in the caller's transaction) and the translation of a failure.
 */
const h = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));

function metrics() {
  const observe = vi.fn();
  return { auditAppendSeconds: { labels: vi.fn(() => ({ observe })) }, observe };
}

/** The anchor signer is a seam here: the chain tests are about ordering, not cryptography. */
function signer() {
  return {
    sign: vi.fn(async () => 'ed25519:test-key:c2ln'),
    describe: vi.fn(async () => ({
      algorithm: 'ed25519' as const,
      keyId: 'test-key',
      publicKey: 'pem',
    })),
  };
}

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
    fn(db.client),
  );
  const m = metrics();
  const s = signer();
  const service = new PostgresAuditService(db.pool, m as never, s as never);
  return { db, m, service, signer: s };
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

describe('lockChain', () => {
  it('takes a row lock on the chain tip', async () => {
    const { db, service } = setup([['FROM audit_chain', []]]);
    await service.lockChain(db.client);

    expect(db.calls[0]?.sql).toContain('FROM audit_chain WHERE id = 1 FOR UPDATE');
  });
});

describe('append', () => {
  it('writes inside the caller transaction and returns the trigger-computed seq and hash', async () => {
    const { db, m, service } = setup([
      ['FROM audit_chain', []],
      ['INSERT INTO audit_event', [{ seq: '42', hash: 'abc' }]],
    ]);

    await expect(service.append({ ...INPUT, requestId: 'req-1' }, db.client)).resolves.toEqual({
      seq: '42',
      hash: 'abc',
    });

    const [lock, insert] = db.calls;
    expect(lock?.sql).toContain('FOR UPDATE');
    expect(insert?.params).toEqual([
      'user',
      'user-1',
      'instance.deployed',
      'instance',
      'inst-1',
      'success',
      JSON.stringify({ slug: 'shop' }),
      'req-1',
    ]);
    expect(m.auditAppendSeconds.labels).toHaveBeenCalledWith('success');
    expect(m.observe).toHaveBeenCalledOnce();
  });

  it('opens its own transaction when the caller has none', async () => {
    const { db, service } = setup([
      ['FROM audit_chain', []],
      ['INSERT INTO audit_event', [{ seq: '1', hash: 'h' }]],
    ]);

    await service.append(INPUT);

    expect(h.withTransaction).toHaveBeenCalledOnce();
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO audit_event'))).toBe(true);
  });

  it('defaults detail to an empty object and the request id to null outside a request', async () => {
    const { db, service } = setup([
      ['FROM audit_chain', []],
      ['INSERT INTO audit_event', [{ seq: '1', hash: 'h' }]],
    ]);
    const withoutDetail: Record<string, unknown> = { ...INPUT };
    delete withoutDetail.detail;

    await service.append(withoutDetail as never, db.client);

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO audit_event'));
    expect(insert?.params[6]).toBe('{}');
    expect(insert?.params[7]).toBeNull();
  });

  it('refuses the change when the row is not written', async () => {
    const { m, service } = setup([
      ['FROM audit_chain', []],
      ['INSERT INTO audit_event', []],
    ]);

    await expect(service.append(INPUT, fakeDb().client)).rejects.toMatchObject({
      code: 'AUDIT_UNAVAILABLE',
    });
    expect(m.auditAppendSeconds.labels).toHaveBeenCalledWith('failure');
  });

  it('translates a driver failure into AUDIT_UNAVAILABLE', async () => {
    const db = fakeDb([['FROM audit_chain', () => Promise.reject(new Error('chain forked'))]]);
    h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
      fn(db.client),
    );
    const service = new PostgresAuditService(db.pool, metrics() as never, signer() as never);

    await expect(service.append(INPUT)).rejects.toMatchObject({
      code: 'AUDIT_UNAVAILABLE',
      detail: 'The change was refused because its audit row could not be written.',
    });
  });

  it('records a non-Error failure by its string form', async () => {
    const db = fakeDb([['FROM audit_chain', () => Promise.reject('deadlock')]]);
    h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
      fn(db.client),
    );
    const service = new PostgresAuditService(db.pool, metrics() as never, signer() as never);

    await expect(service.append(INPUT)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  });

  it('records a denial as access.denied', async () => {
    const { db, service } = setup([
      ['FROM audit_chain', []],
      ['INSERT INTO audit_event', [{ seq: '7', hash: 'h' }]],
    ]);

    await service.denied({
      actorType: 'user',
      actorId: 'u1',
      targetType: 'route',
      targetId: '/x',
      detail: {},
    });

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO audit_event'));
    expect(insert?.params[2]).toBe('access.denied');
    expect(insert?.params[5]).toBe('denied');
  });
});

describe('verify', () => {
  it('reports a valid range when every link and hash matches', async () => {
    const { service } = setup([
      [
        'seamnex_audit_hash',
        [
          { seq: '2', prev_hash: 'h1', hash: 'h2', expected: 'h2', previous: 'h1' },
          { seq: '3', prev_hash: 'h2', hash: 'h3', expected: 'h3', previous: 'h2' },
        ],
      ],
    ]);

    await expect(service.verify('2', '3')).resolves.toEqual({
      valid: true,
      checked: 2,
      firstBrokenSeq: null,
    });
  });

  it('reports the first broken link, not the last', async () => {
    const { service } = setup([
      [
        'seamnex_audit_hash',
        [
          { seq: '2', prev_hash: 'wrong', hash: 'h2', expected: 'h2', previous: 'h1' },
          { seq: '3', prev_hash: 'h2', hash: 'tampered', expected: 'other', previous: 'h2' },
        ],
      ],
    ]);

    await expect(service.verify('2', '3')).resolves.toEqual({
      valid: false,
      checked: 2,
      firstBrokenSeq: '2',
    });
  });

  it('accepts the first row when there is no predecessor to check', async () => {
    const { service } = setup([
      [
        'seamnex_audit_hash',
        [{ seq: '1', prev_hash: 'genesis', hash: 'h1', expected: 'h1', previous: null }],
      ],
    ]);

    await expect(service.verify('1', '1')).resolves.toMatchObject({ valid: true });
  });

  it('reports zero checked when the range is empty', async () => {
    const { service } = setup([['seamnex_audit_hash', { rows: [], rowCount: null }]]);

    await expect(service.verify('10', '20')).resolves.toEqual({
      valid: true,
      checked: 0,
      firstBrokenSeq: null,
    });
  });
});

describe('anchor', () => {
  it('signs the last sequence inside the closed day and writes it once', async () => {
    const {
      db,
      service,
      signer: s,
    } = setup([
      ['WHERE ts >= $1 AND ts < $2', [{ seq: '99', hash: 'h99' }]],
      ['INSERT INTO audit_anchor', []],
      [
        'FROM audit_anchor WHERE day',
        [
          {
            day: '2026-03-04',
            last_seq: '99',
            last_hash: 'h99',
            signature: 'ed25519:test-key:c2ln',
            stored_at: new Date('2026-03-05T00:01:00.000Z'),
          },
        ],
      ],
    ]);

    await expect(service.anchor(new Date('2026-03-04T12:00:00Z'))).resolves.toEqual({
      day: '2026-03-04',
      lastSeq: '99',
      lastHash: 'h99',
      signature: 'ed25519:test-key:c2ln',
      storedAt: '2026-03-05T00:01:00.000Z',
    });

    // NFR-4.10: the signature covers the row's own fields, and it is computed before the insert.
    expect(s.sign).toHaveBeenCalledWith({ day: '2026-03-04', lastSeq: '99', lastHash: 'h99' });

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO audit_anchor'));
    expect(insert?.params).toEqual(['2026-03-04', '99', 'h99', 'ed25519:test-key:c2ln']);
    /*
     * Append-only: `0010_grants` revokes UPDATE on this table, so an upsert was only ever legal for
     * the owner role — and an anchor that can be advanced is not an anchor.
     */
    expect(insert?.sql).toContain('ON CONFLICT (day) DO NOTHING');
    expect(insert?.sql).not.toContain('DO UPDATE');
  });

  it('returns the row that already exists for the day rather than the one it computed', async () => {
    const { service } = setup([
      ['WHERE ts >= $1 AND ts < $2', [{ seq: '99', hash: 'h99' }]],
      ['INSERT INTO audit_anchor', []],
      [
        'FROM audit_anchor WHERE day',
        [
          {
            day: '2026-03-04',
            last_seq: '50',
            last_hash: 'h50',
            signature: 'ed25519:older-key:cnlp',
            stored_at: new Date('2026-03-04T00:01:00.000Z'),
          },
        ],
      ],
    ]);

    await expect(service.anchor(new Date('2026-03-04T12:00:00Z'))).resolves.toMatchObject({
      lastSeq: '50',
      signature: 'ed25519:older-key:cnlp',
    });
  });

  it('anchors nothing when the day holds no events', async () => {
    const { db, service, signer: s } = setup([['WHERE ts >= $1 AND ts < $2', []]]);

    await expect(service.anchor()).resolves.toBeNull();
    expect(s.sign).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO audit_anchor'))).toBe(false);
  });

  it('bounds the day with an explicit half-open window', async () => {
    const { db, service } = setup([['WHERE ts >= $1 AND ts < $2', []]]);

    await service.anchor(new Date('2026-03-04T12:00:00Z'));

    expect(db.calls[0]?.params).toEqual(['2026-03-04T00:00:00.000Z', '2026-03-05T00:00:00.000Z']);
  });
});

/**
 * FR-1.35 — the anchor export is what the platform recovery set carries. Its only obligations are
 * to keep the day as a date string, to serialise both stored timestamps as ISO instants, and to
 * report a chain with no events as an absent head rather than as an empty one.
 */
describe('exportAnchors', () => {
  it('returns every anchor and the chain head with ISO timestamps', async () => {
    const { service } = setup([
      [
        'FROM audit_anchor ORDER BY day',
        [
          {
            day: '2026-11-14',
            last_seq: '41',
            last_hash: 'h41',
            signature: 'sig-41',
            stored_at: new Date('2026-11-14T00:05:00.000Z'),
          },
          {
            day: '2026-11-15',
            last_seq: '42',
            last_hash: 'h42',
            signature: null,
            stored_at: new Date('2026-11-15T00:05:00.000Z'),
          },
        ],
      ],
      [
        'FROM audit_event ORDER BY seq DESC',
        [{ seq: '42', hash: 'h42', ts: new Date('2026-11-15T09:30:00.000Z') }],
      ],
    ]);

    await expect(service.exportAnchors()).resolves.toEqual({
      anchors: [
        {
          day: '2026-11-14',
          lastSeq: '41',
          lastHash: 'h41',
          signature: 'sig-41',
          storedAt: '2026-11-14T00:05:00.000Z',
        },
        {
          day: '2026-11-15',
          lastSeq: '42',
          lastHash: 'h42',
          signature: null,
          storedAt: '2026-11-15T00:05:00.000Z',
        },
      ],
      // NFR-4.10: the public key travels with the anchors, so the export is verifiable on its own.
      signing: { algorithm: 'ed25519', keyId: 'test-key', publicKey: 'pem' },
      chainHead: { seq: '42', hash: 'h42', ts: '2026-11-15T09:30:00.000Z' },
    });
  });

  it('reports no chain head on a chain that has no events yet', async () => {
    const { db, service } = setup([
      ['FROM audit_anchor ORDER BY day', []],
      ['FROM audit_event ORDER BY seq DESC', []],
    ]);

    await expect(service.exportAnchors()).resolves.toEqual({
      anchors: [],
      signing: { algorithm: 'ed25519', keyId: 'test-key', publicKey: 'pem' },
      chainHead: null,
    });
    // The day is formatted in SQL so the export never reinterprets a date as a local instant.
    expect(db.calls[0]?.sql).toContain("to_char(day, 'YYYY-MM-DD')");
  });
});

/**
 * FR-1.36 — the restore compares its own row at the exported head against the exported hash. The
 * lookup stays in this module because `audit_event` is its table.
 */
describe('headHash', () => {
  it('returns the hash recorded at the sequence', async () => {
    const { db, service } = setup([['FROM audit_event WHERE seq = $1', [{ hash: 'h42' }]]]);

    await expect(service.headHash('42')).resolves.toBe('h42');
    // The parameter is cast: an untyped one resolves to text and never matches the bigint column.
    expect(db.calls[0]?.sql).toContain('$1::bigint');
    expect(db.calls[0]?.params).toEqual(['42']);
  });

  it('answers null for a sequence the restored chain does not contain', async () => {
    const { service } = setup([['FROM audit_event WHERE seq = $1', []]]);

    await expect(service.headHash('999')).resolves.toBeNull();
  });
});
