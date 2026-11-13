import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { PostgresAccessControlService } from '../../../../src/modules/m09-access-control/access-control.service';

/**
 * Platform settings are edited through one conditional operation, and the two behaviours worth
 * pinning are both about not losing an operator's decision: a missing `If-Match` is a `412` rather
 * than a silent overwrite, and the legacy `audit_retention_months` row is still honoured as days.
 * The role fallback matters for a different reason — a user with no binding must still reach the
 * portal at the least privileged role, not be treated as an administrator.
 */
const h = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));

/**
 * A stored settings row with a fixed timestamp. Without one, `settings()` substitutes `new Date()`
 * for `updatedAt`, so two reads in the same test can produce different ETags — which made the
 * `If-Match` cases pass or fail depending on the clock.
 */
const STORED = [
  {
    key: 'restore_concurrency',
    value: 4,
    updated_by: 'system',
    updated_at: new Date('2026-01-01T00:00:00Z'),
  },
];

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
    fn(db.client),
  );
  const audit = { lockChain: vi.fn(async () => undefined), append: vi.fn(async () => undefined) };
  const compiler = { compile: vi.fn(async () => ({ version: 7 })) };
  const service = new PostgresAccessControlService(db.pool, audit as never, compiler as never);
  return { db, audit, compiler, service };
}

beforeEach(() => {
  h.withTransaction.mockReset();
});

describe('roleFor', () => {
  it('returns the bound role', async () => {
    const { db, service } = setup([['FROM role_binding', [{ role: 'R2' }]]]);

    await expect(service.roleFor('uuid-1')).resolves.toBe('R2');
    expect(db.calls[0]?.params).toEqual(['uuid-1']);
  });

  it('falls back to member when there is no binding', async () => {
    const { service } = setup([['FROM role_binding', []]]);
    await expect(service.roleFor('uuid-1')).resolves.toBe('R5');
  });
});

describe('grantsFor', () => {
  it('projects grants, keeping an unbounded grant unbounded', async () => {
    const { service } = setup([
      [
        'SELECT DISTINCT role',
        [
          { role: 'R3', scope_type: 'instance', scope_id: 'inst-1', expires_at: null },
          {
            role: 'R4',
            scope_type: 'platform',
            scope_id: null,
            expires_at: new Date('2026-05-06T00:00:00Z'),
          },
        ],
      ],
    ]);

    await expect(service.grantsFor('uuid-1')).resolves.toEqual([
      { role: 'R3', scopeType: 'instance', scopeId: 'inst-1', expiresAt: null },
      {
        role: 'R4',
        scopeType: 'platform',
        scopeId: null,
        expiresAt: '2026-05-06T00:00:00.000Z',
      },
    ]);
  });
});

describe('settings', () => {
  it('returns the documented defaults when nothing is stored', async () => {
    const { service } = setup([['FROM settings', []]]);

    const { settings, etag } = await service.settings();

    expect(settings).toMatchObject({
      breakGlassMaxMinutes: 60,
      restoreConcurrency: 4,
      oversubscriptionFactor: 1.25,
      sessionIdleMinutes: 30,
      sessionAbsoluteHours: 12,
      metadataReviewDays: 90,
      auditRetentionDays: 420,
      updatedBy: 'system',
    });
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('applies stored values, the legacy months key and the newest editor', async () => {
    const { service } = setup([
      [
        'FROM settings',
        [
          {
            key: 'restore_concurrency',
            value: 8,
            updated_by: 'alice',
            updated_at: new Date('2026-01-01T00:00:00Z'),
          },
          {
            key: 'audit_retention_months',
            value: 7,
            updated_by: 'bob',
            updated_at: new Date('2026-02-01T00:00:00Z'),
          },
          {
            key: 'unknown_key',
            value: 'ignored',
            updated_by: 'carol',
            updated_at: new Date('2026-01-15T00:00:00Z'),
          },
          {
            key: 'session_idle_minutes',
            value: 'not-a-number',
            updated_by: null,
            updated_at: new Date('2026-01-10T00:00:00Z'),
          },
        ],
      ],
    ]);

    const { settings } = await service.settings();

    expect(settings.restoreConcurrency).toBe(8);
    expect(settings.auditRetentionDays).toBe(210);
    expect(settings.sessionIdleMinutes).toBe(30);
    expect(settings.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(settings.updatedBy).toBe('bob');
  });

  it('defaults the editor to system when the newest row carries none', async () => {
    const { service } = setup([
      [
        'FROM settings',
        [
          {
            key: 'restore_concurrency',
            value: 5,
            updated_by: null,
            updated_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      ],
    ]);

    await expect(service.settings()).resolves.toMatchObject({
      settings: { updatedBy: 'system' },
    });
  });
});

describe('putSettings', () => {
  it('refuses a write without If-Match', async () => {
    const { service } = setup([['FROM settings', []]]);

    await expect(
      service.putSettings({ restoreConcurrency: 6 }, undefined, 'alice'),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('refuses a stale If-Match', async () => {
    const { service } = setup([['FROM settings', []]]);

    await expect(
      service.putSettings({ restoreConcurrency: 6 }, '"stale"', 'alice'),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('writes each known field, audits the change and returns the new validator', async () => {
    const { db, audit, service } = setup([
      ['FROM settings', STORED],
      ['INSERT INTO settings', []],
    ]);
    const { etag } = await service.settings();

    const result = await service.putSettings(
      { restoreConcurrency: 6, unknownField: 1 },
      etag,
      'alice',
    );

    const inserts = db.calls.filter((call) => call.sql.includes('INSERT INTO settings'));
    // The unknown field is not a settings key and is not written.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toEqual(['restore_concurrency', '6', 'alice']);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.updated',
        actorId: 'alice',
        detail: { changed: ['restoreConcurrency', 'unknownField'] },
      }),
      expect.anything(),
    );
    expect(result.settings.restoreConcurrency).toBe(6);
    expect(result.settings.updatedBy).toBe('alice');
    expect(result.etag).not.toBe(etag);
  });

  it('accepts a wildcard If-Match', async () => {
    const { service } = setup([
      ['FROM settings', []],
      ['INSERT INTO settings', []],
    ]);

    await expect(
      service.putSettings({ sessionIdleMinutes: 45 }, '*', 'alice'),
    ).resolves.toMatchObject({ settings: { sessionIdleMinutes: 45 } });
  });

  it('accepts a weak validator for the current representation', async () => {
    const { service } = setup([
      ['FROM settings', STORED],
      ['INSERT INTO settings', []],
    ]);
    const { etag } = await service.settings();

    await expect(
      service.putSettings({ metadataReviewDays: 30 }, `W/${etag}`, 'bob'),
    ).resolves.toMatchObject({ settings: { metadataReviewDays: 30 } });
  });

  it('refuses a value the schema rejects, before writing anything', async () => {
    const { db, service } = setup([['FROM settings', []]]);
    const { etag } = await service.settings();

    await expect(service.putSettings({ restoreConcurrency: -1 }, etag, 'alice')).rejects.toThrow();
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO settings'))).toBe(false);
  });
});

describe('compilePolicy', () => {
  it('reports the compiled version', async () => {
    const { compiler, service } = setup();

    await expect(service.compilePolicy()).resolves.toEqual({ version: 7 });
    expect(compiler.compile).toHaveBeenCalledOnce();
  });
});
