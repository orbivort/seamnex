import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import type { AuditService } from '../../../../src/modules/m17-audit/audit.contract';
import type { SessionService } from '../../../../src/modules/m10-portal-bff/session.contract';
import type {
  DirectoryGroup,
  DirectorySnapshot,
  DirectoryUser,
  IdentityProvider,
} from '../../../../src/common/identity/identity-provider.contract';
import {
  percentile95,
  SyncWorkerService,
} from '../../../../src/modules/m08-identity-sync/sync-worker.service';

/**
 * The worker is one cycle, and its contract is what the run row records: the mirror converges
 * rather than accumulates, every derived write is reconciled by difference, a provider fault is
 * `failed` and not `partial`, and a cycle that cannot be audited still finishes. Each is asserted
 * against the statements issued and the parameters they carried, because every one of these
 * defects used to leave a `succeeded` row behind.
 */

const RUN = { id: 'run-1', started_at: new Date('2026-01-01T00:00:00.000Z') };

function dirUser(sub: string, overrides: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    sub,
    username: sub,
    displayName: sub,
    email: `${sub}@example.test`,
    groups: [],
    enabled: true,
    mfaEnrolled: true,
    ...overrides,
  };
}

function dirGroup(id: string, path: string, members: readonly string[] = []): DirectoryGroup {
  return { id, path, members };
}

const EMPTY: DirectorySnapshot = { users: [], groups: [] };

function setup(
  snapshot: DirectorySnapshot = EMPTY,
  routes: Parameters<typeof fakeDb>[0] = [],
  options: { pushEnabled?: boolean } = {},
) {
  const db = fakeDb(routes);
  const config = {
    SEAMNEX_SYNC_INTERVAL_MS: 60_000,
    SEAMNEX_IDENTITY_PUSH_ENABLED: options.pushEnabled ?? false,
  } as unknown as AppConfig;
  const provider = { directory: vi.fn(async () => snapshot) };
  const audit = { append: vi.fn(async () => ({ seq: '1', hash: 'h' })) };
  const sessions = { killSubject: vi.fn(async () => 1) };
  const push = { push: vi.fn(async () => ({ ok: true, detail: 'HTTP 200' })) };
  const worker = new SyncWorkerService(
    db.pool,
    config,
    provider as unknown as IdentityProvider,
    audit as unknown as AuditService,
    sessions as unknown as SessionService,
    push,
  );
  return { db, provider, audit, sessions, push, worker };
}

/**
 * The row count a `mirrored.rowCount === 1` test reads; `rows` is unused by the worker. `null` is
 * the driver's row count for a statement it could not measure, which must count as zero.
 */
function affected(rowCount: number | null) {
  return { rows: [], rowCount };
}

type CycleOptions = {
  enabledBefore?: Record<string, unknown>[];
  userInserts?: number | null;
  groupInserts?: number | null;
  stale?: Record<string, unknown>[];
  groupDeletes?: number | null;
  removed?: number | null;
  added?: number | null;
  withdrawn?: number | null;
  bindings?: number | null;
  conflicts?: Record<string, unknown>[];
  plans?: Record<string, unknown>[];
  entitlements?: number | null;
  withdrawnEntitlements?: number | null;
  propagation?: Record<string, unknown>[];
};

/** Distinguishes "not stated" from an explicit `null`, which is a row count the driver lost. */
function pick(value: number | null | undefined, fallback: number): number | null {
  return value === undefined ? fallback : value;
}

/** One full cycle's statements, in source order; a test overrides the row count it cares about. */
function cycleRoutes(options: CycleOptions = {}): Parameters<typeof fakeDb>[0] {
  return [
    ['INSERT INTO sync_run', { rows: [RUN], rowCount: 1 }],
    ['FROM idp_user WHERE enabled', options.enabledBefore ?? []],
    ['INSERT INTO idp_user', affected(pick(options.userInserts, 1))],
    ['INSERT INTO idp_group (', affected(pick(options.groupInserts, 1))],
    ['EXISTS (SELECT 1 FROM group_mapping', options.stale ?? []],
    ['DELETE FROM idp_group WHERE', affected(pick(options.groupDeletes, 0))],
    ['DELETE FROM idp_group_member', affected(pick(options.removed, 0))],
    ['INSERT INTO idp_group_member', affected(pick(options.added, 0))],
    ['DELETE FROM role_binding rb', affected(pick(options.withdrawn, 0))],
    ['INSERT INTO role_binding', affected(pick(options.bindings, 0))],
    ['AS blocking', options.conflicts ?? []],
    ["c.payload #>> '{integration,rolePush,path}'", options.plans ?? []],
    ['INSERT INTO entitlement (subject_idp_id', affected(pick(options.entitlements, 0))],
    ['DELETE FROM entitlement e', affected(pick(options.withdrawnEntitlements, 0))],
    ['INSERT INTO propagation_sample', affected(0)],
    ['SELECT latency_ms FROM propagation_sample', options.propagation ?? []],
    ['DELETE FROM propagation_sample', affected(0)],
    ['UPDATE sync_run', affected(1)],
  ];
}

/** Lets a fire-and-forget `.catch` handler run without a timer. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('percentile95', () => {
  it.each([
    ['an empty sample set, where NaN would be worse than zero', [], 0],
    ['a single sample', [7], 7],
    ['a sample set of one', [3.4], 3],
    ['nineteen percent of the tail', [5, 1, 9], 9],
    ['the nearest rank of a short run', Array.from({ length: 20 }, (_, i) => i + 1), 19],
    ['the nearest rank of a full run', Array.from({ length: 100 }, (_, i) => i + 1), 95],
  ] as const)('reports %s', (_label, samples, expected) => {
    expect(percentile95(samples)).toBe(expected);
  });
});

describe('a complete cycle', () => {
  it('mirrors the directory, reconciles every derived row and records the run', async () => {
    const { db, audit, sessions, worker } = setup(
      { users: [dirUser('u-1')], groups: [dirGroup('core', '/core', ['u-1'])] },
      cycleRoutes({
        removed: 1,
        added: 1,
        withdrawn: 1,
        bindings: 2,
        entitlements: 1,
        withdrawnEntitlements: 1,
      }),
    );

    const run = await worker.runOnce('manual');

    // 1 user + 1 group + 1 removed + 1 added membership + 1 withdrawn binding + 2 bindings
    // + 1 entitlement + 1 withdrawn entitlement.
    expect(run).toMatchObject({
      id: 'run-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      users: 1,
      groups: 1,
      changes: 9,
      errors: [],
      state: 'succeeded',
    });
    expect(run.p95LatencyMs).toBeGreaterThanOrEqual(0);

    const bySql = (fragment: string) => db.calls.find((call) => call.sql.includes(fragment));
    expect(bySql('INSERT INTO sync_run')?.params).toEqual(['{"trigger":"manual"}']);
    expect(bySql('INSERT INTO idp_user')?.params).toEqual([
      'u-1',
      'u-1',
      'u-1@example.test',
      'u-1',
      true,
      true,
    ]);
    expect(bySql('INSERT INTO idp_group (')?.params).toEqual(['core', '/core', 1]);
    // One membership snapshot is what both the delete and the insert reconcile against.
    expect(bySql('DELETE FROM idp_group_member')?.params).toEqual([
      '[{"sub":"u-1","group_idp_id":"core"}]',
    ]);
    expect(bySql('INSERT INTO idp_group_member')?.params).toEqual([
      '[{"sub":"u-1","group_idp_id":"core"}]',
    ]);

    /*
     * FR-2.4: the state is derived inside the statement from the class *and* the route, so `applied`
     * cannot be written for a native product whose identity client was never configured, and the
     * product role comes from the mapping rather than a literal.
     */
    const entitlementWrite = bySql('INSERT INTO entitlement (subject_idp_id');
    expect(entitlementWrite?.params[0]).toEqual('[{"sub":"u-1","group_idp_id":"core"}]');
    expect(entitlementWrite?.sql).toContain(
      "c.guarantee_class = 'native' AND r.auth_mode IN ('oidc', 'saml')",
    );
    expect(entitlementWrite?.sql).toContain('gm.product_role');
    // Nothing was in conflict, so nothing was excluded from the entitlement write.
    expect(entitlementWrite?.params[1]).toEqual([]);

    const finished = bySql('UPDATE sync_run');
    expect(finished?.params.slice(0, 4)).toEqual(['run-1', 9, run.p95LatencyMs, 0]);
    expect(finished?.params[4]).toBeNull();
    expect(finished?.params[5]).toBe(0);
    expect(JSON.parse(String(finished?.params[6]))).toEqual({
      trigger: 'manual',
      users: 1,
      groups: 1,
      errors: [],
      outcome: 'succeeded',
      propagationPending: 0,
      propagationPendingReasons: [],
    });

    expect(audit.append).toHaveBeenCalledWith({
      action: 'identity.sync.completed',
      actorType: 'system',
      actorId: 'sync-worker',
      targetType: 'sync_run',
      targetId: 'run-1',
      outcome: 'success',
      detail: {
        trigger: 'manual',
        changes: 9,
        users: 1,
        groups: 1,
        p95LatencyMs: run.p95LatencyMs,
        p95PropagationMs: null,
        propagationSamples: 0,
      },
    });
    // Nobody was disabled, so no session was touched.
    expect(sessions.killSubject).not.toHaveBeenCalled();
  });

  it('treats an empty directory as a mirror to converge, not a group list to trust', async () => {
    const { db, worker } = setup(EMPTY, cycleRoutes({ removed: 2, added: 3 }));

    const run = await worker.runOnce('bootstrap');

    expect(run).toMatchObject({ users: 0, groups: 0, changes: 5, state: 'succeeded' });
    // An empty group list is a failed read, so nothing is deleted on the strength of it.
    expect(db.calls.some((call) => call.sql.includes('DELETE FROM idp_group WHERE'))).toBe(false);
    expect(db.calls.some((call) => call.sql.includes('DELETE FROM role_binding rb'))).toBe(false);
    // The membership mirror still reconciles: the directory describes zero memberships.
    expect(
      db.calls.find((call) => call.sql.includes('DELETE FROM idp_group_member'))?.params,
    ).toEqual(['[]']);
  });

  it('counts a statement the driver could not measure as zero changes', async () => {
    const { worker } = setup(
      { users: [dirUser('u-1')], groups: [dirGroup('core', '/core', ['u-1'])] },
      cycleRoutes({
        stale: [{ idp_id: 'old', path: '/old', mapped: false }],
        userInserts: null,
        groupInserts: null,
        groupDeletes: null,
        removed: null,
        added: null,
        withdrawn: null,
        bindings: null,
        entitlements: null,
        withdrawnEntitlements: null,
      }),
    );

    const run = await worker.runOnce('manual');

    // `rowCount` is nullable; a null must not become NaN in the arithmetic or in the run row.
    expect(run.changes).toBe(0);
    expect(run.state).toBe('succeeded');
  });

  it('counts an unchanged user and group as no change', async () => {
    const { db, worker } = setup(
      { users: [dirUser('u-1'), dirUser('u-2')], groups: [dirGroup('core', '/core')] },
      cycleRoutes({ userInserts: 0, groupInserts: 0 }),
    );

    const run = await worker.runOnce('interval');

    expect(run.changes).toBe(0);
    // The INSERT is issued per row regardless; the row count is what the WHERE ... IS DISTINCT
    // FROM clause decides.
    expect(db.calls.filter((call) => call.sql.includes('INSERT INTO idp_user'))).toHaveLength(2);
  });
});

describe('stale groups', () => {
  it('deletes what the directory no longer vouches for and names what it kept', async () => {
    const { db, worker } = setup(
      { users: [], groups: [dirGroup('core', '/core')] },
      cycleRoutes({
        stale: [
          { idp_id: 'old', path: '/old', mapped: false },
          { idp_id: 'kept', path: '/kept', mapped: true },
        ],
        groupDeletes: 1,
        userInserts: 0,
        groupInserts: 0,
      }),
    );

    const run = await worker.runOnce('manual');

    expect(
      db.calls.find((call) => call.sql.includes('DELETE FROM idp_group WHERE'))?.params,
    ).toEqual([['old']]);
    // The group list of the snapshot is what the delete is keyed against.
    expect(
      db.calls.find((call) => call.sql.includes('EXISTS (SELECT 1 FROM group_mapping'))?.params,
    ).toEqual([['core']]);
    expect(run.errors).toEqual([
      '/kept is no longer in the directory but still carries a durable mapping; the group row was ' +
        'kept so the mapping is not deleted silently. Remove the mapping to retire the group.',
    ]);
    expect(run.state).toBe('partial');
    // The delete counts as one change.
    expect(run.changes).toBe(1);
  });

  it('issues no delete when every stale group still carries a mapping', async () => {
    const { db, worker } = setup(
      { users: [], groups: [dirGroup('core', '/core')] },
      cycleRoutes({
        stale: [{ idp_id: 'kept', path: '/kept', mapped: true }],
        userInserts: 0,
        groupInserts: 0,
      }),
    );

    await worker.runOnce('manual');

    expect(db.calls.some((call) => call.sql.includes('DELETE FROM idp_group WHERE'))).toBe(false);
  });
});

/**
 * FR-2.4 / AC-11 / S-8 — the grant the product actually received.
 *
 * The cycle owns two decisions here: which product role a membership grants (the mapping's, not a
 * literal `member`) and whether the platform can claim the product applied it. `applied` is written
 * only after a push the product accepted; everything else stays `pending` with the reason, and the
 * propagation sample records the interval the change took.
 */
type PushCycleOptions = CycleOptions & {
  /** Rows the entitlement write returns — the changes this cycle has to decide about. */
  granted?: Record<string, unknown>[];
};

function pushRoutes(options: PushCycleOptions = {}): readonly Route[] {
  return [
    // Prepended so it wins over the generic route inside `cycleRoutes`, which only counts rows.
    ['INSERT INTO entitlement (subject_idp_id', options.granted ?? []],
    ['UPDATE entitlement', affected(1)],
    ...(cycleRoutes(options) ?? []),
  ];
}

const PENDING_GRANT = {
  subject_idp_id: 'u-1',
  instance_id: 'i-1',
  product_role: 'Manager',
  sync_state: 'pending',
};

const PUSH_PLAN = {
  instance_id: 'i-1',
  slug: 'crm',
  guarantee_class: 'native',
  auth_mode: null,
  push_path: '/api/users/roles',
  push_role_field: 'role',
  push_secret_name: 'crm-admin-token',
  api_base_url: 'http://crm:8080',
};

/** The JSON the cycle hands to `propagation_sample`, which is what the evidence screen reads. */
function sampledChanges(db: ReturnType<typeof fakeDb>): Record<string, unknown>[] {
  const insert = db.calls.find((call) => call.sql.includes('INSERT INTO propagation_sample'));
  return JSON.parse(String(insert?.params[2])) as Record<string, unknown>[];
}

describe('product role propagation', () => {
  it('applies the grant only after the product accepted the push, and measures how long it took', async () => {
    const { db, push, worker } = setup(
      { users: [dirUser('u-1')], groups: [dirGroup('core', '/core', ['u-1'])] },
      pushRoutes({
        granted: [PENDING_GRANT],
        plans: [PUSH_PLAN],
        propagation: [{ latency_ms: 4_200 }],
        entitlements: 1,
      }),
      { pushEnabled: true },
    );

    const run = await worker.runOnce('manual');

    expect(push.push).toHaveBeenCalledWith({
      instanceId: 'i-1',
      slug: 'crm',
      baseUrl: 'http://crm:8080',
      path: '/api/users/roles',
      roleField: 'role',
      secretName: 'crm-admin-token',
      subjectIdpId: 'u-1',
      email: 'u-1@example.test',
      // The mapping's product role, not the literal `member` the platform used to send.
      productRole: 'Manager',
    });

    const applied = db.calls.find((call) => call.sql.includes('UPDATE entitlement'));
    expect(applied?.params).toEqual(['u-1', 'i-1', 'Manager']);
    expect(applied?.sql).toContain("sync_state = 'applied'");

    // The latency is membership change → applied, over the changes this run recorded.
    expect(run.p95PropagationMs).toBe(4_200);
    expect(run.propagationSamples).toBe(1);
    expect(sampledChanges(db)).toEqual([
      {
        subject: 'u-1',
        instance_id: 'i-1',
        product_role: 'Manager',
        sync_state: 'applied',
        reason: null,
      },
    ]);
  });

  it('leaves the grant pending with the reason when the product refuses the push', async () => {
    const { db, push, worker } = setup(
      { users: [], groups: [] },
      pushRoutes({ granted: [PENDING_GRANT], plans: [PUSH_PLAN] }),
      { pushEnabled: true },
    );
    push.push.mockResolvedValue({ ok: false, detail: 'HTTP 403' });

    const run = await worker.runOnce('manual');

    expect(db.calls.some((call) => call.sql.includes('UPDATE entitlement'))).toBe(false);
    expect(sampledChanges(db)[0]).toMatchObject({
      sync_state: 'pending',
      reason: 'crm: HTTP 403',
    });
    // A subject the directory never mirrored still has an address; the id is the fallback, not a blank.
    expect(push.push).toHaveBeenCalledWith(expect.objectContaining({ email: 'u-1' }));
    // Nothing was measured, so nothing is claimed: a pending change has no latency.
    expect(run.p95PropagationMs).toBeNull();
    expect(run.propagationSamples).toBe(0);

    const finished = db.calls.find((call) => call.sql.includes('UPDATE sync_run'));
    expect(JSON.parse(String(finished?.params[6]))).toMatchObject({
      propagationPending: 1,
      propagationPendingReasons: ['Manager on i-1: crm: HTTP 403'],
    });
  });

  it('records why an entry with no declared role-push API stayed pending', async () => {
    const { db, push, worker } = setup(
      EMPTY,
      pushRoutes({ granted: [PENDING_GRANT], plans: [{ ...PUSH_PLAN, push_path: null }] }),
      { pushEnabled: true },
    );

    await worker.runOnce('manual');

    expect(push.push).not.toHaveBeenCalled();
    expect(sampledChanges(db)[0]).toMatchObject({
      sync_state: 'pending',
      reason: 'crm: no role-push API is declared for this entry',
    });
  });

  it('does not push to a product whose identity client already carries the role', async () => {
    const { push, worker } = setup(
      EMPTY,
      pushRoutes({ granted: [PENDING_GRANT], plans: [{ ...PUSH_PLAN, auth_mode: 'oidc' }] }),
      { pushEnabled: true },
    );

    await worker.runOnce('manual');

    // The grant is the platform's to record; re-posting it would be a write the product does not need.
    expect(push.push).not.toHaveBeenCalled();
  });

  it('never pushes to a class a push cannot settle', async () => {
    const { push, worker } = setup(
      EMPTY,
      pushRoutes({
        granted: [PENDING_GRANT],
        plans: [{ ...PUSH_PLAN, guarantee_class: 'fa_delegated' }],
      }),
      { pushEnabled: true },
    );

    await worker.runOnce('manual');

    expect(push.push).not.toHaveBeenCalled();
  });

  it('pushes nothing at all while the platform flag is off', async () => {
    const { db, push, worker } = setup(
      EMPTY,
      pushRoutes({ granted: [PENDING_GRANT], plans: [PUSH_PLAN] }),
    );

    await worker.runOnce('manual');

    expect(push.push).not.toHaveBeenCalled();
    // The reason names the switch, so an operator knows the grant is waiting on configuration.
    expect(sampledChanges(db)[0]).toMatchObject({ sync_state: 'pending', reason: null });
  });
});

describe('guarantee-class conflicts', () => {
  it('excludes a blocking instance from the write and reports both kinds of disagreement', async () => {
    const { db, worker } = setup(
      { users: [], groups: [] },
      cycleRoutes({
        conflicts: [
          {
            slug: 'crm',
            key: 'espocrm',
            guarantee_class: 'fa_gate',
            auth_mode: null,
            blocking: true,
          },
          {
            slug: 'wiki',
            key: 'wiki',
            guarantee_class: 'native',
            auth_mode: 'fa_gate',
            blocking: false,
          },
        ],
      }),
    );

    const run = await worker.runOnce('manual');

    expect(run.errors).toEqual([
      'crm (espocrm): route authMode "none" contradicts guaranteeClass "fa_gate"; its entitlements ' +
        'were skipped because the write would violate the sync-state invariant. Align the route ' +
        'with the catalog entry.',
      'wiki (wiki): route authMode "fa_gate" contradicts guaranteeClass "native"; its entitlements ' +
        'were synced, but the portal will mislabel the sign-in path. Align the route with the ' +
        'catalog entry.',
    ]);
    // Only the blocking instance is withheld from the entitlement write.
    expect(
      db.calls.find((call) => call.sql.includes('INSERT INTO entitlement (subject_idp_id'))
        ?.params[1],
    ).toEqual(['crm']);
    expect(run.state).toBe('partial');
  });
});

describe('disabled accounts', () => {
  it('kills the sessions of an account the provider disabled mid-cycle, once', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { sessions, worker } = setup(
      {
        users: [
          dirUser('u-1', { enabled: false }),
          dirUser('u-2', { enabled: false }),
          dirUser('u-3', { enabled: true }),
        ],
        groups: [],
      },
      cycleRoutes({ enabledBefore: [{ idp_id: 'u-1' }] }),
    );

    await worker.runOnce('manual');

    // u-1 was enabled before the mirror overwrote it; u-2 was already disabled; u-3 stays enabled.
    expect(sessions.killSubject).toHaveBeenCalledTimes(1);
    expect(sessions.killSubject).toHaveBeenCalledWith(
      'u-1',
      'identity provider disabled the account',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'disabled account sessions terminated',
        sub: 'u-1',
        killed: 1,
      }),
    );
    warn.mockRestore();
  });
});

describe('failures', () => {
  it('records a provider fault as failed and releases the cycle guard', async () => {
    const { db, provider, audit, worker } = setup(EMPTY, cycleRoutes());
    provider.directory.mockRejectedValueOnce(new Error('keycloak 401'));

    await expect(worker.runOnce('manual')).rejects.toThrow('keycloak 401');

    // `failed`, not `partial`: nothing was reconciled, so nothing may read as a disagreement.
    const recorded = db.calls.find((call) => call.sql.includes('SET finished_at = now(), errors'));
    expect(recorded?.params.slice(0, 2)).toEqual(['run-1', 1]);
    expect(JSON.parse(String(recorded?.params[2]))).toEqual({
      trigger: 'manual',
      users: 0,
      groups: 0,
      errors: ['keycloak 401'],
      outcome: 'failed',
    });
    expect(audit.append).not.toHaveBeenCalled();
    // A second cycle is possible: the guard is released in `finally`.
    await expect(worker.runOnce('manual')).resolves.toMatchObject({ state: 'succeeded' });
  });

  it('records a non-Error rejection by its string form', async () => {
    const { db, provider, worker } = setup(EMPTY, cycleRoutes());
    provider.directory.mockRejectedValueOnce('boom');

    await expect(worker.runOnce('manual')).rejects.toBe('boom');

    const recorded = db.calls.find((call) => call.sql.includes('SET finished_at = now(), errors'));
    expect(JSON.parse(String(recorded?.params[2]))).toMatchObject({
      errors: ['boom'],
      outcome: 'failed',
    });
  });

  it('still reports the original failure when the failure cannot be recorded', async () => {
    const { provider, worker } = setup(EMPTY, [
      ['INSERT INTO sync_run', { rows: [RUN], rowCount: 1 }],
      [
        'UPDATE sync_run',
        () => {
          throw new Error('database gone');
        },
      ],
    ]);
    provider.directory.mockRejectedValueOnce(new Error('keycloak 401'));

    await expect(worker.runOnce('manual')).rejects.toThrow('keycloak 401');
  });

  it('refuses a cycle whose run row could not be created', async () => {
    const { provider, worker } = setup(EMPTY, [
      ['INSERT INTO sync_run', { rows: [], rowCount: 0 }],
    ]);

    await expect(worker.runOnce('manual')).rejects.toThrow('sync_run insert returned no row');
    expect(provider.directory).not.toHaveBeenCalled();
  });

  it('refuses a second cycle while one is in progress', async () => {
    const { worker } = setup({ users: [dirUser('u-1')], groups: [] }, cycleRoutes());

    const first = worker.runOnce('manual');
    // The guard is set before the first await, so a manual request cannot join a live cycle.
    await expect(worker.runOnce('bootstrap')).rejects.toThrow(
      'an identity sync cycle is already running',
    );
    await expect(first).resolves.toMatchObject({ state: 'succeeded' });
  });

  it('completes the cycle when the audit row cannot be written', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { audit, worker } = setup(EMPTY, cycleRoutes());
    audit.append.mockRejectedValue(new Error('audit unavailable'));

    await expect(worker.runOnce('manual')).resolves.toMatchObject({ state: 'succeeded' });
    expect(error).toHaveBeenCalledWith('sync run could not be audited (Error: audit unavailable)');
    error.mockRestore();
  });
});

describe('lifecycle', () => {
  const completed = {
    id: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.000Z',
    users: 0,
    groups: 0,
    changes: 0,
    p95LatencyMs: 0,
    p95PropagationMs: null,
    propagationSamples: 0,
    errors: [],
    state: 'succeeded' as const,
  };

  function timers() {
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation(() => undefined);
    return { unref, timer, setIntervalSpy, clearIntervalSpy };
  }

  it('runs a bootstrap cycle immediately and then on the configured interval', async () => {
    const { worker } = setup();
    const runOnce = vi.spyOn(worker, 'runOnce').mockResolvedValue(completed);
    const { unref, setIntervalSpy } = timers();

    worker.start();
    await flush();

    expect(runOnce).toHaveBeenCalledWith('bootstrap');
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    // The interval must not keep the process alive on its own.
    expect(unref).toHaveBeenCalled();

    const tick = setIntervalSpy.mock.calls[0]?.[0] as () => void;
    tick();
    await flush();
    expect(runOnce).toHaveBeenCalledWith('interval');

    worker.onApplicationShutdown();
  });

  it('refuses to arm a second interval', async () => {
    const { worker } = setup();
    vi.spyOn(worker, 'runOnce').mockResolvedValue(completed);
    const { setIntervalSpy } = timers();

    worker.start();
    worker.start();
    await flush();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it('stops the interval once and is safe to call twice', async () => {
    const { worker } = setup();
    vi.spyOn(worker, 'runOnce').mockResolvedValue(completed);
    const { timer, clearIntervalSpy } = timers();

    worker.onApplicationShutdown(); // nothing armed yet
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    worker.start();
    worker.stop();
    worker.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it('logs a failing scheduled cycle instead of leaving the rejection unhandled', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { worker } = setup();
    const runOnce = vi.spyOn(worker, 'runOnce');
    runOnce.mockRejectedValueOnce(new Error('bootstrap gone'));
    runOnce.mockRejectedValueOnce(new Error('scheduled gone'));
    const { setIntervalSpy } = timers();

    worker.start();
    await flush();
    expect(error).toHaveBeenCalledWith('bootstrap sync failed (Error: bootstrap gone)');

    const tick = setIntervalSpy.mock.calls[0]?.[0] as () => void;
    tick();
    await flush();
    expect(error).toHaveBeenCalledWith('scheduled sync failed (Error: scheduled gone)');
    error.mockRestore();
    worker.stop();
  });
});
