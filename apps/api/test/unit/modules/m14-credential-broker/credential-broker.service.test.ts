import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Route } from '../../../support/fakes';
import { BrokeredCredentialService } from '../../../../src/modules/m14-credential-broker/credential-broker.service';

/** The digest the broker stores: a scope's `token_hash`, recomputed from a token. */
const digestOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * The broker mints a credential that a workflow node can use for one operation. Three rules are
 * asserted here because none of them is expressible in the table: the scope is bounded by the
 * declared granularity (C-11 refuses writes on `account`, everything on `none`), the TTL is clamped,
 * and an idempotent retry returns the row that already exists instead of minting a second secret.
 */
const h = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));

type Setup = {
  db: ReturnType<typeof fakeDb>;
  audit: { lockChain: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> };
  secrets: { put: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> };
  service: BrokeredCredentialService;
};

function setup(
  options: { granularity?: string; routes?: Parameters<typeof fakeDb>[0] } = {},
): Setup {
  const db = fakeDb([
    ['seamnex_effective_granularity', [{ granularity: options.granularity ?? 'scoped' }]],
    ...(options.routes ?? []),
    // Activation asks whether this version already minted a scope before it mints another one. The
    // default is "no", and it is last so a test's own row for the same statement wins.
    ['SELECT id, secret_ref, token_hash, expires_at, mode, operations', []],
  ]);
  h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
    fn(db.client),
  );
  const audit = {
    lockChain: vi.fn(async () => undefined),
    append: vi.fn(async () => undefined),
  };
  const secrets = {
    put: vi.fn(async (_scope: string, _ownerId: string, _name: string, _value: string) => ({
      id: 'secret-row-1',
    })),
    open: vi.fn(async () => 'seamnex_reused_token'),
  };
  const service = new BrokeredCredentialService(db.pool, audit as never, secrets as never);
  return { db, audit, secrets, service };
}

const INPUT = {
  instanceId: 'inst-1',
  workflowId: 'wf-1',
  operations: ['orders.read'],
  mode: 'read' as const,
  ttlSeconds: 900,
};

beforeEach(() => {
  h.withTransaction.mockReset();
});

describe('mint: granularity gate', () => {
  it('refuses every workflow when the product exposes no API credential', async () => {
    const { service, secrets } = setup({ granularity: 'none' });

    await expect(service.mint(INPUT)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: expect.stringContaining('no API credential'),
    });
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it('refuses a write on an account-wide credential and points at the read-only alternative', async () => {
    const { service } = setup({ granularity: 'account' });

    await expect(service.mint({ ...INPUT, mode: 'write' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      remediation: expect.stringContaining('read-only operation'),
      detail: expect.stringContaining('account-wide'),
    });
  });

  it('allows a read on an account-wide credential', async () => {
    const { service } = setup({
      granularity: 'account',
      routes: [
        ['FROM workflow WHERE id', [{ current_version_id: 'v1' }]],
        ['INSERT INTO credential_scope', [{ id: 'scope-1' }]],
        ['SELECT secret_ref, token_hash, expires_at', []],
      ],
    });

    await expect(service.mint(INPUT)).resolves.toMatchObject({ scopeId: 'scope-1' });
  });

  it('treats an unknown granularity as none', async () => {
    const { service } = setup({ granularity: 'nonsense' });
    await expect(service.mint(INPUT)).rejects.toMatchObject({ status: 422 });
  });
});

describe('verifyToken', () => {
  const SCOPE = {
    id: 'scope-1',
    instance_id: 'inst-1',
    workflow_id: 'wf-1',
    version_id: 'v1',
    operations: ['orders.read'],
    mode: 'write',
    expires_at: new Date('2030-01-01T00:00:00Z'),
  };

  it('resolves a token to the scope behind its digest', async () => {
    const { db, service } = setup({ routes: [['FROM credential_scope s', [SCOPE]]] });

    const verified = await service.verifyToken('seamnex_abc');

    expect(verified).toMatchObject({
      scopeId: 'scope-1',
      instanceId: 'inst-1',
      workflowId: 'wf-1',
      versionId: 'v1',
      mode: 'write',
      operations: ['orders.read'],
    });
    const params = db.calls.find((call) => call.sql.includes('FROM credential_scope s'))?.params;
    // The lookup is by digest: the token itself never reaches a query, a log line or the table.
    expect(String(params?.[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(params?.[0])).not.toContain('seamnex_abc');
  });

  it('answers null for a token the table no longer honours', async () => {
    const { service } = setup({ routes: [['FROM credential_scope s', []]] });

    await expect(service.verifyToken('seamnex_gone')).resolves.toBeNull();
  });

  it('does not query at all for a value that is not a broker token', async () => {
    const { db, service } = setup();

    await expect(service.verifyToken('not-a-token')).resolves.toBeNull();
    expect(db.calls.some((call) => call.sql.includes('token_hash'))).toBe(false);
  });
});

describe('mint: scope creation', () => {
  /**
   * The statements a successful mint issues. The read-back answers with the digest the insert just
   * wrote, which is what a healthy row holds — answering a different one would take the repoint path
   * and issue statements this route set does not cover.
   */
  function routes(overrides: readonly Route[] = []): Route[] {
    let digest = '';
    return [
      ['FROM workflow WHERE id', [{ current_version_id: 'v1' }]],
      [
        'INSERT INTO credential_scope',
        (_sql: string, params: readonly unknown[]) => {
          digest = String(params[6]);
          return [{ id: 'scope-1' }];
        },
      ],
      [
        'SELECT secret_ref, token_hash, expires_at',
        () => [
          {
            secret_ref: 'secret-row-1',
            token_hash: digest,
            expires_at: new Date('2030-01-01T00:00:00Z'),
          },
        ],
      ],
      ...overrides,
    ] as Route[];
  }

  it('stores the secret in M15, records the scope, audits it and returns the expiry', async () => {
    const { db, audit, secrets, service } = setup({ routes: routes() });

    const result = await service.mint({ ...INPUT, idempotencyKey: 'key-1' });

    expect(result).toEqual({
      scopeId: 'scope-1',
      secretRef: 'secret-row-1',
      // The plaintext exists once, for the n8n credential activation writes; the table keeps a digest.
      token: expect.stringMatching(/^seamnex_[0-9a-f]{48}$/),
      expiresAt: '2030-01-01T00:00:00.000Z',
      mode: 'read',
      operations: ['orders.read'],
    });
    expect(secrets.put).toHaveBeenCalledWith(
      'workflow',
      'wf-1',
      expect.stringMatching(/^scope_[0-9a-f]{32}$/),
      expect.stringMatching(/^seamnex_[0-9a-f]{48}$/),
    );
    expect(audit.lockChain).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'credential.scope.minted',
        targetId: 'scope-1',
        detail: expect.objectContaining({ ttl: 900, mode: 'read' }),
      }),
      expect.anything(),
    );

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO credential_scope'));
    expect(insert?.params).toEqual([
      'inst-1',
      'wf-1',
      'v1',
      ['orders.read'],
      'read',
      'secret-row-1',
      // SHA-256 of the token: a copy of the table yields nothing the broker would accept.
      expect.stringMatching(/^[0-9a-f]{64}$/),
      '900',
      'key-1',
    ]);
  });

  it('clamps a too-short TTL up to one minute and a too-long one down to 90 days', async () => {
    const short = setup({ routes: routes() });
    await short.service.mint({ ...INPUT, ttlSeconds: 5 });
    expect(
      short.db.calls.find((call) => call.sql.includes('INSERT INTO credential_scope'))?.params[7],
    ).toBe('60');

    const long = setup({ routes: routes() });
    await long.service.mint({ ...INPUT, ttlSeconds: 10 * 365 * 24 * 3_600 });
    expect(
      long.db.calls.find((call) => call.sql.includes('INSERT INTO credential_scope'))?.params[7],
    ).toBe(String(90 * 24 * 60 * 60));
  });

  it('uses a default secret key when no idempotency key is supplied', async () => {
    const { db, secrets, service } = setup({ routes: routes() });

    await service.mint(INPUT);

    expect(secrets.put).toHaveBeenCalledWith(
      'workflow',
      'wf-1',
      'scope_default',
      expect.any(String),
    );
    expect(
      db.calls.find((call) => call.sql.includes('INSERT INTO credential_scope'))?.params[8],
    ).toBeNull();
  });

  it('derives the same secret name from the same idempotency key on a retried activation', async () => {
    const first = setup({ routes: routes() });
    await first.service.mint({ ...INPUT, idempotencyKey: 'k'.repeat(80) });
    const second = setup({ routes: routes() });
    await second.service.mint({ ...INPUT, idempotencyKey: 'k'.repeat(80) });

    const nameOf = (s: Setup) => s.secrets.put.mock.calls[0]?.[2];
    expect(nameOf(first)).toBe(nameOf(second));
    expect(nameOf(first)).toMatch(/^scope_[0-9a-f]{32}$/);
  });

  /**
   * Activation keys every product by `<workflow id>:<entry key>:<mode>`, and a workflow id is a
   * 36-character UUID — so a name built from the first 32 characters was the workflow alone. Two
   * products of one workflow then shared one secret row, `put` answered with a new version of it, and
   * each mint overwrote the token the previous product had been given (found on a live scope whose
   * digest no longer matched its own secret).
   */
  it('files two products of one workflow under different secret names', async () => {
    const workflowId = '3e70e550-264a-4f36-8732-2ac05f20329f';
    const write = setup({ routes: routes() });
    await write.service.mint({ ...INPUT, idempotencyKey: `${workflowId}:D01-01:write` });
    const read = setup({ routes: routes() });
    await read.service.mint({ ...INPUT, idempotencyKey: `${workflowId}:D07-01:read` });

    const nameOf = (s: Setup) => s.secrets.put.mock.calls[0]?.[2];
    expect(nameOf(write)).not.toBe(nameOf(read));
  });

  it('records a null version when the workflow has no current version', async () => {
    const { db, service } = setup({
      routes: [
        ['FROM workflow WHERE id', []],
        ['INSERT INTO credential_scope', [{ id: 'scope-1' }]],
        ['SELECT secret_ref, token_hash, expires_at', []],
      ],
    });

    const result = await service.mint(INPUT);

    expect(
      db.calls.find((call) => call.sql.includes('INSERT INTO credential_scope'))?.params[2],
    ).toBeNull();
    // No row back from the read: the values from the insert path are used instead.
    expect(result.secretRef).toBe('secret-row-1');
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('reuses the version scope instead of minting a second live token', async () => {
    const { db, audit, secrets, service } = setup({
      routes: [
        [
          'SELECT id, secret_ref, token_hash, expires_at, mode, operations',
          [
            {
              id: 'scope-existing',
              secret_ref: 'secret-row-1',
              // The digest of the value the store still holds: this is what makes the reuse safe.
              token_hash: digestOf('seamnex_reused_token'),
              expires_at: new Date('2031-01-01T00:00:00Z'),
              mode: 'read',
              operations: ['orders.read'],
            },
          ],
        ],
      ],
    });

    const result = await service.mint({ ...INPUT, idempotencyKey: 'retry' });

    expect(result).toMatchObject({
      scopeId: 'scope-existing',
      secretRef: 'secret-row-1',
      // The token n8n already carries is the one that stays valid: it is opened, never regenerated.
      token: 'seamnex_reused_token',
      mode: 'read',
    });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(secrets.open).toHaveBeenCalledWith('secret-row-1', expect.any(String), {
      scope: 'workflow',
      ownerId: 'wf-1',
    });
    // A retry is not a new mint, so it writes no row and is not audited a second time.
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO credential_scope'))).toBe(false);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('fails when neither the insert nor the idempotency lookup finds a row', async () => {
    const { service } = setup({
      routes: [
        ['FROM workflow WHERE id', [{ current_version_id: 'v1' }]],
        ['INSERT INTO credential_scope', []],
        ['SELECT id FROM credential_scope', []],
      ],
    });

    await expect(service.mint(INPUT)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  /**
   * The live defect: two scopes of one workflow shared a secret row, so one of them held a digest
   * minted from a value its own `secret_ref` no longer contained. Reusing that value would hand the
   * read-only product the write token, which the broker resolves to the other scope.
   */
  it('mints a new token when the existing row no longer owns the value behind its secret', async () => {
    const { audit, secrets, service } = setup({
      routes: [
        [
          'SELECT id, secret_ref, token_hash, expires_at, mode, operations',
          [
            {
              id: 'scope-existing',
              secret_ref: 'shared-secret',
              token_hash: digestOf('some-other-products-token'),
              expires_at: new Date('2031-01-01T00:00:00Z'),
              mode: 'read',
              operations: ['orders.read'],
            },
          ],
        ],
        ...routes(),
      ],
    });

    const result = await service.mint({ ...INPUT, idempotencyKey: 'retry' });

    expect(secrets.put).toHaveBeenCalledOnce();
    expect(result.token).toMatch(/^seamnex_[0-9a-f]{48}$/);
    expect(result.token).not.toBe('seamnex_reused_token');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'credential.scope.minted' }),
      expect.anything(),
    );
  });

  it('adopts the token a concurrent activation published', async () => {
    const { db, secrets, service } = setup({
      routes: [
        ['FROM workflow WHERE id', [{ current_version_id: 'v1' }]],
        // The insert lost the race: another activation already recorded the scope for this key.
        ['INSERT INTO credential_scope', []],
        ['SELECT id FROM credential_scope', [{ id: 'scope-winner' }]],
        [
          'SELECT secret_ref, token_hash, expires_at',
          [
            {
              secret_ref: 'winner-secret',
              token_hash: digestOf('seamnex_reused_token'),
              expires_at: new Date('2030-01-01T00:00:00Z'),
            },
          ],
        ],
      ],
    });

    const result = await service.mint({ ...INPUT, idempotencyKey: 'race' });

    expect(result).toMatchObject({
      scopeId: 'scope-winner',
      secretRef: 'winner-secret',
      token: 'seamnex_reused_token',
    });
    expect(secrets.put).toHaveBeenCalledOnce();
    // The winner's association is intact, so nothing is rewritten.
    expect(db.calls.some((call) => call.sql.includes('UPDATE credential_scope'))).toBe(false);
  });

  it('repoints a row whose secret no longer holds the value its digest was minted from', async () => {
    const { db, audit, service } = setup({
      routes: [
        ['FROM workflow WHERE id', [{ current_version_id: 'v1' }]],
        ['INSERT INTO credential_scope', []],
        ['SELECT id FROM credential_scope', [{ id: 'scope-existing' }]],
        [
          'SELECT secret_ref, token_hash, expires_at',
          [
            {
              secret_ref: 'shared-secret',
              token_hash: digestOf('some-other-products-token'),
              expires_at: new Date('2030-01-01T00:00:00Z'),
            },
          ],
        ],
        ['UPDATE credential_scope SET secret_ref', { rows: [], rowCount: 1 }],
      ],
    });

    const result = await service.mint({ ...INPUT, idempotencyKey: 'retry' });

    // The token n8n is about to receive is the one the row now honours.
    expect(result.secretRef).toBe('secret-row-1');
    expect(result.token).toMatch(/^seamnex_[0-9a-f]{48}$/);
    const update = db.calls.find((call) =>
      call.sql.includes('UPDATE credential_scope SET secret_ref'),
    );
    expect(update?.params).toEqual([
      'scope-existing',
      'secret-row-1',
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'credential.scope.rotated',
        targetId: 'scope-existing',
        detail: expect.objectContaining({ storedTokenMismatchedDigest: true }),
      }),
      expect.anything(),
    );
  });
});

describe('revoke', () => {
  it('marks a live scope revoked and audits it', async () => {
    const { db, audit, service } = setup({
      routes: [['UPDATE credential_scope SET revoked_at', { rows: [], rowCount: 1 }]],
    });

    await service.revoke('scope-1', 'admin-1');

    expect(db.calls.some((call) => call.sql.includes('UPDATE credential_scope'))).toBe(true);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'credential.scope.revoked',
        actorId: 'admin-1',
        targetId: 'scope-1',
      }),
      expect.anything(),
    );
  });

  it('defaults the actor to the platform', async () => {
    const { audit, service } = setup({
      routes: [['UPDATE credential_scope SET revoked_at', { rows: [], rowCount: 1 }]],
    });

    await service.revoke('scope-1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'platform' }),
      expect.anything(),
    );
  });

  it('refuses to revoke a scope that is not live', async () => {
    const { service } = setup({
      routes: [['UPDATE credential_scope SET revoked_at', { rows: [], rowCount: 0 }]],
    });

    await expect(service.revoke('scope-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('list', () => {
  it('projects every scope, with or without a revocation time', async () => {
    const { service } = setup({
      routes: [
        [
          'FROM credential_scope WHERE instance_id',
          [
            {
              id: 'scope-1',
              instance_id: 'inst-1',
              operations: ['a', 'b'],
              mode: 'write',
              issued_at: new Date('2026-01-01T00:00:00Z'),
              expires_at: new Date('2026-02-01T00:00:00Z'),
              revoked_at: null,
            },
            {
              id: 'scope-2',
              instance_id: 'inst-1',
              operations: ['c'],
              mode: 'read',
              issued_at: new Date('2026-01-01T00:00:00Z'),
              expires_at: new Date('2026-02-01T00:00:00Z'),
              revoked_at: new Date('2026-01-15T00:00:00Z'),
            },
          ],
        ],
      ],
    });

    const scopes = await service.list('inst-1');

    expect(scopes).toEqual([
      {
        id: 'scope-1',
        instanceId: 'inst-1',
        product: 'inst-1',
        operations: ['a', 'b'],
        mode: 'write',
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-02-01T00:00:00.000Z',
        revokedAt: null,
        brokered: true,
      },
      expect.objectContaining({ id: 'scope-2', revokedAt: '2026-01-15T00:00:00.000Z' }),
    ]);
  });
});
