import { describe, expect, it, vi } from 'vitest';
import type { BreakGlassSession, PlatformRole, PrivacyRequest } from '@seamnex/domain';
import type { AppConfig } from '../../../../src/config/config';
import { GovernanceWritesService } from '../../../../src/modules/m18-governance/governance-writes.service';
import { fakeDb, type QueryCall, type Row } from '../../../support/fakes';

/**
 * 4F writes. Every mutation is asserted on three axes: the statement and parameters it writes, the
 * audit entry it appends *inside the same transaction*, and the refusal it throws when a rule does
 * not hold. The pool fake answers `BEGIN`/`COMMIT`/`ROLLBACK` on the same client, so `withTransaction`
 * runs for real and the transaction handed to the audit double is that fake client.
 */

const BG_ID = '018f0000-0000-4000-8000-000000000001';
const INSTANCE_ID = '018f0000-0000-4000-8000-000000000002';
const EXCEPTION_ID = '018f0000-0000-4000-8000-000000000003';
const WINDOW_ID = '018f0000-0000-4000-8000-000000000004';
const DSAR_ID = '018f0000-0000-4000-8000-000000000005';
const ACTOR = 'sub-approver';
const REQUESTER = 'sub-requester';
const WHY = 'Investigating the failing nightly reconciliation job';
/** `bg-${id.slice(0, 8)}`. */
const USERNAME = 'bg-018f0000';
/** A fixed instant far enough ahead that "not expired" does not depend on when the suite runs. */
const FUTURE = new Date('2029-01-01T00:00:00.000Z');

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  const audit = {
    lockChain: vi.fn(async (_tx?: unknown) => undefined),
    append: vi.fn(async (_input: unknown, _tx?: unknown) => ({ seq: '1', hash: 'hash' })),
    verify: vi.fn(async (_from: string, _to: string) => ({
      valid: true,
      checked: 3,
      firstBrokenSeq: null as string | null,
    })),
  };
  const secrets = {
    put: vi.fn(
      async (_scope: string, _ownerId: string, _name: string, _value: string, _tx?: unknown) => ({
        id: 'sec-1',
      }),
    ),
  };
  const identity = {
    accessRequest: vi.fn(async (_id: string): Promise<unknown> => {
      throw new Error('accessRequest is not configured for this test');
    }),
    decideAccessRequest: vi.fn(async (_tx: unknown, _input: unknown): Promise<unknown> => {
      throw new Error('decideAccessRequest is not configured for this test');
    }),
  };
  const portal = {
    grantDirectEntitlement: vi.fn(async (_tx: unknown, _input: unknown) => undefined),
  };
  const privacy = {
    byId: vi.fn(async (_id: string): Promise<PrivacyRequest> => {
      throw new Error('byId is not configured for this test');
    }),
    catalogue: vi.fn(async (_kind: 'export' | 'delete'): Promise<unknown[]> => []),
  };
  const config = { SEAMNEX_REVEAL_TTL_SECONDS: 60 } as unknown as AppConfig;
  const service = new GovernanceWritesService(
    db.pool,
    config,
    audit as never,
    secrets as never,
    identity as never,
    portal as never,
    privacy as never,
  );
  return { db, audit, secrets, identity, portal, privacy, service };
}

function callFor(calls: readonly QueryCall[], matcher: string): QueryCall | undefined {
  return calls.find((call) => call.sql.includes(matcher));
}

function paramsFor(calls: readonly QueryCall[], matcher: string): readonly unknown[] {
  return callFor(calls, matcher)?.params ?? [];
}

function issued(calls: readonly QueryCall[], matcher: string): boolean {
  return calls.some((call) => call.sql.includes(matcher));
}

function bgSessionRow(overrides: Row = {}): Row {
  return {
    id: BG_ID,
    requester: REQUESTER,
    instance_id: INSTANCE_ID,
    access_mode: 'read_write',
    state: 'requested',
    justification: WHY,
    approver: null,
    self_approved: false,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    granted_at: null,
    expires_at: null,
    revoked_at: null,
    created_accounts: [],
    retention_reason: null,
    product: 'Mail',
    requester_name: 'Rita Requester',
    approver_name: null,
    ...overrides,
  };
}

/** The statements `requestBreakGlass` issues, as an order-independent set of matchers. */
function requestRoutes(
  session: Row | undefined,
  options: { present?: boolean; settings?: Row[] } = {},
): Parameters<typeof fakeDb>[0] {
  return [
    ['FROM instance WHERE id::text = $1 OR slug = $1', [{ id: INSTANCE_ID }]],
    ['FROM idp_user WHERE idp_id <>', [{ present: options.present ?? true }]],
    ['INSERT INTO break_glass_session', [{ id: BG_ID }]],
    ['FROM settings WHERE key', options.settings ?? [{ value: 60 }]],
    ['FROM break_glass_session b', session === undefined ? [] : [session]],
  ];
}

function request(service: GovernanceWritesService): Promise<BreakGlassSession> {
  return service.requestBreakGlass(
    { instanceId: INSTANCE_ID, accessMode: 'read_write', justification: WHY },
    ACTOR,
  );
}

describe('requestBreakGlass', () => {
  it('refuses an access mode the contract does not define', async () => {
    const { db, service } = setup();
    await expect(
      service.requestBreakGlass(
        { instanceId: INSTANCE_ID, accessMode: 'admin', justification: WHY },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'Unknown access mode "admin".',
      remediation: 'Use read_only or read_write.',
    });
    expect(db.calls).toEqual([]);
  });

  it('measures the justification after trimming, so padding is not a written reason', async () => {
    const { db, service } = setup();
    await expect(
      service.requestBreakGlass(
        { instanceId: INSTANCE_ID, accessMode: 'read_only', justification: '   too short   ' },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      fieldErrors: [
        { field: 'justification', code: 'minLength', message: 'At least 20 characters.' },
      ],
      remediation: expect.stringContaining('Describe the task'),
    });
    expect(db.calls).toEqual([]);
  });

  it('answers an unknown instance as a client mistake rather than a foreign-key failure', async () => {
    const { db, service } = setup([['FROM instance WHERE id::text = $1 OR slug = $1', []]]);
    await expect(
      service.requestBreakGlass(
        { instanceId: 'D09-01', accessMode: 'read_only', justification: WHY },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'No deployed instance matches "D09-01".',
      remediation: 'Choose an instance from the list; a plan is not yet a deployment.',
      fieldErrors: [{ field: 'instanceId', code: 'unknown', message: 'Instance does not exist.' }],
    });
    expect(issued(db.calls, 'INSERT INTO break_glass_session')).toBe(false);
  });

  it('opens a request for a second party to decide when one exists', async () => {
    const { db, audit, service } = setup(requestRoutes(bgSessionRow()));
    const session = await request(service);

    expect(paramsFor(db.calls, 'INSERT INTO break_glass_session')).toEqual([
      ACTOR,
      INSTANCE_ID,
      'read_write',
      'requested',
      WHY,
      false,
      null,
      null,
      null,
    ]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'breakglass.requested',
        actorId: ACTOR,
        targetType: 'break_glass_session',
        targetId: BG_ID,
        outcome: 'success',
        detail: { instanceId: INSTANCE_ID, accessMode: 'read_write', selfApproved: false },
      }),
      db.client,
    );
    expect(session).toMatchObject({
      id: BG_ID,
      requester: { id: REQUESTER, name: 'Rita Requester' },
      instanceId: INSTANCE_ID,
      product: 'Mail',
      accessMode: 'read_write',
      approver: null,
      selfApproved: false,
      state: 'requested',
      grantedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAccounts: 0,
    });
  });

  it('self-approves and flags it only when no second party exists', async () => {
    const { db, audit, service } = setup(
      requestRoutes(
        bgSessionRow({
          state: 'active',
          approver: ACTOR,
          approver_name: 'Alex Approver',
          self_approved: true,
          granted_at: new Date('2026-01-01T00:00:00.000Z'),
          expires_at: FUTURE,
        }),
        { present: false, settings: [{ value: 90 }] },
      ),
    );
    const session = await request(service);

    const params = paramsFor(db.calls, 'INSERT INTO break_glass_session');
    expect(params.slice(0, 7)).toEqual([
      ACTOR,
      INSTANCE_ID,
      'read_write',
      'active',
      WHY,
      true,
      ACTOR,
    ]);
    expect(params[7]).toBeInstanceOf(Date);
    expect(params[8]).toBeInstanceOf(Date);
    expect((params[8] as Date).getTime() - (params[7] as Date).getTime()).toBe(90 * 60_000);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ selfApproved: true }) }),
      db.client,
    );
    expect(session).toMatchObject({
      state: 'active',
      approver: 'Alex Approver',
      selfApproved: true,
    });
  });

  it.each([
    ['a numeric setting', [{ value: 90 }], 90],
    ['a string setting', [{ value: '45' }], 45],
    ['zero', [{ value: 0 }], 60],
    ['longer than a day', [{ value: 5_000 }], 60],
    ['not a number', [{ value: 'soon' }], 60],
    ['an empty string', [{ value: '' }], 60],
    ['no settings row at all', [], 60],
  ] as ReadonlyArray<readonly [string, Row[], number]>)(
    'applies %s as the elevation length',
    async (_label, settings, minutes) => {
      const { db, service } = setup(requestRoutes(bgSessionRow(), { present: false, settings }));
      await request(service);

      const params = paramsFor(db.calls, 'INSERT INTO break_glass_session');
      expect((params[8] as Date).getTime() - (params[7] as Date).getTime()).toBe(minutes * 60_000);
    },
  );

  it('falls back to the documented duration when the settings table is unreadable', async () => {
    const { db, service } = setup([
      ['FROM instance WHERE id::text = $1 OR slug = $1', [{ id: INSTANCE_ID }]],
      ['FROM idp_user WHERE idp_id <>', [{ present: false }]],
      ['INSERT INTO break_glass_session', [{ id: BG_ID }]],
      ['FROM settings WHERE key', () => Promise.reject(new Error('relation does not exist'))],
      ['FROM break_glass_session b', [bgSessionRow({ state: 'active' })]],
    ]);
    await request(service);

    const params = paramsFor(db.calls, 'INSERT INTO break_glass_session');
    expect((params[8] as Date).getTime() - (params[7] as Date).getTime()).toBe(60 * 60_000);
  });

  it('refuses to answer when the row it just wrote cannot be read back', async () => {
    const { service } = setup(requestRoutes(undefined));
    await expect(request(service)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No break-glass session ${BG_ID}.`,
    });
  });

  it('reports an uncreated row as an internal failure rather than a success', async () => {
    const { service } = setup([
      ['FROM instance WHERE id::text = $1 OR slug = $1', [{ id: INSTANCE_ID }]],
      ['FROM idp_user WHERE idp_id <>', [{ present: true }]],
      ['INSERT INTO break_glass_session', []],
    ]);
    await expect(request(service)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The break-glass request was not created.',
      remediation: 'Retry; nothing was changed.',
    });
  });
});

describe('the break-glass projection', () => {
  it('names the platform when the elevation has no instance', async () => {
    const { service } = setup(requestRoutes(bgSessionRow({ instance_id: null, product: null })));
    const session = await request(service);

    expect(session).toMatchObject({ instanceId: '', product: 'Platform', domainOwner: 'Platform' });
  });

  it('counts created accounts and reports ISO instants only where a column holds one', async () => {
    const { service } = setup(
      requestRoutes(
        bgSessionRow({
          state: 'revoked',
          revoked_at: new Date('2026-01-02T03:04:05.000Z'),
          granted_at: new Date('2026-01-01T00:00:00.000Z'),
          expires_at: new Date('2026-01-01T01:00:00.000Z'),
          created_accounts: [{ username: 'bg-1' }, { username: 'bg-2' }],
          retention_reason: 'break-glass account removed on expiry',
        }),
      ),
    );
    const session = await request(service);

    expect(session).toMatchObject({
      state: 'revoked',
      grantedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T01:00:00.000Z',
      revokedAt: '2026-01-02T03:04:05.000Z',
      createdAccounts: 2,
      retentionReason: 'break-glass account removed on expiry',
    });
  });

  it('derives "expired" from the clock, not from the stored state', async () => {
    const { service } = setup(
      requestRoutes(bgSessionRow({ state: 'active', expires_at: new Date(Date.now() - 60_000) })),
    );
    const session = await request(service);

    expect(session).toMatchObject({ state: 'expired' });
  });

  it('reports an account list that is not an array as zero accounts', async () => {
    const { service } = setup(requestRoutes(bgSessionRow({ created_accounts: null })));
    const session = await request(service);

    expect(session).toMatchObject({ createdAccounts: 0 });
  });
});

function decideRoutes(
  session: Row,
  extra: Parameters<typeof fakeDb>[0] = [],
  read: Row = bgSessionRow(),
): Parameters<typeof fakeDb>[0] {
  return [
    ['requester, state, access_mode', [session]],
    ...extra,
    ['FROM break_glass_session b', [read]],
  ];
}

const APPROVE_UPDATE = "SET state = 'active', approver";
const REJECT_UPDATE = "SET state = 'rejected'";
const REVOKE_UPDATE = "SET state = 'revoked'";
const EXPIRE_UPDATE = "SET state = 'expired' WHERE id = $1 AND state = 'active'";
const RETENTION_UPDATE = 'SET retention_reason = COALESCE(retention_reason';

describe('decideBreakGlass authority', () => {
  it('answers a revoke from a role that may not end an elevation', async () => {
    const { db, service } = setup();
    await expect(service.decideBreakGlass(BG_ID, 'revoke', ACTOR, 'R3')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      detail: 'Ending an elevation needs breakglass.revoke; R3 does not hold it.',
      remediation:
        'An elevation that has run out ends by itself; ask a platform administrator to end a live one early.',
    });
    expect(db.calls).toEqual([]);
  });

  it('answers a decision from a role that may not approve one', async () => {
    const { db, service } = setup();
    await expect(service.decideBreakGlass(BG_ID, 'approve', ACTOR, 'R1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      detail: 'Deciding a request needs breakglass.approve; R1 does not hold it.',
      remediation:
        'The domain owner or an auditor decides the request; the requester never decides their own.',
    });
    expect(db.calls).toEqual([]);
  });

  it('refuses an action the endpoint does not answer', async () => {
    const { service } = setup();
    await expect(service.decideBreakGlass(BG_ID, 'extend', ACTOR, 'R3')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'Unknown action "extend".',
      remediation: 'Use approve, reject, revoke or expire.',
    });
  });

  it('refuses an elevation that does not exist', async () => {
    const { audit, service } = setup([['requester, state, access_mode', []]]);
    await expect(service.decideBreakGlass(BG_ID, 'approve', ACTOR, 'R3')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No break-glass session ${BG_ID}.`,
      remediation: 'Refresh the elevation list.',
    });
    expect(audit.lockChain).toHaveBeenCalledTimes(1);
  });
});

describe('decideBreakGlass approve', () => {
  it('refuses a decision by the requester', async () => {
    const { service } = setup(decideRoutes(bgSessionRow({ requester: ACTOR })));
    await expect(service.decideBreakGlass(BG_ID, 'approve', ACTOR, 'R3')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      detail: 'The requester cannot approve their own elevation.',
      remediation: expect.stringContaining(
        'self-approval only applies when no second party exists',
      ),
    });
  });

  it('refuses a grant whose window has already closed', async () => {
    const { service } = setup(
      decideRoutes(bgSessionRow({ state: 'active', expires_at: new Date(Date.now() - 1_000) })),
    );
    await expect(service.decideBreakGlass(BG_ID, 'approve', ACTOR, 'R3')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'Cannot approve a record in state "expired".',
    });
  });

  it('moves the request to active under the row lock and audits the grant', async () => {
    const { db, audit, service } = setup(
      decideRoutes(
        bgSessionRow(),
        [
          [APPROVE_UPDATE, { rows: [], rowCount: 1 }],
          ['FROM settings WHERE key', [{ value: 30 }]],
        ],
        bgSessionRow({ state: 'active', approver_name: 'Alex Approver' }),
      ),
    );
    const session = await service.decideBreakGlass(BG_ID, 'approve', ACTOR, 'R3');

    const moved = callFor(db.calls, APPROVE_UPDATE);
    expect(moved?.params[0]).toBe(BG_ID);
    expect(moved?.params[1]).toBe(ACTOR);
    expect(moved?.params[2]).toBeInstanceOf(Date);
    expect(String(moved?.sql)).toContain("WHERE id = $1 AND state = 'requested'");
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'breakglass.approve',
        targetId: BG_ID,
        outcome: 'success',
        detail: { accessMode: 'read_write' },
      }),
      db.client,
    );
    expect(session).toMatchObject({ state: 'active', approver: 'Alex Approver' });
  });

  it('does not read an expiry-less grant as overdue', async () => {
    const { service } = setup(
      decideRoutes(bgSessionRow({ state: 'requested', expires_at: null }), [
        [APPROVE_UPDATE, { rows: [], rowCount: 1 }],
        ['FROM settings WHERE key', [{ value: 30 }]],
      ]),
    );
    await expect(service.decideBreakGlass(BG_ID, 'approve', ACTOR, 'R3')).resolves.toBeDefined();
  });
});

type Decision = readonly [action: string, state: string, role: PlatformRole, matcher: string];

const STATE_CONFLICTS: readonly Decision[] = [
  ['approve', 'approved', 'R3', APPROVE_UPDATE],
  ['reject', 'approved', 'R3', REJECT_UPDATE],
  ['revoke', 'requested', 'R1', REVOKE_UPDATE],
  ['expire', 'requested', 'R1', EXPIRE_UPDATE],
];

describe('decideBreakGlass state machine', () => {
  it.each(STATE_CONFLICTS)('refuses to %s a record in state "%s"', async (action, state, role) => {
    const { service } = setup(decideRoutes(bgSessionRow({ state })));
    await expect(service.decideBreakGlass(BG_ID, action, ACTOR, role)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: `Cannot ${action} a record in state "${state}".`,
      remediation: 'Refresh the record; the action may have been taken already.',
    });
  });

  it.each(STATE_CONFLICTS)(
    'refuses a %s whose conditional update moves nothing',
    async (action, _state, role, matcher) => {
      const live = action === 'revoke' || action === 'expire';
      const session = bgSessionRow({
        state: live ? 'active' : 'requested',
        expires_at: live ? new Date(Date.now() + 60_000) : null,
      });
      const { service } = setup(
        decideRoutes(session, [
          [matcher, { rows: [], rowCount: 0 }],
          ['FROM settings WHERE key', [{ value: 30 }]],
        ]),
      );

      await expect(service.decideBreakGlass(BG_ID, action, ACTOR, role)).rejects.toMatchObject({
        code: 'STATE_CONFLICT',
        detail: `Cannot ${action} a record in state "${session.state as string}".`,
      });
    },
  );
});

describe('decideBreakGlass reject, revoke and expire', () => {
  it('rejects a pending request', async () => {
    const { db, audit, service } = setup(
      decideRoutes(
        bgSessionRow(),
        [[REJECT_UPDATE, { rows: [], rowCount: 1 }]],
        bgSessionRow({ state: 'rejected' }),
      ),
    );
    const session = await service.decideBreakGlass(BG_ID, 'reject', ACTOR, 'R3');

    expect(paramsFor(db.calls, REJECT_UPDATE)).toEqual([BG_ID, ACTOR]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'breakglass.reject',
        detail: { accessMode: 'read_write' },
      }),
      db.client,
    );
    expect(session).toMatchObject({ state: 'rejected' });
  });

  it('revokes a live elevation and records that its accounts were revoked', async () => {
    const { db, audit, service } = setup(
      decideRoutes(
        bgSessionRow({ state: 'active', expires_at: new Date(Date.now() + 60_000) }),
        [
          [REVOKE_UPDATE, { rows: [], rowCount: 1 }],
          [RETENTION_UPDATE, { rows: [], rowCount: 1 }],
        ],
        bgSessionRow({ state: 'revoked', revoked_at: new Date('2026-01-02T00:00:00.000Z') }),
      ),
    );
    const session = await service.decideBreakGlass(BG_ID, 'revoke', ACTOR, 'R1');

    expect(paramsFor(db.calls, RETENTION_UPDATE)).toEqual([BG_ID]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'breakglass.revoke',
        detail: { accessMode: 'read_write' },
      }),
      db.client,
    );
    expect(session).toMatchObject({ state: 'revoked', revokedAt: '2026-01-02T00:00:00.000Z' });
  });

  it('records a revoke that lost the race with the clock as an expiry', async () => {
    const { db, audit, service } = setup(
      decideRoutes(
        bgSessionRow({ state: 'active', expires_at: new Date(Date.now() - 60_000) }),
        [
          [EXPIRE_UPDATE, { rows: [], rowCount: 1 }],
          [RETENTION_UPDATE, { rows: [], rowCount: 1 }],
        ],
        bgSessionRow({ state: 'expired' }),
      ),
    );
    const session = await service.decideBreakGlass(BG_ID, 'revoke', ACTOR, 'R1');

    expect(issued(db.calls, REVOKE_UPDATE)).toBe(false);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'breakglass.expired',
        detail: { accessMode: 'read_write', reason: 'window closed before the revoke' },
      }),
      db.client,
    );
    expect(session).toMatchObject({ state: 'expired' });
  });

  it('expires a live elevation', async () => {
    const { db, audit, service } = setup(
      decideRoutes(
        bgSessionRow({ state: 'active', expires_at: new Date(Date.now() + 60_000) }),
        [
          [EXPIRE_UPDATE, { rows: [], rowCount: 1 }],
          [RETENTION_UPDATE, { rows: [], rowCount: 1 }],
        ],
        bgSessionRow({ state: 'expired' }),
      ),
    );
    const session = await service.decideBreakGlass(BG_ID, 'expire', ACTOR, 'R1');

    expect(issued(db.calls, RETENTION_UPDATE)).toBe(true);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'breakglass.expire' }),
      db.client,
    );
    expect(session).toMatchObject({ state: 'expired' });
  });
});

function revealRoutes(
  session: Row | undefined,
  options: { update?: unknown } = {},
): Parameters<typeof fakeDb>[0] {
  return [
    ['retention_reason, reveal_expires_at', session === undefined ? [] : [session]],
    ['SET created_accounts', options.update ?? { rows: [], rowCount: 1 }],
  ];
}

function revealRow(overrides: Row = {}): Row {
  return {
    state: 'active',
    expires_at: new Date(Date.now() + 60_000),
    retention_reason: null,
    reveal_expires_at: null,
    ...overrides,
  };
}

describe('reveal', () => {
  it('refuses an elevation that does not exist', async () => {
    const { service } = setup(revealRoutes(undefined));
    await expect(service.reveal(BG_ID, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No break-glass session ${BG_ID}.`,
    });
  });

  it.each([
    ['not active', { state: 'requested' }],
    ['without an expiry', { expires_at: null }],
    ['already past its expiry', { expires_at: new Date(Date.now() - 60_000) }],
  ] as ReadonlyArray<readonly [string, Row]>)(
    'refuses to reveal a session %s',
    async (_label, overrides) => {
      const { db, service } = setup(revealRoutes(revealRow(overrides)));
      await expect(service.reveal(BG_ID, ACTOR)).rejects.toMatchObject({
        code: 'STATE_CONFLICT',
        detail: 'Only an active, unexpired elevation can reveal a credential.',
        remediation: 'Request a new elevation; an expired account is already revoked.',
      });
      expect(issued(db.calls, 'SET created_accounts')).toBe(false);
    },
  );

  it('refuses a second credential while one is still live', async () => {
    const { db, secrets, service } = setup(
      revealRoutes(revealRow({ reveal_expires_at: new Date(Date.now() + 30_000) })),
    );
    await expect(service.reveal(BG_ID, ACTOR)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
      detail: 'A credential for this elevation is already live.',
      remediation: expect.stringContaining('Reveal again after it expires.'),
    });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(issued(db.calls, 'SET created_accounts')).toBe(false);
  });

  it('mints one credential, records the account and the reveal window', async () => {
    const { db, audit, secrets, service } = setup(revealRoutes(revealRow()));
    const revealed = await service.reveal(BG_ID, ACTOR);

    const put = secrets.put.mock.calls[0] ?? [];
    expect(put[0]).toBe('instance');
    expect(put[1]).toBe(BG_ID);
    expect(put[2]).toBe(`breakglass_${USERNAME}`);
    expect(put[3]).toMatch(/^[0-9a-f]{32}$/);
    expect(put[4]).toBe(db.client);

    const params = paramsFor(db.calls, 'SET created_accounts');
    expect(params[0]).toBe(BG_ID);
    const accounts = JSON.parse(String(params[1])) as Row[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ username: USERNAME, secretRef: 'sec-1' });
    expect(Number.isNaN(Date.parse(String(accounts[0]?.createdAt)))).toBe(false);
    expect(params[2]).toBeInstanceOf(Date);
    expect(params[3]).toBe(USERNAME);

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'breakglass.credential.revealed',
        targetId: BG_ID,
        detail: { username: USERNAME, ttlSeconds: 60 },
      }),
      db.client,
    );
    expect(revealed).toEqual({
      username: USERNAME,
      password: put[3],
      methodNote:
        'in-product account created through the product API where available, otherwise recorded for manual creation',
      expiresAt: (params[2] as Date).toISOString(),
    });
    const ttl = Date.parse(revealed.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('mints a fresh credential once the previous window has passed', async () => {
    const { db, service } = setup(
      revealRoutes(revealRow({ reveal_expires_at: new Date(Date.now() - 1_000) })),
    );
    await service.reveal(BG_ID, ACTOR);

    expect(issued(db.calls, 'SET created_accounts')).toBe(true);
  });
});

function exceptionRow(overrides: Row = {}): Row {
  return {
    id: EXCEPTION_ID,
    rule: 'no-hosted-service',
    scope: 'D01-01',
    justification: 'Needs hosted service until the commercial licence lands',
    state: 'pending',
    expires_at: FUTURE,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    approver: REQUESTER,
    patch_diff: { requestedBy: REQUESTER, diff: '--- a\n+++ b' },
    ...overrides,
  };
}

function exceptionRoutes(
  row: Row | undefined,
  options: { named?: Row[] } = {},
): Parameters<typeof fakeDb>[0] {
  return [
    ['FROM policy_exception WHERE id = $1 FOR UPDATE', row === undefined ? [] : [row]],
    ['UPDATE policy_exception', { rows: [], rowCount: 1 }],
    ['AS name FROM idp_user', options.named ?? [{ name: 'Alex Approver' }]],
  ];
}

describe('decideException', () => {
  it('refuses an id that is not a uuid before opening a transaction', async () => {
    const { db, service } = setup();
    await expect(service.decideException('nope', 'approve', ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No policy exception nope.',
      remediation: 'Refresh the queue; the exception may have been withdrawn.',
    });
    expect(db.calls).toEqual([]);
  });

  it('refuses an exception that is not in the queue', async () => {
    const { service } = setup(exceptionRoutes(undefined));
    await expect(service.decideException(EXCEPTION_ID, 'approve', ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No policy exception ${EXCEPTION_ID}.`,
    });
  });

  it('refuses a decision by the requester named in the written diff', async () => {
    const { service } = setup(exceptionRoutes(exceptionRow()));
    await expect(service.decideException(EXCEPTION_ID, 'approve', REQUESTER)).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
        status: 403,
        detail: 'The requester cannot decide their own policy exception.',
        remediation: 'A second party must decide; the queue exists for exactly this reason.',
      },
    );
  });

  it('refuses an exception whose window has closed', async () => {
    const expiresAt = new Date(Date.now() - 86_400_000);
    const { service } = setup(exceptionRoutes(exceptionRow({ expires_at: expiresAt })));
    await expect(service.decideException(EXCEPTION_ID, 'approve', ACTOR)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
      detail: `This exception expired on ${expiresAt.toISOString()}.`,
      remediation: expect.stringContaining('an expired one cannot be granted'),
    });
  });

  it('refuses an exception that has already been decided', async () => {
    const { service } = setup(exceptionRoutes(exceptionRow({ state: 'approved' })));
    await expect(service.decideException(EXCEPTION_ID, 'reject', ACTOR)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'Cannot reject a record in state "approved".',
    });
  });

  it.each([
    ['approve', 'pending', 'approved'],
    ['approve', 'requested', 'approved'],
    ['reject', 'pending', 'rejected'],
  ] as ReadonlyArray<readonly ['approve' | 'reject', string, string]>)(
    'records a %s against a %s exception and names the decider',
    async (decision, state, expected) => {
      const { db, audit, service } = setup(exceptionRoutes(exceptionRow({ state })));
      const exception = await service.decideException(EXCEPTION_ID, decision, ACTOR);

      expect(paramsFor(db.calls, 'UPDATE policy_exception')).toEqual([
        EXCEPTION_ID,
        expected,
        ACTOR,
      ]);
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({
          action: `policy_exception.${decision}`,
          targetId: EXCEPTION_ID,
          detail: { rule: 'no-hosted-service', scope: 'D01-01', requester: REQUESTER },
        }),
        db.client,
      );
      expect(exception).toEqual({
        id: EXCEPTION_ID,
        rule: 'no-hosted-service',
        scope: 'D01-01',
        justification: 'Needs hosted service until the commercial licence lands',
        requester: REQUESTER,
        approver: 'Alex Approver',
        state: expected,
        requestedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2029-01-01T00:00:00.000Z',
        patchDiff: '--- a\n+++ b',
      });
    },
  );

  it('falls back to the subject identifier when the directory has no name for the decider', async () => {
    const { service } = setup(exceptionRoutes(exceptionRow(), { named: [] }));
    const exception = await service.decideException(EXCEPTION_ID, 'approve', ACTOR);

    expect(exception.approver).toBe(ACTOR);
  });
});

function accessRequestView(overrides: Row = {}): Row {
  return {
    requesterIdpId: REQUESTER,
    kind: 'entitlement',
    target: 'D01-01',
    justification: 'Needs the shop administration role',
    state: 'open',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function namingRow(overrides: Row = {}): Row {
  return {
    requester_name: 'Rita Requester',
    actor_name: 'Alex Approver',
    domain: 'Commerce',
    ...overrides,
  };
}

const GRANT = { requesterIdpId: REQUESTER, kind: 'entitlement', target: 'D01-01' };

describe('decideAccessRequest', () => {
  it('refuses a decision by the requester', async () => {
    const { identity, service } = setup();
    identity.accessRequest.mockResolvedValue(accessRequestView({ requesterIdpId: ACTOR }));

    await expect(service.decideAccessRequest('ar-1', 'approve', ACTOR)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      detail: 'The requester cannot decide their own access request.',
      remediation: 'A second party must decide it.',
    });
    expect(identity.decideAccessRequest).not.toHaveBeenCalled();
  });

  it('refuses a request that is no longer open', async () => {
    const { identity, service } = setup();
    identity.accessRequest.mockResolvedValue(accessRequestView({ state: 'approved' }));

    await expect(service.decideAccessRequest('ar-1', 'approve', ACTOR)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'Cannot approve a record in state "approved".',
    });
  });

  it('grants the entitlement an approval exists for, and audits both', async () => {
    const { db, audit, identity, portal, service } = setup([['AS requester_name', [namingRow()]]]);
    identity.accessRequest.mockResolvedValue(accessRequestView());
    identity.decideAccessRequest.mockResolvedValue(GRANT);

    const decided = await service.decideAccessRequest('ar-1', 'approve', ACTOR);

    expect(identity.decideAccessRequest).toHaveBeenCalledWith(db.client, {
      id: 'ar-1',
      decision: 'approve',
      actorId: ACTOR,
    });
    expect(portal.grantDirectEntitlement).toHaveBeenCalledWith(db.client, {
      subjectIdpId: REQUESTER,
      target: 'D01-01',
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access_request.approve',
        targetType: 'access_request',
        targetId: 'ar-1',
        detail: { requester: REQUESTER, target: 'D01-01' },
      }),
      db.client,
    );
    expect(decided).toMatchObject({
      id: 'ar-1',
      requester: { id: REQUESTER, name: 'Rita Requester' },
      kind: 'entitlement',
      target: 'D01-01',
      justification: 'Needs the shop administration role',
      state: 'approved',
      createdAt: '2026-01-01T00:00:00.000Z',
      decidedBy: 'Alex Approver',
      domain: 'Commerce',
    });
    expect(Number.isNaN(Date.parse(decided.decidedAt ?? ''))).toBe(false);
  });

  it('does not grant anything for a request that is not an entitlement', async () => {
    const { identity, portal, service } = setup([['AS requester_name', [namingRow()]]]);
    identity.accessRequest.mockResolvedValue(accessRequestView({ kind: 'role_binding' }));
    identity.decideAccessRequest.mockResolvedValue({ ...GRANT, kind: 'role_binding' });

    const decided = await service.decideAccessRequest('ar-1', 'approve', ACTOR);

    expect(portal.grantDirectEntitlement).not.toHaveBeenCalled();
    expect(decided.kind).toBe('role_binding');
  });

  it('does not grant on a rejection', async () => {
    const { db, audit, identity, portal, service } = setup([['AS requester_name', [namingRow()]]]);
    identity.accessRequest.mockResolvedValue(accessRequestView());
    identity.decideAccessRequest.mockResolvedValue(GRANT);

    const decided = await service.decideAccessRequest('ar-1', 'reject', ACTOR);

    expect(portal.grantDirectEntitlement).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access_request.reject' }),
      db.client,
    );
    expect(decided.state).toBe('rejected');
  });

  it('echoes the subject identifiers when the directory knows neither party', async () => {
    const { identity, service } = setup([['AS requester_name', []]]);
    identity.accessRequest.mockResolvedValue(accessRequestView());
    identity.decideAccessRequest.mockResolvedValue(GRANT);

    const decided = await service.decideAccessRequest('ar-1', 'approve', ACTOR);

    expect(decided.requester).toEqual({ id: REQUESTER, name: REQUESTER });
    expect(decided.decidedBy).toBe(ACTOR);
    expect(decided.domain).toBe('Platform');
  });
});

describe('expireOverdueBreakGlass', () => {
  it('returns the grants it closed so the caller can audit each one', async () => {
    const { db, service } = setup([
      [
        'RETURNING id, instance_id',
        [
          { id: 'bg-1', instance_id: INSTANCE_ID },
          { id: 'bg-2', instance_id: null },
        ],
      ],
    ]);

    const closed = await service.expireOverdueBreakGlass();

    expect(closed).toEqual([
      { id: 'bg-1', instanceId: INSTANCE_ID },
      { id: 'bg-2', instanceId: null },
    ]);
    expect(paramsFor(db.calls, 'RETURNING id, instance_id')).toEqual([]);
    expect(issued(db.calls, "WHERE state IN ('approved', 'active')")).toBe(true);
  });
});

function windowRow(overrides: Row = {}): Row {
  return {
    id: WINDOW_ID,
    scope: 'Core Operations',
    instance_id: INSTANCE_ID,
    product: 'Mail',
    starts_at: new Date('2026-11-05T10:00:00Z'),
    ends_at: new Date('2026-11-05T12:00:00Z'),
    created_by: ACTOR,
    created_by_label: 'Alex Approver',
    cancelled_at: null,
    ...overrides,
  };
}

function createWindowRoutes(
  options: { instance?: Row[]; inserted?: Row[]; window?: Row[] } = {},
): Parameters<typeof fakeDb>[0] {
  return [
    ['OR entry_key = $1 LIMIT 1', options.instance ?? [{ id: INSTANCE_ID }]],
    ['INSERT INTO maintenance_window', options.inserted ?? [{ id: WINDOW_ID }]],
    ['FROM maintenance_window m', options.window ?? [windowRow()]],
  ];
}

describe('createWindow', () => {
  it('refuses a window with no scope', async () => {
    const { db, service } = setup();
    await expect(
      service.createWindow(
        { scope: '   ', startsAt: '2026-11-05T10:00:00Z', endsAt: '2026-11-05T12:00:00Z' },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'A maintenance window needs a scope.',
      remediation: 'Name the work: an instance, or the platform-wide change it covers.',
      fieldErrors: [{ field: 'scope', code: 'minLength', message: 'At least one character.' }],
    });
    expect(db.calls).toEqual([]);
  });

  it('names the unparseable end instead of handing NaN to the column', async () => {
    const { db, service } = setup();
    await expect(
      service.createWindow(
        { scope: 'Upgrade', startsAt: 'yesterday', endsAt: '2026-11-05T12:00:00Z' },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'Both ends of a maintenance window must be instants.',
      remediation: 'Send an ISO-8601 UTC timestamp, for example 2026-11-05T10:00:00Z.',
      fieldErrors: [{ field: 'startsAt', code: 'invalid', message: 'Not an instant.' }],
    });
    await expect(
      service.createWindow(
        { scope: 'Upgrade', startsAt: '2026-11-05T10:00:00Z', endsAt: 'soon' },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      fieldErrors: [{ field: 'endsAt', code: 'invalid', message: 'Not an instant.' }],
    });
    expect(db.calls).toEqual([]);
  });

  it('refuses a window that does not end after it starts', async () => {
    const { service } = setup();
    await expect(
      service.createWindow(
        { scope: 'Upgrade', startsAt: '2026-11-05T12:00:00Z', endsAt: '2026-11-05T12:00:00Z' },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'A window must end after it starts.',
      remediation: 'Correct the end time.',
    });
  });

  it('refuses an instance reference that matches nothing deployed', async () => {
    const { db, service } = setup([['OR entry_key = $1 LIMIT 1', []]]);
    await expect(
      service.createWindow(
        {
          scope: 'Upgrade',
          instanceId: 'D09-01',
          startsAt: '2026-11-05T10:00:00Z',
          endsAt: '2026-11-05T12:00:00Z',
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'No deployed instance matches "D09-01".',
      remediation:
        'Choose an instance from the list, or leave it empty for a platform-wide window.',
      fieldErrors: [{ field: 'instanceId', code: 'unknown', message: 'Instance does not exist.' }],
    });
    expect(issued(db.calls, 'INSERT INTO maintenance_window')).toBe(false);
  });

  it.each([
    ['an absent reference', undefined],
    ['a blank reference', '   '],
  ] as ReadonlyArray<readonly [string, string | undefined]>)(
    'leaves a platform-wide window unscoped for %s',
    async (_label, instanceId) => {
      const { db, service } = setup(createWindowRoutes());
      await service.createWindow(
        {
          scope: '  Platform upgrade  ',
          instanceId,
          startsAt: '2026-11-05T10:00:00Z',
          endsAt: '2026-11-05T12:00:00Z',
        },
        ACTOR,
      );

      expect(paramsFor(db.calls, 'INSERT INTO maintenance_window')).toEqual([
        'Platform upgrade',
        null,
        new Date('2026-11-05T10:00:00Z'),
        new Date('2026-11-05T12:00:00Z'),
        ACTOR,
      ]);
      expect(issued(db.calls, 'OR entry_key = $1 LIMIT 1')).toBe(false);
    },
  );

  it('creates the window, audits it and answers with the row the list renders', async () => {
    const { db, audit, service } = setup(createWindowRoutes());
    const window = await service.createWindow(
      {
        scope: 'Core Operations',
        instanceId: 'mail',
        startsAt: '2026-11-05T10:00:00Z',
        endsAt: '2026-11-05T12:00:00Z',
      },
      ACTOR,
    );

    expect(paramsFor(db.calls, 'INSERT INTO maintenance_window')).toEqual([
      'Core Operations',
      INSTANCE_ID,
      new Date('2026-11-05T10:00:00Z'),
      new Date('2026-11-05T12:00:00Z'),
      ACTOR,
    ]);
    expect(audit.append).toHaveBeenCalledWith({
      action: 'maintenance.window.created',
      actorType: 'user',
      actorId: ACTOR,
      targetType: 'maintenance_window',
      targetId: WINDOW_ID,
      outcome: 'success',
      detail: {
        scope: 'Core Operations',
        instanceId: INSTANCE_ID,
        startsAt: new Date('2026-11-05T10:00:00Z'),
        endsAt: new Date('2026-11-05T12:00:00Z'),
        suppressesAlerts: true,
      },
    });
    expect(window).toMatchObject({
      id: WINDOW_ID,
      scope: 'Core Operations',
      scopeLabel: 'Mail',
      title: 'Mail maintenance',
      createdBy: 'Alex Approver',
      startsAt: '2026-11-05T10:00:00.000Z',
      endsAt: '2026-11-05T12:00:00.000Z',
    });
  });

  it('reports an uncreated window as an internal failure', async () => {
    const { service } = setup(createWindowRoutes({ inserted: [] }));
    await expect(
      service.createWindow(
        { scope: 'Upgrade', startsAt: '2026-11-05T10:00:00Z', endsAt: '2026-11-05T12:00:00Z' },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The maintenance window was not created.',
    });
  });

  it('refuses to answer when the row it created cannot be read back', async () => {
    const { service } = setup(createWindowRoutes({ window: [] }));
    await expect(
      service.createWindow(
        { scope: 'Upgrade', startsAt: '2026-11-05T10:00:00Z', endsAt: '2026-11-05T12:00:00Z' },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No live maintenance window ${WINDOW_ID}.`,
    });
  });
});

describe('patchWindow', () => {
  it('refuses an id that is not a uuid', async () => {
    const { db, service } = setup();
    await expect(service.patchWindow('nope', {}, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No live maintenance window nope.',
      remediation: expect.stringContaining('cannot be changed'),
    });
    expect(db.calls).toEqual([]);
  });

  it('refuses a window that no longer exists', async () => {
    const { service } = setup([['FROM maintenance_window m', []]]);
    await expect(service.patchWindow(WINDOW_ID, {}, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No live maintenance window ${WINDOW_ID}.`,
    });
  });

  it.each([
    [
      'only the end',
      { endsAt: '2026-11-05T13:00:00Z' },
      '2026-11-05T10:00:00.000Z',
      '2026-11-05T13:00:00.000Z',
    ],
    [
      'only the start',
      { startsAt: '2026-11-05T09:00:00Z' },
      '2026-11-05T09:00:00.000Z',
      '2026-11-05T12:00:00.000Z',
    ],
  ] as ReadonlyArray<readonly [string, Record<string, string>, string, string]>)(
    'moves %s and keeps the other end as it was',
    async (_label, patch, startsAt, endsAt) => {
      const { db, audit, service } = setup([
        ['FROM maintenance_window m', [windowRow()]],
        ['SET starts_at = $2', { rows: [], rowCount: 1 }],
      ]);

      await service.patchWindow(WINDOW_ID, patch, ACTOR);

      const params = paramsFor(db.calls, 'SET starts_at = $2');
      expect((params[1] as Date).toISOString()).toBe(startsAt);
      expect((params[2] as Date).toISOString()).toBe(endsAt);
      expect(audit.append).toHaveBeenCalledWith({
        action: 'maintenance.window.updated',
        actorType: 'user',
        actorId: ACTOR,
        targetType: 'maintenance_window',
        targetId: WINDOW_ID,
        outcome: 'success',
        detail: { startsAt: new Date(startsAt), endsAt: new Date(endsAt) },
      });
    },
  );

  it('keeps both ends when the patch moves neither', async () => {
    const { db, service } = setup([
      ['FROM maintenance_window m', [windowRow()]],
      ['SET starts_at = $2', { rows: [], rowCount: 1 }],
    ]);

    await service.patchWindow(WINDOW_ID, {}, ACTOR);

    expect(paramsFor(db.calls, 'SET starts_at = $2')).toEqual([
      WINDOW_ID,
      new Date('2026-11-05T10:00:00Z'),
      new Date('2026-11-05T12:00:00Z'),
    ]);
  });

  it('refuses to report an edit to a window that was cancelled meanwhile', async () => {
    const { service } = setup([
      ['FROM maintenance_window m', [windowRow()]],
      ['SET starts_at = $2', { rows: [], rowCount: 0 }],
    ]);
    await expect(
      service.patchWindow(WINDOW_ID, { endsAt: '2026-11-05T13:00:00Z' }, ACTOR),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'Cannot edit a record in state "cancelled".',
    });
  });

  it('refuses a patch that would invert the window', async () => {
    const { service } = setup([['FROM maintenance_window m', [windowRow()]]]);
    await expect(
      service.patchWindow(WINDOW_ID, { endsAt: '2026-11-05T09:00:00Z' }, ACTOR),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'A window must end after it starts.',
    });
  });
});

describe('cancelWindow', () => {
  it('refuses an id that is not a uuid', async () => {
    const { db, service } = setup();
    await expect(service.cancelWindow('nope', ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.calls).toEqual([]);
  });

  it('refuses a window that is already cancelled or gone', async () => {
    const { service } = setup([['SET cancelled_at = now()', { rows: [], rowCount: 0 }]]);
    await expect(service.cancelWindow(WINDOW_ID, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No live maintenance window ${WINDOW_ID}.`,
    });
  });

  it('cancels rather than deletes, and records that suppression ended', async () => {
    const { db, audit, service } = setup([['SET cancelled_at = now()', { rows: [], rowCount: 1 }]]);
    await service.cancelWindow(WINDOW_ID, ACTOR);

    expect(paramsFor(db.calls, 'SET cancelled_at = now()')).toEqual([WINDOW_ID]);
    expect(audit.append).toHaveBeenCalledWith({
      action: 'maintenance.window.cancelled',
      actorType: 'user',
      actorId: ACTOR,
      targetType: 'maintenance_window',
      targetId: WINDOW_ID,
      outcome: 'success',
      detail: { suppressionEnded: true },
    });
  });
});

describe('verifyAuditRange', () => {
  it('refuses an inverted range', async () => {
    const { audit, service } = setup();
    await expect(service.verifyAuditRange(9, 4)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'toSeq must be greater than or equal to fromSeq.',
    });
    expect(audit.verify).not.toHaveBeenCalled();
  });

  it('reports a verified range with no broken link', async () => {
    const { audit, service } = setup();
    audit.verify.mockResolvedValue({ valid: true, checked: 12, firstBrokenSeq: null });

    const proof = await service.verifyAuditRange(1, 12);

    expect(audit.verify).toHaveBeenCalledWith('1', '12');
    expect(proof).toMatchObject({
      fromSeq: 1,
      toSeq: 12,
      valid: true,
      checked: 12,
      firstBrokenSeq: null,
    });
    expect(Number.isNaN(Date.parse(proof.verifiedAt))).toBe(false);
  });

  it('names the first broken sequence as a number', async () => {
    const { audit, service } = setup();
    audit.verify.mockResolvedValue({ valid: false, checked: 12, firstBrokenSeq: '7' });

    const proof = await service.verifyAuditRange(1, 12);

    expect(proof).toMatchObject({ valid: false, firstBrokenSeq: 7 });
  });
});

function privacyRequest(overrides: Partial<PrivacyRequest> = {}): PrivacyRequest {
  return {
    id: DSAR_ID,
    subjectRef: 'hash',
    kind: 'export',
    state: 'running',
    openedBy: ACTOR,
    openedAt: '2026-01-01T00:00:00.000Z',
    dueAt: '2026-01-31T00:00:00.000Z',
    closedAt: null,
    scopes: [
      {
        scopeType: 'platform',
        scopeId: 'idp_user',
        label: 'Identity-provider record',
        state: 'pending',
        detail: 'Profile.',
      },
      { scopeType: 'product', scopeId: 'mail', label: 'mail', state: 'complete', detail: 'Dump.' },
    ],
    evidence: ['queued'],
    ...overrides,
  };
}

const ONE_PENDING_SCOPE: PrivacyRequest['scopes'] = [
  {
    scopeType: 'platform',
    scopeId: 'idp_user',
    label: 'Identity',
    state: 'pending',
    detail: 'Profile.',
  },
];

describe('openDsar', () => {
  it('hashes the subject, snapshots the scopes and audits the opening', async () => {
    const { db, audit, privacy, service } = setup([
      ['INSERT INTO subject_ref', []],
      ['INSERT INTO dsar_request', [{ id: DSAR_ID }]],
    ]);
    const scope = {
      scopeType: 'platform',
      scopeId: 'idp_user',
      label: 'Identity-provider record',
      state: 'pending',
      detail: 'Profile.',
    };
    privacy.catalogue.mockResolvedValue([scope]);
    privacy.byId.mockResolvedValue(privacyRequest({ state: 'open' }));

    const opened = await service.openDsar(
      { subjectRef: 'rita@example.test', kind: 'export' },
      ACTOR,
    );

    const hashed = paramsFor(db.calls, 'INSERT INTO subject_ref')[0];
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(paramsFor(db.calls, 'INSERT INTO dsar_request')).toEqual([
      hashed,
      'export',
      ACTOR,
      JSON.stringify([scope]),
    ]);
    expect(audit.append).toHaveBeenCalledWith({
      action: 'privacy.request.opened',
      actorType: 'user',
      actorId: ACTOR,
      targetType: 'dsar_request',
      targetId: DSAR_ID,
      outcome: 'success',
      detail: { kind: 'export', scopes: 1 },
    });
    expect(opened).toMatchObject({ id: DSAR_ID, state: 'open' });
  });

  it('reports an uncreated request as an internal failure', async () => {
    const { service } = setup([
      ['INSERT INTO subject_ref', []],
      ['INSERT INTO dsar_request', []],
    ]);
    await expect(
      service.openDsar({ subjectRef: 'rita@example.test', kind: 'delete' }, ACTOR),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', detail: 'The request was not created.' });
  });
});

describe('advanceDsar', () => {
  it.each(['complete', 'failed'] as const)('refuses to advance a %s request', async (state) => {
    const { db, privacy, service } = setup();
    privacy.byId.mockResolvedValue(privacyRequest({ state }));

    await expect(service.advanceDsar(DSAR_ID, ACTOR)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: `Cannot advance a record in state "${state}".`,
      remediation: 'Refresh the record; the action may have been taken already.',
    });
    expect(db.calls).toEqual([]);
  });

  it('completes exactly one scope and records which one', async () => {
    const { db, audit, privacy, service } = setup([['SET state = $2', { rows: [], rowCount: 1 }]]);
    privacy.byId
      .mockResolvedValueOnce(
        privacyRequest({
          scopes: [
            {
              scopeType: 'platform',
              scopeId: 'idp_user',
              label: 'Identity-provider record',
              state: 'pending',
              detail: 'Profile.',
            },
            {
              scopeType: 'product',
              scopeId: 'mail',
              label: 'mail',
              state: 'pending',
              detail: 'Dump.',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(privacyRequest());

    const advanced = await service.advanceDsar(DSAR_ID, ACTOR);

    const params = paramsFor(db.calls, 'SET state = $2');
    expect(params[0]).toBe(DSAR_ID);
    expect(params[1]).toBe('in_progress');
    expect(JSON.parse(String(params[2]))).toEqual({
      steps: ['queued', 'Identity-provider record · platform idp_user complete'],
    });
    expect(JSON.parse(String(params[3]))).toEqual([
      { scopeId: 'idp_user', state: 'complete', detail: 'Profile.' },
      { scopeId: 'mail', state: 'pending', detail: 'Dump.' },
    ]);
    expect(audit.append).toHaveBeenCalledWith({
      action: 'privacy.request.advanced',
      actorType: 'user',
      actorId: ACTOR,
      targetType: 'dsar_request',
      targetId: DSAR_ID,
      outcome: 'success',
      detail: { scopeId: 'idp_user', scopeType: 'platform', done: false },
    });
    expect(advanced).toMatchObject({ id: DSAR_ID });
  });

  it('closes the request when the last scope completes, naming the outcome', async () => {
    const { db, audit, privacy, service } = setup([['SET state = $2', { rows: [], rowCount: 1 }]]);
    privacy.byId
      .mockResolvedValueOnce(privacyRequest({ scopes: ONE_PENDING_SCOPE }))
      .mockResolvedValueOnce(privacyRequest({ state: 'complete' }));

    await service.advanceDsar(DSAR_ID, ACTOR);

    const params = paramsFor(db.calls, 'SET state = $2');
    expect(params[1]).toBe('completed');
    expect(JSON.parse(String(params[2]))).toEqual({
      steps: [
        'queued',
        'Identity · platform idp_user complete',
        'Every scope complete; outcome recorded',
      ],
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'privacy.export.completed',
        detail: { scopeId: 'idp_user', scopeType: 'platform', done: true },
      }),
    );
  });

  it('closes a request that has no scope left outstanding', async () => {
    const { db, privacy, service } = setup([['SET state = $2', { rows: [], rowCount: 1 }]]);
    privacy.byId
      .mockResolvedValueOnce(
        privacyRequest({
          scopes: [
            {
              scopeType: 'product',
              scopeId: 'mail',
              label: 'mail',
              state: 'complete',
              detail: 'Dump.',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(privacyRequest({ state: 'complete' }));

    await service.advanceDsar(DSAR_ID, ACTOR);

    const params = paramsFor(db.calls, 'SET state = $2');
    expect(JSON.parse(String(params[2]))).toEqual({
      steps: [
        'queued',
        'No scope was outstanding; the request was closed',
        'Every scope complete; outcome recorded',
      ],
    });
  });

  it('does not call a request with no scopes complete', async () => {
    const { db, privacy, service } = setup([['SET state = $2', { rows: [], rowCount: 1 }]]);
    privacy.byId
      .mockResolvedValueOnce(privacyRequest({ scopes: [] }))
      .mockResolvedValueOnce(privacyRequest({ scopes: [] }));

    await service.advanceDsar(DSAR_ID, ACTOR);

    const params = paramsFor(db.calls, 'SET state = $2');
    expect(params[1]).toBe('in_progress');
    expect(JSON.parse(String(params[3]))).toEqual([]);
  });

  it('erases the subject mapping on the last step of an erasure', async () => {
    const { db, audit, privacy, service } = setup([
      ['SELECT subject_ref FROM dsar_request', [{ subject_ref: 'abc123' }]],
      ["SET state = 'completed'", { rows: [], rowCount: 1 }],
      ['DELETE FROM subject_ref', { rows: [], rowCount: 1 }],
    ]);
    privacy.byId
      .mockResolvedValueOnce(privacyRequest({ kind: 'delete', scopes: ONE_PENDING_SCOPE }))
      .mockResolvedValueOnce(
        privacyRequest({ kind: 'delete', state: 'complete', subjectRef: 'erased' }),
      );

    const erased = await service.advanceDsar(DSAR_ID, ACTOR);

    expect(paramsFor(db.calls, 'DELETE FROM subject_ref')).toEqual(['abc123']);
    const params = paramsFor(db.calls, "SET state = 'completed'");
    expect(params[0]).toBe(DSAR_ID);
    expect(params).toHaveLength(3);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'privacy.erasure.completed',
        detail: { scopeId: 'idp_user', scopeType: 'platform', done: true, subjectRef: 'abc123' },
      }),
      db.client,
    );
    expect(erased).toMatchObject({ subjectRef: 'erased' });
  });

  it.each([
    ['the mapping was already erased', [{ subject_ref: null }]],
    ['the request row cannot be read back', []],
  ] as ReadonlyArray<readonly [string, Row[]]>)(
    'completes an erasure without a delete when %s',
    async (_label, mapping) => {
      const { db, audit, privacy, service } = setup([
        ['SELECT subject_ref FROM dsar_request', mapping],
        ["SET state = 'completed'", { rows: [], rowCount: 1 }],
      ]);
      privacy.byId
        .mockResolvedValueOnce(privacyRequest({ kind: 'delete', scopes: ONE_PENDING_SCOPE }))
        .mockResolvedValueOnce(privacyRequest({ kind: 'delete', state: 'complete' }));

      await service.advanceDsar(DSAR_ID, ACTOR);

      expect(issued(db.calls, 'DELETE FROM subject_ref')).toBe(false);
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'privacy.erasure.completed',
          detail: expect.objectContaining({ subjectRef: null }),
        }),
        db.client,
      );
    },
  );
});
