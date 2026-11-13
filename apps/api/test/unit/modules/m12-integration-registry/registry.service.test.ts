import { describe, expect, it } from 'vitest';
import type { RegistryEntry } from '@seamnex/domain';
import { PostgresRegistryService } from '../../../../src/modules/m12-integration-registry/registry.service';
import { AppError } from '../../../../src/common/problem/app-error';
import { fakeDb } from '../../../support/fakes';

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    slug: 'mail',
    state: 'ready',
    stale: false,
    ...overrides,
  } as RegistryEntry;
}

describe('PostgresRegistryService', () => {
  it('projects every snapshot row, ordered by slug in SQL', async () => {
    const db = fakeDb([
      [
        'FROM registry_snapshot ORDER BY payload',
        [
          { payload: entry({ slug: 'a' }), stale: false },
          { payload: entry({ slug: 'b' }), stale: true },
        ],
      ],
    ]);
    const service = new PostgresRegistryService(db.pool);

    const entries = await service.entries();

    expect(entries.map((row) => row.slug)).toEqual(['a', 'b']);
    expect(entries[1]?.stale).toBe(true);
    expect(db.calls[0]?.sql).toContain('ORDER BY payload');
  });

  it('returns the entry for a slug', async () => {
    const db = fakeDb([["WHERE payload->>'slug' = $1", [{ payload: entry(), stale: false }]]]);
    const service = new PostgresRegistryService(db.pool);

    expect(await service.entry('mail')).toMatchObject({ slug: 'mail', stale: false });
    expect(db.calls[0]?.params).toEqual(['mail']);
  });

  it('refuses an unknown slug with NOT_FOUND', async () => {
    const db = fakeDb([["WHERE payload->>'slug' = $1", []]]);
    const service = new PostgresRegistryService(db.pool);

    await expect(service.entry('nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: expect.stringContaining('nope'),
    });
  });

  it('lists only the rows the projection marked stale', async () => {
    const db = fakeDb([['WHERE stale', [{ payload: entry({ slug: 'old' }), stale: true }]]]);
    const service = new PostgresRegistryService(db.pool);

    const rows = await service.stale();
    expect(rows).toHaveLength(1);
  });

  it('treats an overdue review as stale even when the column says otherwise', async () => {
    const db = fakeDb([
      [
        'FROM registry_snapshot ORDER BY payload',
        [
          {
            payload: entry({ nextReviewAt: '2020-01-01T00:00:00.000Z' }),
            stale: false,
          },
        ],
      ],
    ]);

    const [row] = await new PostgresRegistryService(db.pool).entries();
    expect(row?.stale).toBe(true);
  });

  it('does not treat a future review as stale, and tolerates an invalid timestamp', async () => {
    const db = fakeDb([
      [
        'FROM registry_snapshot ORDER BY payload',
        [
          { payload: entry({ nextReviewAt: '2099-01-01T00:00:00.000Z' }), stale: false },
          { payload: entry({ nextReviewAt: 'not-a-date' }), stale: false },
        ],
      ],
    ]);

    const rows = await new PostgresRegistryService(db.pool).entries();
    expect(rows.map((row) => row.stale)).toEqual([false, false]);
  });

  it('leaves stale false when no review date was projected', async () => {
    const db = fakeDb([
      ['FROM registry_snapshot ORDER BY payload', [{ payload: entry(), stale: false }]],
    ]);
    const [row] = await new PostgresRegistryService(db.pool).entries();
    expect(row?.stale).toBe(false);
  });

  it('propagates a database failure rather than returning an empty registry', async () => {
    const db = fakeDb([]);
    await expect(new PostgresRegistryService(db.pool).entries()).rejects.toThrow(/no route/);
  });

  it('uses a catalogued code for a missing entry', () => {
    const error = new AppError({ code: 'NOT_FOUND', detail: 'x' });
    expect(error.code).toBe('NOT_FOUND');
  });
});
