import { describe, expect, it, vi } from 'vitest';
import { PostgresProductAccountService } from '../../../../src/modules/m24-sign-in-relay/product-account.service';
import { relaySessionKey } from '../../../../src/modules/m24-sign-in-relay/relay-cache';
import { fakeDb, fakeRelayRedis, type Route } from '../../../support/fakes';

/**
 * Provisioning is the half of ADR-BE-22 that can create a standing access in a product the platform
 * does not own. The properties worth pinning:
 *
 *   * a missing admin token is recorded, never invented, and does not spin;
 *   * a create that fails because the user already exists is reconciled and re-passworded, not
 *     duplicated — a second account for one person breaks the per-user rule;
 *   * offboarding removes the credential and the mapping even when the product cannot be reached,
 *     because holding a password for a disabled person is the failure, not a side effect of it.
 */

const CANDIDATE = {
  instance_id: 'instance-1',
  subject_idp_id: 'subject-1',
  entry_key: 'D09-01',
  slug: 'openproject',
  payload: { httpPort: 80 },
  host: 'openproject.localhost',
  username: 'jane.doe',
  email: 'jane@example.test',
  account_id: null,
  account_login: null,
  secret_ref: null,
  state: null,
  attempt: 0,
};

/** The same subject on a second pass: the platform already recorded creating this account. */
const RETRY_CANDIDATE = {
  ...CANDIDATE,
  account_id: 'account-1',
  account_login: 'jane.doe',
  secret_ref: 'secret-1',
  state: 'pending',
  attempt: 1,
};

function build(options: {
  candidates?: Record<string, unknown>[];
  rotations?: Record<string, unknown>[];
  adminToken?: string | null;
  enabled?: boolean;
  /** The allow-list, so a test can describe a relay that is on and configured for nothing. */
  entryKeys?: string;
}) {
  const db = fakeDb([
    ['FROM entitlement e', options.candidates ?? [CANDIDATE]],
    ['SELECT login FROM product_account WHERE instance_id', []],
    ['FROM product_account pa', options.rotations ?? []],
    ['INSERT INTO product_account', []],
    ['UPDATE product_account', []],
    ['DELETE FROM product_account', []],
    [
      'LEFT JOIN instance_route r ON r.instance_id = i.id',
      [{ slug: 'openproject', payload: { httpPort: 80 }, host: 'openproject.localhost' }],
    ],
    // The retry window (migration 0028): claimed, read as "not deferred", cleared. Each test builds a
    // fresh service, so "claimed" is the state every one of them starts from.
    ['INSERT INTO relay_retry_window', [{ '?column?': 1 }]],
    ['SELECT 1 FROM relay_retry_window', []],
    ['DELETE FROM relay_retry_window', []],
  ] as Route[]);

  const secrets = {
    put: vi.fn(async () => ({
      id: 'secret-1',
      scope: 'product_account',
      ownerId: 'x',
      name: 'password',
      version: 1,
      masked: '••••',
    })),
    find: vi.fn(async () =>
      options.adminToken === null
        ? null
        : {
            id: 'admin-secret',
            scope: 'instance',
            ownerId: 'instance-1',
            name: 'product_api_token',
            version: 1,
            masked: '••••',
          },
    ),
    open: vi.fn(async () => options.adminToken ?? 'admin-token'),
    rotate: vi.fn(async () => ({ id: 'secret-1', version: 2 })),
    remove: vi.fn(async () => undefined),
  };
  const audit = {
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
    lockChain: vi.fn(async () => undefined),
  };
  // The cache drops by `SCAN` with a glob pattern evaluated for real: a double that answers "no
  // keys" for every pattern made an offboarding that revoked nothing look correct.
  const cache = fakeRelayRedis();
  const redis = {
    store: cache.store,
    scan: vi.fn(cache.scan),
    del: vi.fn(cache.del),
  };
  // Loosely typed doubles: each test overrides one call with a refusal, and the service only reads
  // `ok`/`value`/`detail` from the result.
  type Double = ReturnType<typeof vi.fn>;
  const product: {
    credentialKind: 'bearer' | 'password';
    createUser: Double;
    findUserByLogin: Double;
    resetPassword: Double;
    disableUser: Double;
  } = {
    // OpenProject's API takes a bearer token; the service reads the matching instance secret.
    credentialKind: 'bearer',
    createUser: vi.fn(async () => ({ ok: true, value: { id: 'user-9', login: 'jane.doe' } })),
    findUserByLogin: vi.fn(async () => ({ ok: true, value: null })),
    resetPassword: vi.fn(async () => ({ ok: true, value: null })),
    disableUser: vi.fn(async () => ({ ok: true, value: null })),
  };
  // The registry is the only thing the service knows: which adapter answers for an entry key.
  const adapters = { for: vi.fn(() => product) };
  const docker = { connectNetwork: vi.fn(async () => undefined) };
  const config = {
    SEAMNEX_RELAY_ENABLED: options.enabled ?? true,
    SEAMNEX_RELAY_ENTRY_KEYS: options.entryKeys ?? 'D09-01',
    SEAMNEX_RELAY_ADMIN_SECRET_NAME: 'product_api_token',
    SEAMNEX_RELAY_ROTATION_DAYS: 30,
    SEAMNEX_RELAY_HTTP_TIMEOUT_MS: 1_000,
    SEAMNEX_RELAY_CONTAINER: '',
    SEAMNEX_PRODUCT_URL_SCHEME: 'http',
    SEAMNEX_PRODUCT_URL_PORT: '8020',
    SEAMNEX_INGRESS_DOMAIN: 'localhost',
    SEAMNEX_ROLE: 'scheduler',
  };

  // M03's contract, not its table: the service asks for resolved instance variables by name.
  const renderer = {
    instanceEnv: vi.fn(async () => [
      { name: 'ORANGEHRM_ADMIN_USERNAME', secret: false, value: 'Admin' },
    ]),
  };
  // The bootstrap writer. These adapters declare no `adminBootstrap` recipe, so the sweep never
  // reaches it — a fake here is what keeps an accidental call visible instead of silently minting.
  const adminCredentials = {
    status: vi.fn(async () => ({
      kind: 'bearer',
      required: true,
      configured: false,
      name: 'product_api_token',
      version: null,
    })),
    store: vi.fn(async () => ({
      kind: 'bearer',
      required: true,
      configured: true,
      name: 'product_api_token',
      version: 1,
    })),
  };
  const service = new PostgresProductAccountService(
    db.pool,
    redis as never,
    config as never,
    secrets as never,
    renderer as never,
    audit as never,
    adapters as never,
    docker as never,
    adminCredentials as never,
  );
  return { service, db, secrets, audit, product, adapters, redis };
}

describe('PostgresProductAccountService.sweep', () => {
  it('does nothing when the relay is disabled', async () => {
    const { service, db } = build({ enabled: false });

    await service.sweep();

    // The disabled build returns before the first query; a deployment that never opted in makes no
    // product call and creates no mapping.
    expect(db.calls.some((call) => call.sql.includes('FROM entitlement e'))).toBe(false);
  });

  it('creates the account, stores the credential under its own scope and marks it active', async () => {
    const { service, secrets, product, audit } = build({});

    await service.sweep();

    expect(product.createUser).toHaveBeenCalledOnce();
    // OpenProject refuses an account with no address (`422 Email can't be blank` on 17.9.6), so the
    // platform derives one from the login it just minted and the product's own host — never the
    // directory address (NFR-4.13).
    const created = product.createUser.mock.calls[0]?.[1] as { login: string; email: string };
    expect(created.email).toBe(`${created.login}@openproject.localhost`);
    expect(secrets.put).toHaveBeenCalledWith(
      'product_account',
      expect.any(String),
      'password',
      expect.any(String),
      expect.anything(),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.account.provisioned' }),
    );
  });

  it('records a missing admin token instead of inventing one', async () => {
    const { service, product, audit } = build({ adminToken: null });

    await service.sweep();

    expect(product.createUser).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.account.provision_failed',
        detail: expect.objectContaining({ reason: 'admin_credential_missing' }),
      }),
    );
  });

  it('reconciles a login a previous pass created, instead of creating a second account', async () => {
    const { service, product } = build({ candidates: [RETRY_CANDIDATE] });
    product.createUser.mockResolvedValueOnce({
      ok: false,
      status: 422,
      detail: 'answered 422: taken',
    });
    product.findUserByLogin.mockResolvedValueOnce({
      ok: true,
      value: { id: 'user-9', admin: false },
    });

    await service.sweep();

    expect(product.findUserByLogin).toHaveBeenCalledWith(expect.anything(), 'jane.doe');
    expect(product.resetPassword).toHaveBeenCalledWith(
      expect.anything(),
      'user-9',
      expect.any(String),
    );
  });

  /*
   * The account-takeover path. A first provision whose login already exists in the product means
   * the login belongs to someone else — a human account an administrator made, or the product's
   * seeded `admin`. Resetting that password would hand a platform subject an identity the platform
   * does not own, and would destroy the break-glass credential ADR-BE-22 keeps outside the relay.
   *
   * This case is deliberately a *non-admin* account: ownership alone has to refuse, without the
   * administrator guard below doing the work.
   */
  it('refuses to adopt an account the platform did not create', async () => {
    const { service, product, audit } = build({});
    product.createUser.mockResolvedValueOnce({
      ok: false,
      status: 422,
      detail: 'answered 422: taken',
    });
    product.findUserByLogin.mockResolvedValueOnce({
      ok: true,
      value: { id: 'someones-account', admin: false },
    });

    await service.sweep();

    expect(product.resetPassword).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.account.provision_failed',
        detail: expect.objectContaining({ reason: 'login_collision' }),
      }),
    );
  });

  it('never re-passwords a mapped account that has administrator rights', async () => {
    const { service, product } = build({ candidates: [RETRY_CANDIDATE] });
    product.createUser.mockResolvedValueOnce({
      ok: false,
      status: 422,
      detail: 'answered 422: taken',
    });
    product.findUserByLogin.mockResolvedValueOnce({
      ok: true,
      value: { id: 'user-1', admin: true },
    });

    await service.sweep();

    expect(product.resetPassword).not.toHaveBeenCalled();
  });

  it('generates a login that cannot collide with a reserved product account', async () => {
    const { service, product } = build({
      candidates: [{ ...CANDIDATE, username: 'admin' }],
    });

    await service.sweep();

    const created = product.createUser.mock.calls[0]?.[1] as { login: string } | undefined;
    expect(created?.login).not.toBe('admin');
    expect(created?.login.startsWith('admin-')).toBe(true);
  });

  it('records a product refusal as unavailable rather than retrying inside the pass', async () => {
    const { service, product, audit } = build({});
    product.createUser.mockResolvedValueOnce({ ok: false, status: 503, detail: 'answered 503' });
    product.findUserByLogin.mockResolvedValueOnce({
      ok: false,
      status: 503,
      detail: 'answered 503',
    });

    await service.sweep();

    expect(product.createUser).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.account.provision_failed',
        detail: expect.objectContaining({ reason: 'product_unavailable' }),
      }),
    );
  });
});

describe('PostgresProductAccountService.deprovision', () => {
  it('locks the product account, deletes the secret and the mapping, and drops the cache', async () => {
    const { service, db, secrets, product, redis } = build({});
    db.pool.query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM product_account WHERE subject_idp_id')) {
        return {
          rows: [
            {
              id: 'account-1',
              instance_id: 'instance-1',
              login: 'jane.doe',
              secret_ref: 'secret-1',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('LEFT JOIN instance_route r ON r.instance_id = i.id')) {
        return {
          rows: [{ slug: 'openproject', payload: { httpPort: 80 }, host: 'openproject.localhost' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }) as never;
    product.findUserByLogin.mockResolvedValueOnce({ ok: true, value: { id: 'user-9' } });
    redis.store.set(relaySessionKey('instance-1', 'subject-1'), '{"cookies":["a=1"]}');

    await service.deprovision('subject-1');

    expect(product.disableUser).toHaveBeenCalledWith(expect.anything(), 'user-9');
    // The credential is named as this mapping's own, so a drifted `secret_ref` cannot delete an
    // unrelated secret during offboarding.
    expect(secrets.remove).toHaveBeenCalledWith(
      'secret-1',
      expect.stringContaining('offboarding'),
      { scope: 'product_account', ownerId: 'account-1' },
    );
    expect(redis.scan).toHaveBeenCalled();
    // A departed subject's cached product session must not survive the deletion path.
    expect(redis.store.size).toBe(0);
  });

  it('still removes the platform-held credential when the product is unreachable', async () => {
    const { service, db, secrets, product } = build({});
    db.pool.query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM product_account WHERE subject_idp_id')) {
        return {
          rows: [
            {
              id: 'account-1',
              instance_id: 'instance-1',
              login: 'jane.doe',
              secret_ref: 'secret-1',
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }) as never;
    product.findUserByLogin.mockRejectedValueOnce(new Error('network down'));

    await service.deprovision('subject-1');

    expect(secrets.remove).toHaveBeenCalledOnce();
  });
});

describe('PostgresProductAccountService rotation', () => {
  it('rotates a due credential through the product before trusting the new value', async () => {
    const { service, product, secrets } = build({
      candidates: [],
      rotations: [
        {
          id: 'account-1',
          instance_id: 'instance-1',
          subject_idp_id: 'subject-1',
          login: 'jane.doe',
          secret_ref: 'secret-1',
          slug: 'openproject',
          payload: { httpPort: 80 },
          host: 'openproject.localhost',
        },
      ],
    });
    product.findUserByLogin.mockResolvedValueOnce({ ok: true, value: { id: 'user-9' } });

    await service.sweep();

    expect(product.resetPassword).toHaveBeenCalledWith(
      expect.anything(),
      'user-9',
      expect.any(String),
    );
    // Named scope and owner, as `open` is: rotation replaces the value it is given an id for.
    expect(secrets.rotate).toHaveBeenCalledWith('secret-1', expect.any(String), {
      scope: 'product_account',
      ownerId: 'account-1',
    });
  });

  /*
   * The ordering rule is "store, then tell the product". A store failure that is swallowed breaks
   * it in the worst direction: the product would be given a password the platform never kept, so
   * the account is unusable and the row says the rotation succeeded.
   */
  it('does not touch the product when the new credential cannot be stored', async () => {
    const { service, db, product, secrets } = build({
      candidates: [],
      rotations: [
        {
          id: 'account-1',
          instance_id: 'instance-1',
          subject_idp_id: 'subject-1',
          login: 'jane.doe',
          secret_ref: 'secret-1',
          slug: 'openproject',
          payload: { httpPort: 80 },
          host: 'openproject.localhost',
        },
      ],
    });
    product.findUserByLogin.mockResolvedValueOnce({
      ok: true,
      value: { id: 'user-9', admin: false },
    });
    secrets.rotate.mockRejectedValueOnce(new Error('root key unavailable'));

    await service.sweep();

    expect(product.resetPassword).not.toHaveBeenCalled();
    // The selection query also mentions `state = 'failed'`; the update is the one that writes it.
    const update = db.calls.find(
      (call) =>
        call.sql.includes('UPDATE product_account') && call.sql.includes("state = 'failed'"),
    );
    expect(String(update?.params?.[1])).toBe('secret_store_unavailable');
  });

  it('flushes the cached session after a successful rotation', async () => {
    const { service, product, redis } = build({
      candidates: [],
      rotations: [
        {
          id: 'account-1',
          instance_id: 'instance-1',
          subject_idp_id: 'subject-1',
          login: 'jane.doe',
          secret_ref: 'secret-1',
          slug: 'openproject',
          payload: { httpPort: 80 },
          host: 'openproject.localhost',
        },
      ],
    });
    product.findUserByLogin.mockResolvedValueOnce({
      ok: true,
      value: { id: 'user-9', admin: false },
    });

    await service.sweep();

    // A session minted with the old credential must not outlive the rotation.
    expect(redis.del).toHaveBeenCalledWith('relay:instance-1:subject-1');
  });

  /*
   * The recovery half of the relay's circuit breaker: stopping at three refused credentials is only
   * safe if something starts the account again. Re-passwording is that something, so the rotation
   * selection has to include the state the relay leaves behind.
   */
  it('selects mappings the relay stopped after repeated credential rejections', async () => {
    const { service, db } = build({ candidates: [], rotations: [] });

    await service.sweep();

    const selection = db.calls.find((call) => call.sql.includes('FROM product_account pa'));
    expect(selection?.sql).toContain("pa.last_error = 'credential_rejected'");
  });

  it('marks the account failed when the product refuses the new password', async () => {
    const { service, db, product } = build({
      candidates: [],
      rotations: [
        {
          id: 'account-1',
          instance_id: 'instance-1',
          subject_idp_id: 'subject-1',
          login: 'jane.doe',
          secret_ref: 'secret-1',
          slug: 'openproject',
          payload: { httpPort: 80 },
          host: 'openproject.localhost',
        },
      ],
    });
    product.findUserByLogin.mockResolvedValueOnce({ ok: true, value: { id: 'user-9' } });
    product.resetPassword.mockResolvedValueOnce({ ok: false, status: 422, detail: 'refused' });

    await service.sweep();

    const updates = db.calls.filter((call) => call.sql.includes('state = '));
    expect(updates.some((call) => String(call.params?.[1]).startsWith('rotation_failed'))).toBe(
      true,
    );
  });
});

/**
 * The deployment-triggered pass. Its reason to exist is latency, so the properties worth pinning
 * are the ones that keep it from being a second, different implementation: the same selection, the
 * same provisioning, and none of the rotation work a launch must not wait for.
 */
describe('PostgresProductAccountService.provisionInstance', () => {
  const INSTANCE_UUID = '11111111-1111-4111-8111-111111111111';

  it('runs the sweep selection for one instance and one subject', async () => {
    const { service, db, product, adapters } = build({});

    await service.provisionInstance(INSTANCE_UUID, 'subject-1');

    expect(adapters.for).toHaveBeenCalledWith('D09-01');
    expect(product.createUser).toHaveBeenCalledOnce();
    const selection = db.calls.find((call) => call.sql.includes('FROM entitlement e'));
    expect(selection?.params).toContain(INSTANCE_UUID);
    expect(selection?.params).toContain('subject-1');
  });

  it('does not rotate: a launch is not the moment for a password change', async () => {
    const { service, db } = build({ rotations: [] });

    await service.provisionInstance(INSTANCE_UUID);

    expect(db.calls.some((call) => call.sql.includes('FROM product_account pa'))).toBe(false);
  });

  it('scopes to the whole instance when no subject is named, which is the deploy case', async () => {
    const { service, db } = build({});

    await service.provisionInstance(INSTANCE_UUID);

    const selection = db.calls.find((call) => call.sql.includes('FROM entitlement e'));
    expect(selection?.params).toContain(INSTANCE_UUID);
    expect(selection?.params).toContain(null);
  });

  it('refuses an id that is not a uuid instead of raising 22P02', async () => {
    const { service, db } = build({});

    await service.provisionInstance('instance-1');

    expect(db.calls.some((call) => call.sql.includes('FROM entitlement e'))).toBe(false);
  });

  it('never provisions into a product that is not up', async () => {
    const { service, db } = build({});

    await service.provisionInstance(INSTANCE_UUID);

    // The readiness gate is what stops the first pass after an install from racing `compose up`
    // and paying the fifteen-minute retry for an install that was fine.
    const selection = db.calls.find((call) => call.sql.includes('FROM entitlement e'));
    expect(selection?.sql).toContain("i.state IN ('ready', 'degraded')");
  });

  /*
   * The report exists so an operator can tell three zeroes apart. "The relay is off", "it is on and
   * nothing is allow-listed" and "it is configured and nobody was eligible" need three different
   * actions, and a bare `0` collapsed them into one.
   */
  it('reports an enabled relay that is configured for nothing', async () => {
    const { service, db } = build({ entryKeys: '' });

    expect(await service.provisionInstance(INSTANCE_UUID)).toEqual({
      instanceId: INSTANCE_UUID,
      enabled: true,
      configured: false,
      considered: 0,
      provisioned: 0,
      failed: 0,
    });
    expect(db.calls.some((call) => call.sql.includes('FROM entitlement e'))).toBe(false);
  });

  it('reports a disabled relay without selecting anyone', async () => {
    const { service, db } = build({ enabled: false });

    expect(await service.provisionInstance(INSTANCE_UUID)).toMatchObject({ enabled: false });
    expect(db.calls.some((call) => call.sql.includes('FROM entitlement e'))).toBe(false);
  });

  it('counts what the pass did, rather than what it attempted', async () => {
    const { service } = build({});

    expect(await service.provisionInstance(INSTANCE_UUID)).toEqual({
      instanceId: INSTANCE_UUID,
      enabled: true,
      configured: true,
      considered: 1,
      provisioned: 1,
      failed: 0,
    });
  });

  it('attributes the pass to the actor it was given', async () => {
    const { service, audit } = build({});

    await service.provisionInstance(INSTANCE_UUID, 'subject-1', { type: 'user', id: 'user-1' });

    // The route names a person; the sweep and the deployment event leave this undefined and are
    // recorded as the service role, which is what "the platform did it" means.
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.account.provisioned',
        actorType: 'user',
        actorId: 'user-1',
      }),
    );
  });
});
