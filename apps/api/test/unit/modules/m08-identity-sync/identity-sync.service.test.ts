import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@seamnex/db';
import { fakeDb, type Route, type RouteResult } from '../../../support/fakes';
import type { AuditService } from '../../../../src/modules/m17-audit/audit.contract';
import type { SessionService } from '../../../../src/modules/m10-portal-bff/session.contract';
import type { IdentityProvider } from '../../../../src/common/identity/identity-provider.contract';
import type { SyncWorkerService } from '../../../../src/modules/m08-identity-sync/sync-worker.service';
import { PostgresIdentitySyncService } from '../../../../src/modules/m08-identity-sync/identity-sync.service';

/**
 * M08's screens are projections, and every projection here has a failure mode that a type checker
 * cannot see: a page that quietly drops the facts of a person with no roles, a mapping save that
 * appends a second authority instead of replacing the first, and an offboarding that reports
 * success while the provider still holds the account open. Each is asserted as the state that was
 * *written* — the SQL parameters, the audit row, the outbox-free contract — not as a resolved
 * promise, because all three defects used to resolve.
 */

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  const audit = {
    lockChain: vi.fn(async () => undefined),
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
  };
  const sessions = { killSubject: vi.fn(async () => 2) };
  const provider = { setUserEnabled: vi.fn(async () => undefined) };
  const worker = { runOnce: vi.fn() };
  const productAccounts = { deprovision: vi.fn(async () => undefined), sweep: vi.fn() };
  const service = new PostgresIdentitySyncService(
    db.pool,
    audit as unknown as AuditService,
    sessions as unknown as SessionService,
    provider as unknown as IdentityProvider,
    worker as unknown as SyncWorkerService,
    productAccounts as never,
  );
  return { db, audit, sessions, provider, worker, productAccounts, service };
}

function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idp_id: 'u-1',
    username: 'alice',
    email: 'alice@example.test',
    display_name: 'Alice Anderson',
    enabled: true,
    mfa_enrolled: true,
    last_login_at: new Date('2026-01-02T03:04:05.000Z'),
    job_title: 'Domain lead',
    created_at: new Date('2025-05-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** The three statements `userDetails` issues for a page; all three are required per call. */
function detailRoutes(
  roles: Record<string, unknown>[] = [],
  counts: Record<string, unknown>[] = [],
  members: Record<string, unknown>[] = [],
): readonly Route[] {
  return [
    ['FROM role_binding WHERE subject_idp_id = ANY', roles],
    ['GROUP BY subject_idp_id', counts],
    ['FROM idp_group_member m', members],
  ];
}

describe('users', () => {
  it('resolves a whole page in three batched statements instead of three per person', async () => {
    const { db, service } = setup([
      [
        'LIMIT $3',
        [userRow(), userRow({ idp_id: 'u-2', username: 'bob', display_name: null, email: null })],
      ],
      ...detailRoutes(
        [
          { subject: 'u-1', role: 'R1', scope_type: 'platform', scope_id: null },
          { subject: 'u-1', role: 'R4', scope_type: 'domain', scope_id: 'dom-1' },
          { subject: 'u-1', role: 'R5', scope_type: 'unmapped', scope_id: null },
        ],
        // The count for a subject outside the page cannot leak onto a row.
        [
          { subject: 'u-1', count: '7' },
          { subject: 'u-ghost', count: '9' },
        ],
        [
          { subject: 'u-1', path: '/seamnex-domains/core' },
          { subject: 'u-1', path: '/seamnex-domains/ops' },
        ],
      ),
    ]);

    const page = await service.users();

    expect(db.calls[0]?.params).toEqual(['', '', 500]);
    // One read of the page plus exactly three detail statements, whatever the page size.
    expect(db.calls).toHaveLength(4);
    expect(page[0]).toMatchObject({
      id: 'u-1',
      username: 'alice',
      displayName: 'Alice Anderson',
      email: 'alice@example.test',
      initials: 'AA',
      enabled: true,
      groups: ['/seamnex-domains/core', '/seamnex-domains/ops'],
      // A null scope id falls back to the scope's class label, an unknown one to `Platform`.
      roles: [
        { role: 'R1', scopeLabel: 'Platform' },
        { role: 'R4', scopeLabel: 'dom-1' },
        { role: 'R5', scopeLabel: 'Platform' },
      ],
      entitlementCount: 7,
      lastLoginAt: '2026-01-02T03:04:05.000Z',
      createdAt: '2025-05-01T00:00:00.000Z',
      jobTitle: 'Domain lead',
    });
    // No display name, no e-mail and no detail row still renders a usable row.
    expect(page[1]).toMatchObject({
      displayName: 'bob',
      email: 'bob@seamnex.local',
      groups: [],
      roles: [],
      entitlementCount: 0,
    });
  });

  it('lowercases the search term and trims the keyset cursor', async () => {
    const { db, service } = setup([['LIMIT $3', []]]);

    await service.users('Alice', '  bob  ');

    expect(db.calls[0]?.params).toEqual(['alice', 'bob', 500]);
  });

  it('skips the detail statements when the page is empty', async () => {
    const { db, service } = setup([['LIMIT $3', []]]);

    await expect(service.users()).resolves.toEqual([]);
    expect(db.calls).toHaveLength(1);
  });

  it('names the continuation cursor when a page reaches the cap', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rows = Array.from({ length: 500 }, (_, index) =>
      userRow({ idp_id: `u-${index}`, username: `user-${String(index).padStart(3, '0')}` }),
    );
    const { service } = setup([['LIMIT $3', rows], ...detailRoutes()]);

    const page = await service.users();

    expect(page).toHaveLength(500);
    // The truncation is reported, not left for a caller to notice.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('after=user-499'));
    warn.mockRestore();
  });

  it('reports an empty cursor when the row at the cap carries no username', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rows: Record<string, unknown>[] = Array.from({ length: 500 }, (_, index) =>
      userRow({ idp_id: `u-${index}`, username: `user-${index}` }),
    );
    rows[499] = userRow({ idp_id: 'u-499', username: undefined });
    const { service } = setup([['LIMIT $3', rows], ...detailRoutes()]);

    await service.users();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('after= to continue'));
    warn.mockRestore();
  });

  it('falls back for a row with no display name, title or last login', async () => {
    const { service } = setup([
      [
        'LIMIT $3',
        [
          {
            ...userRow({
              display_name: null,
              email: null,
              job_title: null,
              last_login_at: null,
              enabled: false,
              mfa_enrolled: false,
            }),
          },
        ],
      ],
      ...detailRoutes(),
    ]);

    const [user] = await service.users();

    expect(user).toMatchObject({
      displayName: 'alice',
      // Initials come from the same fallback the name does.
      initials: 'AL',
      email: 'alice@seamnex.local',
      jobTitle: 'Platform member',
      lastLoginAt: null,
      enabled: false,
      mfaEnrolled: false,
      // `created_at`, not `updated_at`: a sync cycle must not re-date the account.
      createdAt: '2025-05-01T00:00:00.000Z',
    });
  });
});

describe('user', () => {
  it('reads one account with its derived facts', async () => {
    const { db, service } = setup([
      ['FROM idp_user WHERE idp_id = $1', [userRow()]],
      ...detailRoutes([{ subject: 'u-1', role: 'R2', scope_type: 'platform', scope_id: null }]),
    ]);

    await expect(service.user('u-1')).resolves.toMatchObject({
      id: 'u-1',
      roles: [{ role: 'R2', scopeLabel: 'Platform' }],
    });
    expect(db.calls[0]?.params).toEqual(['u-1']);
  });

  it('refuses an unknown id instead of returning a placeholder', async () => {
    const { service } = setup([['FROM idp_user WHERE idp_id = $1', []]]);

    await expect(service.user('ghost')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No directory object ghost.',
    });
  });
});

describe('userEntitlements', () => {
  it('lists the products a subject reaches, with their sync state', async () => {
    const { db, service } = setup([
      [
        'FROM entitlement e JOIN instance i',
        [
          {
            instance_id: 'inst-1',
            entry_key: 'espocrm',
            product: 'EspoCRM',
            product_role: 'member',
            sync_state: 'applied',
          },
        ],
      ],
    ]);

    await expect(service.userEntitlements('u-1')).resolves.toEqual({
      userId: 'u-1',
      entitlements: [
        {
          instanceId: 'inst-1',
          product: 'EspoCRM',
          entryKey: 'espocrm',
          productRole: 'member',
          syncState: 'applied',
        },
      ],
    });
    expect(db.calls[0]?.params).toEqual(['u-1']);
  });

  it('answers an empty list for a subject with no entitlement row', async () => {
    const { service } = setup([['FROM entitlement e JOIN instance i', []]]);

    await expect(service.userEntitlements('u-1')).resolves.toEqual({
      userId: 'u-1',
      entitlements: [],
    });
  });
});

describe('groups', () => {
  it('reports a mapping decision newer than the mirror timestamp', async () => {
    const { service } = setup([
      [
        'FROM idp_group ORDER BY path',
        [
          {
            idp_id: 'seamnex-domains-core',
            path: '/seamnex-domains/core',
            member_count: 3,
            updated_at: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      ],
      [
        'propagate_to_product, created_at',
        [
          {
            group_idp_id: 'seamnex-domains-core',
            role: 'R4',
            scope_type: 'domain',
            scope_id: 'dom-1',
            propagate_to_product: true,
            created_at: new Date('2026-03-01T00:00:00.000Z'),
          },
        ],
      ],
    ]);

    const [group] = await service.groups();

    expect(group).toEqual({
      id: 'seamnex-domains-core',
      path: '/seamnex-domains/core',
      displayName: 'core',
      description: 'Directory group /seamnex-domains/core.',
      memberCount: 3,
      mapping: {
        role: 'R4',
        scopeType: 'domain',
        scopeId: 'dom-1',
        scopeLabel: 'dom-1',
        propagateToProduct: true,
      },
      // The mapping decision is the last thing that changed about the group.
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
  });

  it('keeps the mirror timestamp when the mapping is older than it', async () => {
    const { service } = setup([
      [
        'FROM idp_group ORDER BY path',
        [
          {
            idp_id: 'g-1',
            path: '/core',
            member_count: 0,
            updated_at: new Date('2026-03-01T00:00:00.000Z'),
          },
        ],
      ],
      [
        'propagate_to_product, created_at',
        [
          {
            group_idp_id: 'g-1',
            role: 'R1',
            scope_type: 'platform',
            scope_id: null,
            propagate_to_product: false,
            created_at: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      ],
    ]);

    const [group] = await service.groups();

    expect(group?.updatedAt).toBe('2026-03-01T00:00:00.000Z');
    // No scope id on a platform grant, so the class label stands in.
    expect(group?.mapping).toMatchObject({ scopeId: null, scopeLabel: 'Platform' });
  });

  it('reports a group with no mapping as unmapped and falls back to the raw path', async () => {
    const { service } = setup([
      [
        'FROM idp_group ORDER BY path',
        [
          {
            idp_id: 'g-2',
            path: '/',
            member_count: 0,
            updated_at: new Date('2026-03-01T00:00:00.000Z'),
          },
        ],
      ],
      ['propagate_to_product, created_at', []],
    ]);

    const [group] = await service.groups();

    expect(group).toMatchObject({ mapping: null, displayName: '/' });
  });

  it('names an unfamiliar scope class as a platform grant', async () => {
    const { service } = setup([
      [
        'FROM idp_group ORDER BY path',
        [
          {
            idp_id: 'g-3',
            path: '/tenant',
            member_count: 1,
            updated_at: new Date('2026-03-01T00:00:00.000Z'),
          },
        ],
      ],
      [
        'propagate_to_product, created_at',
        [
          {
            group_idp_id: 'g-3',
            role: 'R3',
            scope_type: 'tenant',
            scope_id: null,
            propagate_to_product: false,
            created_at: new Date('2026-02-01T00:00:00.000Z'),
          },
        ],
      ],
    ]);

    const [group] = await service.groups();

    expect(group?.mapping?.scopeLabel).toBe('Platform');
  });
});

describe('mapGroup', () => {
  it('replaces the stored mapping and records what it withdrew', async () => {
    const { db, audit, service } = setup([
      [
        'SELECT 1 FROM idp_group WHERE idp_id = $1 FOR UPDATE',
        { rows: [{ '?column?': 1 }], rowCount: 1 },
      ],
      [
        'DELETE FROM group_mapping',
        { rows: [{ role: 'R5', scope_type: 'platform', scope_id: null }], rowCount: 1 },
      ],
      ['INSERT INTO group_mapping', { rows: [], rowCount: 1 }],
      [
        'FROM idp_group ORDER BY path',
        [
          {
            idp_id: 'g-1',
            path: '/core',
            member_count: 1,
            updated_at: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      ],
      [
        'propagate_to_product, created_at',
        [
          {
            group_idp_id: 'g-1',
            role: 'R2',
            scope_type: 'platform',
            scope_id: null,
            propagate_to_product: true,
            created_at: new Date('2026-02-01T00:00:00.000Z'),
          },
        ],
      ],
    ]);

    const group = await service.mapGroup(
      'g-1',
      { role: 'R2', scopeType: 'platform', scopeLabel: 'Platform', propagate: true },
      'admin-1',
    );

    expect(group.mapping).toMatchObject({ role: 'R2', scopeId: null, propagateToProduct: true });
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO group_mapping'));
    // A platform grant stores no scope id; the label is presentation, not state.
    expect(insert?.params).toEqual(['g-1', 'R2', 'platform', null, true, 'admin-1']);
    // The chain lock is taken before the row lock, so every audited transaction agrees on order.
    expect(audit.lockChain).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'group.mapping.updated',
        actorId: 'admin-1',
        targetId: 'g-1',
        detail: expect.objectContaining({
          role: 'R2',
          scopeType: 'platform',
          scopeLabel: 'Platform',
          propagate: true,
          replaced: { role: 'R5', scope_type: 'platform', scope_id: null },
        }),
      }),
      expect.anything(),
    );
  });

  it('stores the scope label as the scope id for a scoped grant', async () => {
    const { db, audit, service } = setup([
      ['SELECT 1 FROM idp_group WHERE idp_id = $1 FOR UPDATE', { rows: [{}], rowCount: 1 }],
      ['DELETE FROM group_mapping', { rows: [], rowCount: 0 }],
      ['INSERT INTO group_mapping', { rows: [], rowCount: 1 }],
      [
        'FROM idp_group ORDER BY path',
        [{ idp_id: 'g-1', path: '/core', member_count: 1, updated_at: new Date() }],
      ],
      ['propagate_to_product, created_at', []],
    ]);

    await service.mapGroup(
      'g-1',
      { role: 'R4', scopeType: 'domain', scopeLabel: 'dom-1', propagate: false },
      'admin-1',
    );

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO group_mapping'));
    expect(insert?.params).toEqual(['g-1', 'R4', 'domain', 'dom-1', false, 'admin-1']);
    // A first mapping withdrew nothing.
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ replaced: null }) }),
      expect.anything(),
    );
  });

  it('refuses a group the directory no longer mirrors, before writing anything', async () => {
    const { db, audit, service } = setup([
      ['SELECT 1 FROM idp_group WHERE idp_id = $1 FOR UPDATE', { rows: [], rowCount: 0 }],
    ]);

    await expect(
      service.mapGroup(
        'gone',
        { role: 'R2', scopeType: 'platform', scopeLabel: 'Platform', propagate: false },
        'admin-1',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', detail: 'No directory object gone.' });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO group_mapping'))).toBe(false);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('reports a group that vanished between the save and the re-read', async () => {
    const { service } = setup([
      ['SELECT 1 FROM idp_group WHERE idp_id = $1 FOR UPDATE', { rows: [{}], rowCount: 1 }],
      ['DELETE FROM group_mapping', { rows: [], rowCount: 0 }],
      ['INSERT INTO group_mapping', { rows: [], rowCount: 1 }],
      ['FROM idp_group ORDER BY path', []],
      ['propagate_to_product, created_at', []],
    ]);

    await expect(
      service.mapGroup(
        'g-1',
        { role: 'R2', scopeType: 'platform', scopeLabel: 'Platform', propagate: false },
        'admin-1',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('syncRuns', () => {
  it.each([
    ['a cycle that recorded its own verdict', { outcome: 'succeeded' }, 0, 'succeeded'],
    ['a cycle that disagreed with a route', { outcome: 'partial' }, 2, 'partial'],
    ['a cycle that never read the directory', { outcome: 'failed' }, 1, 'failed'],
    ['a row written before the outcome was recorded', {}, 0, 'succeeded'],
    ['a row whose errors predate the outcome', {}, 4, 'partial'],
  ] as const)('reads %s from the row it wrote', async (_label, detail, errorCount, expected) => {
    const { service } = setup([
      [
        'FROM sync_run',
        [
          {
            id: 'run-1',
            started_at: new Date('2026-01-01T00:00:00.000Z'),
            finished_at: new Date('2026-01-01T00:00:05.000Z'),
            changes: 9,
            p95_latency_ms: 12,
            errors: errorCount,
            detail: { ...detail, users: 4, groups: 2, errors: ['route disagrees'] },
          },
        ],
      ],
    ]);

    const [run] = await service.syncRuns();

    expect(run).toEqual({
      id: 'run-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      users: 4,
      groups: 2,
      changes: 9,
      p95LatencyMs: 12,
      errors: ['route disagrees'],
      state: expected,
    });
  });

  it('defaults an unfinished run and a detail blob that is not shaped like one', async () => {
    const { service } = setup([
      [
        'FROM sync_run',
        [
          {
            id: 'run-2',
            started_at: new Date('2026-01-01T00:00:00.000Z'),
            finished_at: null,
            changes: 0,
            p95_latency_ms: null,
            errors: 0,
            detail: { users: 'many', groups: null, errors: 'none' },
          },
        ],
      ],
    ]);

    const [run] = await service.syncRuns();

    expect(run).toEqual({
      id: 'run-2',
      // An unfinished run is reported as starting when it started, not as timeless.
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
      users: 0,
      groups: 0,
      changes: 0,
      p95LatencyMs: 0,
      errors: [],
      state: 'succeeded',
    });
  });
});

describe('runSync', () => {
  const completed = {
    id: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:05.000Z',
    users: 1,
    groups: 0,
    changes: 1,
    p95LatencyMs: 3,
    errors: [],
    state: 'succeeded' as const,
  };

  it('forces one manual cycle and returns its result', async () => {
    const { worker, service } = setup();
    worker.runOnce.mockResolvedValue(completed);

    await expect(service.runSync('admin-1')).resolves.toEqual(completed);
    expect(worker.runOnce).toHaveBeenCalledWith('manual');
  });

  it('refuses an unattributed run', async () => {
    const { worker, service } = setup();

    await expect(service.runSync('')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      detail: 'A sync run must be attributed to an actor.',
    });
    expect(worker.runOnce).not.toHaveBeenCalled();
  });

  it('turns a cycle already in progress into a state conflict', async () => {
    const { worker, service } = setup();
    worker.runOnce.mockRejectedValue(new Error('an identity sync cycle is already running'));

    await expect(service.runSync('admin-1')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'An identity sync cycle is already running.',
    });
  });

  it('propagates a provider failure untouched', async () => {
    const { worker, service } = setup();
    const failure = new Error('keycloak unreachable');
    worker.runOnce.mockRejectedValue(failure);

    await expect(service.runSync('admin-1')).rejects.toBe(failure);
  });

  it('propagates a non-Error rejection as well', async () => {
    const { worker, service } = setup();
    worker.runOnce.mockRejectedValue('boom');

    await expect(service.runSync('admin-1')).rejects.toBe('boom');
  });
});

describe('disableUser', () => {
  /** The five statements an offboarding issues; each test varies one of them. */
  function disableRoutes(
    overrides: {
      lookup?: RouteResult;
      entitlements?: RouteResult;
      update?: RouteResult;
    } = {},
  ): Parameters<typeof fakeDb>[0] {
    return [
      [
        'SELECT enabled FROM idp_user',
        overrides.lookup ?? { rows: [{ enabled: true }], rowCount: 1 },
      ],
      [
        'FROM entitlement e',
        overrides.entitlements ?? {
          rows: [
            { instance_id: 'inst-1', product: 'EspoCRM', sync_state: 'applied' },
            { instance_id: 'inst-2', product: 'Wiki', sync_state: 'pending' },
          ],
          rowCount: 2,
        },
      ],
      [
        'UPDATE idp_user SET enabled = false',
        overrides.update ?? {
          rows: [{ updated_at: new Date('2026-04-01T10:00:00.000Z') }],
          rowCount: 1,
        },
      ],
      ['DELETE FROM role_binding WHERE subject_idp_id', { rows: [], rowCount: 3 }],
      ['DELETE FROM entitlement WHERE subject_idp_id', { rows: [], rowCount: 2 }],
    ];
  }

  it('disables at the provider, revokes the platform side and kills the sessions', async () => {
    const { db, audit, sessions, provider, productAccounts, service } = setup(disableRoutes());

    const response = await service.disableUser('u-1', 'admin-1');

    // The provider is the authority: the mirror is rebuilt from it on the next cycle.
    expect(provider.setUserEnabled).toHaveBeenCalledWith('u-1', false);
    expect(response).toMatchObject({
      userId: 'u-1',
      disabledAt: '2026-04-01T10:00:00.000Z',
      sessionsTerminated: 2,
      entitlements: [
        { instanceId: 'inst-1', product: 'EspoCRM', syncState: 'applied' },
        { instanceId: 'inst-2', product: 'Wiki', syncState: 'pending' },
      ],
    });
    expect(response.propagationNote).toContain('guarantee class');
    // Authority first, then the entitlements it produced.
    expect(
      db.calls.find((call) => call.sql.includes('DELETE FROM role_binding WHERE subject_idp_id'))
        ?.params,
    ).toEqual(['u-1']);
    expect(
      db.calls.find((call) => call.sql.includes('DELETE FROM entitlement WHERE subject_idp_id'))
        ?.params,
    ).toEqual(['u-1']);
    expect(sessions.killSubject).toHaveBeenCalledWith('u-1', 'user disabled');
    // ADR-BE-22: offboarding reaches the product account too, before the platform sessions go.
    expect(productAccounts.deprovision).toHaveBeenCalledWith('u-1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.disabled',
        actorId: 'admin-1',
        targetId: 'u-1',
        detail: { entitlements: 2, note: 'group_mapping untouched (invariant 10)' },
      }),
      expect.anything(),
    );
    // Invariant 10: the worker's own table is never touched by an offboarding.
    expect(db.calls.some((call) => call.sql.includes('group_mapping'))).toBe(false);
  });

  it('refuses an unknown account before calling the provider', async () => {
    const { provider, service } = setup([
      ['SELECT enabled FROM idp_user', { rows: [], rowCount: 0 }],
    ]);

    await expect(service.disableUser('ghost', 'admin-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No directory object ghost.',
    });
    expect(provider.setUserEnabled).not.toHaveBeenCalled();
  });

  it('refuses a second disable as a state conflict, not a missing user', async () => {
    const { provider, service } = setup([
      ['SELECT enabled FROM idp_user', { rows: [{ enabled: false }], rowCount: 1 }],
    ]);

    await expect(service.disableUser('u-1', 'admin-1')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'Directory user u-1 is already disabled.',
    });
    expect(provider.setUserEnabled).not.toHaveBeenCalled();
  });

  it('reports a lost race as a missing user and writes no audit row', async () => {
    const { audit, sessions, service } = setup(
      disableRoutes({ update: { rows: [], rowCount: 0 } }),
    );

    await expect(service.disableUser('u-1', 'admin-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(audit.append).not.toHaveBeenCalled();
    expect(sessions.killSubject).not.toHaveBeenCalled();
  });

  it('counts zero revoked entitlements when the read reports no row count', async () => {
    const { audit, service } = setup(disableRoutes({ entitlements: { rows: [], rowCount: null } }));

    await service.disableUser('u-1', 'admin-1');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ entitlements: 0 }) }),
      expect.anything(),
    );
  });

  it('dates the offboarding from the clock when the UPDATE returns no row body', async () => {
    const before = Date.now();
    const { service } = setup(disableRoutes({ update: { rows: [], rowCount: 1 } }));

    const response = await service.disableUser('u-1', 'admin-1');

    expect(new Date(response.disabledAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('accessRequests', () => {
  it('resolves both people and the owning domain for the queue', async () => {
    const { service } = setup([
      [
        'FROM access_request ar',
        [
          {
            id: 'req-1',
            requester_idp_id: 'u-1',
            kind: 'entitlement',
            target: 'espocrm',
            justification: 'quarter close',
            state: 'open',
            created_at: new Date('2026-05-01T00:00:00.000Z'),
            decided_by: 'u-2',
            decided_at: new Date('2026-05-02T00:00:00.000Z'),
            requester_name: 'Alice Anderson',
            decider_name: 'Bob Brown',
            domain: 'crm',
          },
        ],
      ],
    ]);

    await expect(service.accessRequests()).resolves.toEqual([
      {
        id: 'req-1',
        requester: { id: 'u-1', name: 'Alice Anderson' },
        kind: 'entitlement',
        target: 'espocrm',
        justification: 'quarter close',
        state: 'open',
        createdAt: '2026-05-01T00:00:00.000Z',
        decidedBy: 'Bob Brown',
        decidedAt: '2026-05-02T00:00:00.000Z',
        domain: 'crm',
      },
    ]);
  });

  it('reports an undecided request whose requester has left the directory', async () => {
    const { service } = setup([
      [
        'FROM access_request ar',
        [
          {
            id: 'req-2',
            requester_idp_id: 'u-9',
            kind: 'entitlement',
            target: 'espocrm',
            justification: 'need it',
            state: 'open',
            created_at: new Date('2026-05-01T00:00:00.000Z'),
            decided_by: null,
            decided_at: null,
            requester_name: null,
            decider_name: null,
            domain: null,
          },
        ],
      ],
    ]);

    const [request] = await service.accessRequests();

    expect(request).toMatchObject({
      // The identifier is the only name left, and it is better than an empty cell.
      requester: { id: 'u-9', name: 'u-9' },
      decidedBy: null,
      decidedAt: null,
      domain: 'Platform',
    });
  });

  it('keeps the decider identifier when that account is gone', async () => {
    const { service } = setup([
      [
        'FROM access_request ar',
        [
          {
            id: 'req-3',
            requester_idp_id: 'u-1',
            kind: 'entitlement',
            target: 'espocrm',
            justification: 'need it',
            state: 'approved',
            created_at: new Date('2026-05-01T00:00:00.000Z'),
            decided_by: 'u-8',
            decided_at: null,
            requester_name: 'Alice Anderson',
            decider_name: null,
            domain: 'crm',
          },
        ],
      ],
    ]);

    const [request] = await service.accessRequests();

    expect(request?.decidedBy).toBe('u-8');
  });
});

describe('createAccessRequest', () => {
  const entryRoute = (rows: Record<string, unknown>[]): Route => [
    'SELECT domain FROM catalog_entry',
    rows,
  ];
  const requesterRoute = (rows: Record<string, unknown>[]): Route => [
    'SELECT coalesce(display_name, username) AS name',
    rows,
  ];

  it('queue-inserts the request as open and audits it in the same transaction', async () => {
    const { db, audit, service } = setup([
      entryRoute([{ domain: 'crm' }]),
      requesterRoute([{ name: 'Alice Anderson' }]),
      [
        'INSERT INTO access_request',
        { rows: [{ id: 'req-1', created_at: new Date('2026-05-01T00:00:00.000Z') }], rowCount: 1 },
      ],
    ]);

    const request = await service.createAccessRequest(
      { entryKey: 'espocrm', justification: 'quarter close' },
      'u-1',
    );

    expect(request).toEqual({
      id: 'req-1',
      requester: { id: 'u-1', name: 'Alice Anderson' },
      kind: 'entitlement',
      target: 'espocrm',
      justification: 'quarter close',
      state: 'open',
      createdAt: '2026-05-01T00:00:00.000Z',
      decidedBy: null,
      decidedAt: null,
      domain: 'crm',
    });
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO access_request'));
    expect(insert?.params).toEqual(['u-1', 'espocrm', 'quarter close']);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access.requested',
        actorId: 'u-1',
        targetType: 'catalog_entry',
        targetId: 'espocrm',
        detail: { requestId: 'req-1' },
      }),
      expect.anything(),
    );
  });

  it('refuses an entry that is not requestable', async () => {
    const { db, service } = setup([entryRoute([]), requesterRoute([{ name: 'Alice Anderson' }])]);

    await expect(
      service.createAccessRequest({ entryKey: 'nope', justification: 'why not' }, 'u-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', detail: 'No catalog entry nope.' });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO access_request'))).toBe(false);
  });

  it('falls back to the identifier and the platform domain when neither is mirrored', async () => {
    const { service } = setup([
      entryRoute([{}]),
      requesterRoute([]),
      [
        'INSERT INTO access_request',
        { rows: [{ id: 'req-2', created_at: new Date('2026-05-01T00:00:00.000Z') }], rowCount: 1 },
      ],
    ]);

    await expect(
      service.createAccessRequest({ entryKey: 'espocrm', justification: 'x' }, 'u-9'),
    ).resolves.toMatchObject({
      requester: { id: 'u-9', name: 'u-9' },
      domain: 'Platform',
    });
  });

  it('fails the cycle when the insert produces no row to report', async () => {
    const { audit, service } = setup([
      entryRoute([{ domain: 'crm' }]),
      requesterRoute([{ name: 'Alice Anderson' }]),
      ['INSERT INTO access_request', { rows: [], rowCount: 0 }],
    ]);

    await expect(
      service.createAccessRequest({ entryKey: 'espocrm', justification: 'x' }, 'u-1'),
    ).rejects.toThrow('access_request insert returned no row');
    // The audit row joins the transaction, so a rolled-back insert leaves no trace.
    expect(audit.append).not.toHaveBeenCalled();
  });
});

describe('accessRequest', () => {
  it('reads one request for a caller checking a rule before deciding it', async () => {
    const { service } = setup([
      [
        'SELECT requester_idp_id, kind, target',
        [
          {
            requester_idp_id: 'u-1',
            kind: 'entitlement',
            target: 'espocrm',
            justification: 'quarter close',
            state: 'open',
            created_at: new Date('2026-05-01T00:00:00.000Z'),
          },
        ],
      ],
    ]);

    await expect(service.accessRequest('req-1')).resolves.toEqual({
      requesterIdpId: 'u-1',
      kind: 'entitlement',
      target: 'espocrm',
      justification: 'quarter close',
      state: 'open',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
    });
  });

  it('refuses an unknown request', async () => {
    const { service } = setup([['SELECT requester_idp_id, kind, target', []]]);

    await expect(service.accessRequest('req-x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No access request req-x.',
    });
  });
});

describe('decideAccessRequest', () => {
  /**
   * The caller owns the transaction: this is the row lock plus the transition and nothing more, so
   * the double records the statements the transition issued rather than a schema.
   */
  function transaction(rows: Record<string, unknown>[]) {
    const params: unknown[][] = [];
    const queryable = {
      query: vi.fn(async (_sql: string, values: unknown[] = []) => {
        params.push(values);
        return { rows, rowCount: rows.length };
      }),
    };
    return { service: setup().service, tx: queryable as unknown as Queryable, params };
  }

  const openRow = {
    state: 'open',
    requester_idp_id: 'u-1',
    kind: 'entitlement',
    target: 'espocrm',
  };

  it('approves an open request and returns what governance needs to grant it', async () => {
    const { service, tx, params } = transaction([openRow]);

    await expect(
      service.decideAccessRequest(tx, { id: 'req-1', decision: 'approve', actorId: 'admin-1' }),
    ).resolves.toEqual({ requesterIdpId: 'u-1', kind: 'entitlement', target: 'espocrm' });
    // The lock reads first, then the transition; both by id.
    expect(params).toEqual([['req-1'], ['req-1', 'approved', 'admin-1']]);
  });

  it('rejects an open request', async () => {
    const { service, tx, params } = transaction([openRow]);

    await service.decideAccessRequest(tx, {
      id: 'req-1',
      decision: 'reject',
      actorId: 'admin-1',
    });

    expect(params[1]).toEqual(['req-1', 'rejected', 'admin-1']);
  });

  it('refuses an unknown request', async () => {
    const { service, tx } = transaction([]);

    await expect(
      service.decideAccessRequest(tx, { id: 'req-x', decision: 'approve', actorId: 'admin-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', detail: 'No access request req-x.' });
  });

  it('refuses to decide a request that is no longer open', async () => {
    const { service, tx, params } = transaction([{ ...openRow, state: 'approved' }]);

    await expect(
      service.decideAccessRequest(tx, { id: 'req-1', decision: 'approve', actorId: 'admin-1' }),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
      detail: 'The access request is approved and cannot be approved.',
    });
    // No transition was issued on the refused decision.
    expect(params).toHaveLength(1);
  });
});
