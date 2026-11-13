import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresProductAccountService } from '../../../../src/modules/m24-sign-in-relay/product-account.service';
import { fakeDb, fakeRelayRedis, type Route } from '../../../support/fakes';

/**
 * The bootstrap writer. Exactly one scenario below signs in; the default refuses, so a scenario
 * that reaches this accidentally records a refusal instead of opening a socket.
 */
const { mintAdminToken } = vi.hoisted(() => ({
  mintAdminToken: vi.fn(async () => ({
    ok: false as const,
    reason: 'product_unavailable',
    detail: 'the sign-in driver is not stubbed for this scenario',
  })),
}));
vi.mock('../../../../src/modules/m24-sign-in-relay/openproject-admin-token', () => ({
  mintAdminToken,
}));

/**
 * The failure half of ADR-BE-22's provisioning pass.
 *
 * The happy paths are covered by `product-account.service.test.ts`; what is pinned here is every
 * way the pass stops: a product with no adapter, an administrator credential that cannot be read,
 * a rotation whose new value cannot be stored, and the quiet period that keeps one permanent
 * misconfiguration from appending an audit row every five minutes.
 *
 * Nothing here creates a product account twice. `build()` returns the doubles, so each test can
 * fail exactly one call and assert what the pass did with that verdict.
 */

const CANDIDATE = {
  instance_id: 'instance-1',
  subject_idp_id: 'subject-1',
  entry_key: 'D09-01',
  slug: 'openproject',
  payload: { httpPort: 80 },
  host: 'openproject.localhost',
  username: 'jane.doe',
  email: null,
  account_id: null,
  account_login: null,
  secret_ref: null,
  state: null,
  attempt: 0,
};

/** The same subject on a later pass: the platform already recorded creating this account. */
const RETRY_CANDIDATE = {
  ...CANDIDATE,
  account_id: 'account-1',
  account_login: 'jane.doe',
  secret_ref: 'secret-1',
  state: 'pending',
  attempt: 1,
};

const ROTATION = {
  id: 'account-1',
  instance_id: 'instance-1',
  subject_idp_id: 'subject-1',
  login: 'jane.doe',
  secret_ref: 'secret-1',
  entry_key: 'D09-01',
  slug: 'openproject',
  payload: { httpPort: 80 },
  host: 'openproject.localhost',
};

type Options = {
  candidates?: Record<string, unknown>[];
  rotations?: Record<string, unknown>[];
  /** An override that answers a statement before the routing table does. */
  override?: (sql: string, params: readonly unknown[]) => unknown | undefined;
};

/** A `QueryResult`-shaped answer, for the statements the override intercepts. */
function rowsOf(rows: unknown[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

function build(options: Options = {}) {
  // When the retry window the platform last wrote reopens; `0` and the past are the same thing.
  let retryAfter = 0;

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
    /*
     * The retry window (migration 0028) is a row, not a `Map`. The double keeps the instant the
     * statement asked for and answers `now()` against it itself, which is what lets the six-hour
     * bootstrap test travel with fake timers instead of asserting a constant.
     */
    [
      'INSERT INTO relay_retry_window',
      (sql: string, params: readonly unknown[]) => {
        const now = Date.now();
        // The claim is the conditional upsert: it opens nothing while its window still stands.
        if (sql.includes('WHERE relay_retry_window.retry_after <= now()') && now < retryAfter) {
          return [];
        }
        retryAfter = now + Number(params[params.length - 1] ?? 0);
        return [{ '?column?': 1 }];
      },
    ],
    [
      'SELECT 1 FROM relay_retry_window',
      () => (Date.now() < retryAfter ? [{ '?column?': 1 }] : []),
    ],
    [
      'DELETE FROM relay_retry_window',
      () => {
        retryAfter = 0;
        return [];
      },
    ],
  ] as Route[]);

  if (options.override !== undefined) {
    const routed = db.pool.query as unknown as (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<unknown>;
    (db.pool as unknown as { query: unknown }).query = vi.fn(
      async (sql: string, params?: readonly unknown[]) => {
        const handled = options.override?.(sql, params ?? []);
        if (handled !== undefined) return handled;
        return routed(sql, params);
      },
    );
  }

  type Double = ReturnType<typeof vi.fn>;
  const product: {
    name: string;
    credentialKind: 'bearer' | 'password';
    passwordVariables?: { username: string; password: string };
    /** Set by the bootstrap tests: the entry's seed-administrator recipe. */
    adminBootstrap?: { login: string; passwordVariable: string } | undefined;
    createUser: Double;
    findUserByLogin: Double;
    resetPassword: Double;
    disableUser: Double;
  } = {
    name: 'openproject',
    credentialKind: 'bearer',
    createUser: vi.fn(async () => ({ ok: true, value: { id: 'user-9', login: 'jane.doe' } })),
    findUserByLogin: vi.fn(async () => ({ ok: true, value: null })),
    resetPassword: vi.fn(async () => ({ ok: true, value: null })),
    disableUser: vi.fn(async () => ({ ok: true, value: null })),
  };

  const secrets: Record<'put' | 'find' | 'open' | 'rotate' | 'remove', Double> = {
    put: vi.fn(async () => ({
      id: 'secret-1',
      scope: 'product_account',
      ownerId: 'x',
      name: 'password',
      version: 1,
      masked: '••••',
    })),
    find: vi.fn(async () => ({
      id: 'admin-secret',
      scope: 'instance',
      ownerId: 'instance-1',
      name: 'product_api_token',
      version: 1,
      masked: '••••',
    })),
    open: vi.fn(async () => 'admin-token'),
    rotate: vi.fn(async () => ({ id: 'secret-1', version: 2 })),
    remove: vi.fn(async () => undefined),
  };
  const audit = {
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
    lockChain: vi.fn(async () => undefined),
  };
  const cache = fakeRelayRedis();
  const redis = { store: cache.store, scan: vi.fn(cache.scan), del: vi.fn(cache.del) };
  const adapters: { for: Double } = { for: vi.fn(() => product) };
  const docker = { connectNetwork: vi.fn(async () => undefined) };
  const renderer: { instanceEnv: Double } = {
    instanceEnv: vi.fn(async () => [
      { name: 'ORANGEHRM_ADMIN_USERNAME', secret: false, value: 'Admin' },
    ]),
  };
  const config = {
    SEAMNEX_RELAY_ENABLED: true,
    SEAMNEX_RELAY_ENTRY_KEYS: 'D09-01',
    SEAMNEX_RELAY_ADMIN_SECRET_NAME: 'product_api_token',
    SEAMNEX_RELAY_ROTATION_DAYS: 30,
    SEAMNEX_RELAY_HTTP_TIMEOUT_MS: 1_000,
    SEAMNEX_RELAY_CONTAINER: '',
    SEAMNEX_PRODUCT_URL_SCHEME: 'http',
    SEAMNEX_PRODUCT_URL_PORT: '8020',
    SEAMNEX_INGRESS_DOMAIN: 'localhost',
    SEAMNEX_ROLE: 'scheduler',
  };

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
  return {
    service,
    db,
    secrets,
    audit,
    product,
    adapters,
    redis,
    renderer,
    config,
    adminCredentials,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-04T09:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a product the platform cannot provision into', () => {
  it('records the missing adapter without retrying and without inventing a mapping', async () => {
    const { service, adapters, audit, product } = build();
    adapters.for.mockReturnValue(null);

    await service.sweep();

    expect(product.createUser).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.account.provision_failed',
        detail: expect.objectContaining({
          reason: 'adapter_missing',
          detail: 'no provisioning adapter is registered for D09-01',
        }),
      }),
    );
  });

  it('keeps an unexpected provisioning error inside the pass', async () => {
    const { service, adapters, audit } = build();
    adapters.for.mockImplementation(() => {
      throw new Error('registry exploded');
    });

    await expect(service.sweep()).resolves.toBeUndefined();
    expect(audit.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.account.provisioned' }),
    );
  });

  it('names the administrator pair a password product declares', async () => {
    const { service, product, adapters, audit } = build();
    product.credentialKind = 'password';

    await service.sweep();

    expect(adapters.for).toHaveBeenCalled();
    expect(product.createUser).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          reason: 'admin_credential_missing',
          detail: 'the product declares no administrator login pair',
        }),
      }),
    );
  });

  it('names the variables an operator has to supply', async () => {
    const { service, product, secrets, audit } = build();
    product.credentialKind = 'password';
    product.passwordVariables = {
      username: 'ORANGEHRM_ADMIN_USERNAME',
      password: 'ORANGEHRM_ADMIN_PASSWORD',
    };
    secrets.find.mockResolvedValue(null);

    await service.sweep();

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          detail:
            'the instance administrator login (ORANGEHRM_ADMIN_USERNAME / ORANGEHRM_ADMIN_PASSWORD) is not configured',
        }),
      }),
    );
  });
});

describe('the administrator credential', () => {
  it('treats an unreadable instance secret as missing, for a bearer product', async () => {
    const { service, secrets, audit } = build();
    secrets.find.mockRejectedValueOnce(new Error('root key unavailable'));

    await service.sweep();

    expect(secrets.open).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: 'admin_credential_missing' }),
      }),
    );
  });

  it('treats a token that cannot be opened as missing', async () => {
    const { service, secrets, audit } = build();
    secrets.open.mockRejectedValueOnce(new Error('SCOPE_MISMATCH'));

    await service.sweep();

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: 'admin_credential_missing' }),
      }),
    );
  });

  /**
   * ADR-BE-22 §Credentials (amendment): the derived token is submitted through the product's own
   * sign-in form, so a refusal must not be retried on the next pass — the product locks an account
   * after a run of failed attempts, and a wrong seed password is a human's edit.
   */
  it('does not derive a token again while a recent bootstrap failure stands', async () => {
    const { service, product, secrets, audit, db } = build();
    product.credentialKind = 'bearer';
    product.adminBootstrap = {
      login: 'admin',
      passwordVariable: 'OPENPROJECT_SEED__ADMIN__USER__PASSWORD',
    };
    // The relay token is gone; the seed credential the deploy wrote is still there.
    secrets.find.mockImplementation((async (_scope: string, _owner: string, name: string) =>
      name === 'product_api_token'
        ? null
        : {
            id: 'seed-secret',
            scope: 'instance',
            ownerId: 'instance-1',
            name,
            version: 1,
            masked: '••••',
          }) as never);
    mintAdminToken.mockResolvedValueOnce({
      ok: false,
      reason: 'password_rejected',
      detail: 'the product refused the seeded administrator password',
    });

    await service.sweep();

    // The pass spent exactly one sign-in, and the refusal is on the record.
    expect(secrets.open).toHaveBeenCalledOnce();
    expect(mintAdminToken).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.admin_credential.bootstrap_failed',
        detail: expect.objectContaining({ reason: 'password_rejected' }),
      }),
    );

    /*
     * The window is a row, so it survives the process that wrote it: a restart used to clear the map
     * and spend another submission of the seeded administrator's password on a product that locks
     * the account after a run of failures. Instance-wide, because the token is the deployment's.
     */
    const deferral = db.calls.find(
      (call) =>
        call.sql.includes('INSERT INTO relay_retry_window') &&
        call.params.includes('admin_bootstrap'),
    );
    expect(deferral?.params).toEqual(['instance-1', 'admin_bootstrap', 6 * 60 * 60 * 1_000]);

    // Five minutes later the quiet period still stands, so the password is not submitted again.
    vi.advanceTimersByTime(5 * 60 * 1_000);
    await service.sweep();
    expect(secrets.open).toHaveBeenCalledOnce();
    expect(mintAdminToken).toHaveBeenCalledOnce();

    // Six hours on, the window has elapsed and a person may have fixed the seed password.
    vi.advanceTimersByTime(6 * 60 * 60 * 1_000);
    await service.sweep();
    expect(mintAdminToken).toHaveBeenCalledTimes(2);
  });

  /**
   * The other half of the same policy: a product that has not finished booting is not a refusal.
   *
   * Measured on D09-01 (2026-11-11, twice): the deploy emitted `relay.provision` ~55 s after the
   * container started, `/login` answered `503` while Puma was still booting, and one six-hour period
   * applied to every outcome meant the token was not attempted again until `16:49` — each sweep in
   * between recording `admin_credential_missing` for every subject. Only a verdict may cost six
   * hours; an unreachable product submitted no password to lock.
   */
  it('retries a bootstrap the product could not answer a minute later', async () => {
    // The suites share one hoisted double and the counts above are absolute.
    mintAdminToken.mockClear();
    const { service, product, secrets, db } = build();
    product.credentialKind = 'bearer';
    product.adminBootstrap = {
      login: 'admin',
      passwordVariable: 'OPENPROJECT_SEED__ADMIN__USER__PASSWORD',
    };
    secrets.find.mockImplementation((async (_scope: string, _owner: string, name: string) =>
      name === 'product_api_token'
        ? null
        : {
            id: 'seed-secret',
            scope: 'instance',
            ownerId: 'instance-1',
            name,
            version: 1,
            masked: '••••',
          }) as never);
    mintAdminToken.mockResolvedValueOnce({
      ok: false,
      reason: 'product_unavailable',
      detail: 'the login page answered 503',
    });

    await service.sweep();

    const deferral = db.calls.find(
      (call) =>
        call.sql.includes('INSERT INTO relay_retry_window') &&
        call.params.includes('admin_bootstrap'),
    );
    expect(deferral?.params).toEqual(['instance-1', 'admin_bootstrap', 60 * 1_000]);

    // Still inside the minute: one attempt per period, never one per sweep.
    vi.advanceTimersByTime(30 * 1_000);
    await service.sweep();
    expect(mintAdminToken).toHaveBeenCalledOnce();

    // A minute on, the application has had time to finish booting.
    vi.advanceTimersByTime(30 * 1_000);
    await service.sweep();
    expect(mintAdminToken).toHaveBeenCalledTimes(2);
  });

  /**
   * What the person actually meets: a deployment finishes, the application starts answering, and the
   * launch asks for a mapping. A quiet period longer than the boot leaves that first click on the
   * product's own form — reported as "the automatic sign-in is not there yet" after a redeploy.
   */
  it('derives the token on the launch that follows a failed early attempt', async () => {
    mintAdminToken.mockClear();
    const { service, product, secrets } = build();
    product.credentialKind = 'bearer';
    product.adminBootstrap = {
      login: 'admin',
      passwordVariable: 'OPENPROJECT_SEED__ADMIN__USER__PASSWORD',
    };
    let token: Record<string, unknown> | null = null;
    secrets.find.mockImplementation((async (_scope: string, _owner: string, name: string) => {
      if (name !== 'product_api_token') {
        return {
          id: 'seed-secret',
          scope: 'instance',
          ownerId: 'instance-1',
          name,
          version: 1,
          masked: '••••',
        };
      }
      return token;
    }) as never);
    mintAdminToken.mockResolvedValueOnce({
      ok: false,
      reason: 'product_unavailable',
      detail: 'the login page answered 503',
    });

    // The deploy event: the product is still booting, so nothing is derived.
    await service.sweep();
    expect(mintAdminToken).toHaveBeenCalledOnce();

    /*
     * The application answers; the person's first click lands a minute later. The double cannot see
     * the `admin_credentials.store` the real code performs on success, so the stored row appears when
     * the mint succeeds — which is the only ordering the caller depends on.
     */
    mintAdminToken.mockImplementationOnce((async () => {
      token = {
        id: 'admin-secret',
        scope: 'instance',
        ownerId: 'instance-1',
        name: 'product_api_token',
        version: 1,
        masked: '••••',
      };
      return { ok: true, token: 'relay-token' };
    }) as never);
    vi.advanceTimersByTime(60 * 1_000);

    // The route validates the id as a uuid before it selects anything.
    const report = await service.provisionInstance(
      '11111111-1111-4111-8111-111111111111',
      'subject-1',
    );

    expect(mintAdminToken).toHaveBeenCalledTimes(2);
    expect(secrets.put).toHaveBeenCalled();
    expect(product.createUser).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ considered: 1, provisioned: 1, failed: 0 });
  });

  it('finishes the pass even when every bookkeeping writer refuses', async () => {
    mintAdminToken.mockClear();
    const { service, product, secrets, audit, adminCredentials } = build({
      override: (sql: string) => {
        if (sql.includes('DELETE FROM relay_retry_window')) throw new Error('row is locked');
        return undefined;
      },
    });
    product.credentialKind = 'bearer';
    product.adminBootstrap = {
      login: 'admin',
      passwordVariable: 'OPENPROJECT_SEED__ADMIN__USER__PASSWORD',
    };
    // The relay token is absent; the seed credential the deploy wrote is still readable.
    let token: Record<string, unknown> | null = null;
    secrets.find.mockImplementation((async (_scope: string, _owner: string, name: string) => {
      if (name !== 'product_api_token') {
        return {
          id: 'seed-secret',
          scope: 'instance',
          ownerId: 'instance-1',
          name,
          version: 1,
          masked: '••••',
        };
      }
      return token;
    }) as never);
    mintAdminToken.mockImplementationOnce((async () => {
      token = {
        id: 'admin-secret',
        scope: 'instance',
        ownerId: 'instance-1',
        name: 'product_api_token',
        version: 1,
        masked: '••••',
      };
      return { ok: true, token: 'relay-token', completedPasswordChange: true };
    }) as never);
    audit.append.mockImplementation((async (row: { action: string }) => {
      if (row.action === 'relay.admin_credential.password_change_completed') {
        throw new Error('chain down');
      }
      return { seq: '1', hash: 'h' };
    }) as never);
    adminCredentials.store.mockRejectedValueOnce(new Error('vault down'));

    await expect(service.sweep()).resolves.toBeUndefined();

    // The product-side work already happened: a refused audit row, a refused secret write or a
    // window that cannot be cleared is reported, never turned into a failed provisioning pass.
    expect(mintAdminToken).toHaveBeenCalledOnce();
    expect(adminCredentials.store).toHaveBeenCalledOnce();
    expect(product.createUser).toHaveBeenCalledOnce();
  });

  it('reads the password pair through M15 and M03 for a password product', async () => {
    const { service, product, secrets, renderer, audit } = build();
    product.credentialKind = 'password';
    product.passwordVariables = {
      username: 'ORANGEHRM_ADMIN_USERNAME',
      password: 'ORANGEHRM_ADMIN_PASSWORD',
    };

    await service.sweep();

    expect(renderer.instanceEnv).toHaveBeenCalledWith('instance-1');
    expect(secrets.find).toHaveBeenCalledWith('instance', 'instance-1', 'ORANGEHRM_ADMIN_PASSWORD');
    expect(product.createUser).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.account.provisioned' }),
    );
  });

  it('refuses a pair whose secret cannot be read', async () => {
    const { service, product, secrets, audit } = build();
    product.credentialKind = 'password';
    product.passwordVariables = {
      username: 'ORANGEHRM_ADMIN_USERNAME',
      password: 'ORANGEHRM_ADMIN_PASSWORD',
    };
    secrets.find.mockRejectedValueOnce(new Error('root key unavailable'));

    await service.sweep();

    expect(product.createUser).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: 'admin_credential_missing' }),
      }),
    );
  });

  it('refuses a pair whose password cannot be opened', async () => {
    const { service, product, secrets, audit } = build();
    product.credentialKind = 'password';
    product.passwordVariables = {
      username: 'ORANGEHRM_ADMIN_USERNAME',
      password: 'ORANGEHRM_ADMIN_PASSWORD',
    };
    // The bearer `find` is not used here; the secret is the second call to `open`.
    secrets.open.mockRejectedValueOnce(new Error('SCOPE_MISMATCH'));

    await service.sweep();

    expect(product.createUser).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: 'admin_credential_missing' }),
      }),
    );
  });

  it('refuses a pair whose username the renderer does not supply', async () => {
    const { service, product, secrets, renderer, audit } = build();
    product.credentialKind = 'password';
    product.passwordVariables = {
      username: 'ORANGEHRM_ADMIN_USERNAME',
      password: 'ORANGEHRM_ADMIN_PASSWORD',
    };
    renderer.instanceEnv.mockResolvedValueOnce([
      { name: 'ORANGEHRM_ADMIN_USERNAME', secret: true, value: 'Admin' },
      { name: 'SOMETHING_ELSE', secret: false, value: 'x' },
    ]);

    await service.sweep();

    expect(secrets.open).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: 'admin_credential_missing' }),
      }),
    );
  });

  it('treats an unreadable environment as a missing username', async () => {
    const { service, product, secrets, renderer, audit } = build();
    product.credentialKind = 'password';
    product.passwordVariables = {
      username: 'ORANGEHRM_ADMIN_USERNAME',
      password: 'ORANGEHRM_ADMIN_PASSWORD',
    };
    renderer.instanceEnv.mockRejectedValueOnce(new Error('renderer down'));

    await service.sweep();

    expect(secrets.open).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: 'admin_credential_missing' }),
      }),
    );
  });
});

describe('a reconciliation that cannot finish', () => {
  it('records a failed reset instead of leaving the mapping active', async () => {
    const { service, product, audit } = build({ candidates: [RETRY_CANDIDATE] });
    product.createUser.mockResolvedValueOnce({ ok: false, status: 422, detail: 'taken' });
    product.findUserByLogin.mockResolvedValueOnce({
      ok: true,
      value: { id: 'user-9', admin: false },
    });
    product.resetPassword.mockResolvedValueOnce({ ok: false, status: 422, detail: 'refused' });

    await service.sweep();

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          reason: 'product_unavailable',
          detail: 'refused',
        }),
      }),
    );
  });

  it('activates the mapping even when the audit chain refuses the row', async () => {
    const { service, audit, db } = build();
    audit.append.mockRejectedValueOnce(new Error('chain down'));

    await service.sweep();

    // The account exists; a failed audit row is not a reason to leave the mapping `pending`.
    expect(
      db.calls.some(
        (call) =>
          call.sql.includes('UPDATE product_account') && call.sql.includes("state = 'active'"),
      ),
    ).toBe(true);
  });

  it('records the failure even when the row cannot be written', async () => {
    const { service, product, audit } = build({
      candidates: [RETRY_CANDIDATE],
      override: (sql) => {
        if (sql.includes('UPDATE product_account') && sql.includes("state = 'failed'")) {
          throw new Error('row locked');
        }
        return undefined;
      },
    });
    product.createUser.mockResolvedValueOnce({ ok: false, status: 503, detail: 'unavailable' });
    product.findUserByLogin.mockResolvedValueOnce({ ok: false, status: 503, detail: 'no' });

    await service.sweep();

    // The row write failed, and the evidence still reached the audit chain.
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.account.provision_failed',
        detail: expect.objectContaining({ reason: 'product_unavailable' }),
      }),
    );
  });

  it('survives an audit chain that refuses the failure row too', async () => {
    const { service, product, audit } = build({
      candidates: [RETRY_CANDIDATE],
      override: (sql) => {
        if (sql.includes('UPDATE product_account') && sql.includes("state = 'failed'")) {
          throw new Error('row locked');
        }
        return undefined;
      },
    });
    product.createUser.mockResolvedValueOnce({ ok: false, status: 503, detail: 'unavailable' });
    product.findUserByLogin.mockResolvedValueOnce({ ok: false, status: 503, detail: 'no' });
    audit.append.mockRejectedValueOnce(new Error('chain down'));

    await expect(service.sweep()).resolves.toBeUndefined();
  });
});

describe('the failure quiet period', () => {
  it('audits one permanent misconfiguration once, then again after the window', async () => {
    const { service, adapters, audit } = build();
    adapters.for.mockReturnValue(null);

    await service.sweep();
    await service.sweep();
    // Same (instance, subject, reason) inside the retry window: the row was already written.
    expect(audit.append).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-03-04T09:20:00.000Z'));
    await service.sweep();

    expect(audit.append).toHaveBeenCalledTimes(2);
  });

  it('holds the window in a row, so a restart neither re-audits nor re-attempts', async () => {
    const { service, adapters, db } = build();
    adapters.for.mockReturnValue(null);

    await service.sweep();

    const claim = db.calls.find((call) => call.sql.includes('INSERT INTO relay_retry_window'));
    // The conditional upsert is the claim: exactly one caller inside the window gets a row back, and
    // what it reads back is the table's state rather than this process's.
    expect(claim?.sql).toContain('WHERE relay_retry_window.retry_after <= now()');
    expect(claim?.sql).toContain('ON CONFLICT (instance_id, subject_idp_id, reason) DO UPDATE');
  });
});

describe('rotation', () => {
  it('keeps an unexpected rotation error inside the pass', async () => {
    const { service, adapters } = build({ candidates: [], rotations: [ROTATION] });
    adapters.for.mockImplementation(() => {
      throw new Error('registry exploded');
    });

    await expect(service.sweep()).resolves.toBeUndefined();
  });

  it('marks a mapping failed when the product has no adapter for it', async () => {
    const { service, adapters, db, redis } = build({ candidates: [], rotations: [ROTATION] });
    adapters.for.mockReturnValue(null);
    redis.store.set('relay:instance-1:subject-1', '{"cookies":["a=1"]}');

    await service.sweep();

    expect(db.calls.some((call) => call.params?.[1] === 'adapter_missing')).toBe(true);
    // A cached session would hide the broken credential from the user and from the check.
    expect(redis.store.size).toBe(0);
  });

  it('marks a mapping failed when the administrator credential is gone', async () => {
    const { service, product, adapters, db } = build({
      candidates: [],
      rotations: [ROTATION],
    });
    product.credentialKind = 'password';

    await service.sweep();

    expect(adapters.for).toHaveBeenCalled();
    expect(db.calls.some((call) => call.params?.[1] === 'admin_credential_missing')).toBe(true);
  });

  it('marks a mapping failed when the account cannot be found in the product', async () => {
    const { service, product, db } = build({ candidates: [], rotations: [ROTATION] });
    product.findUserByLogin.mockResolvedValueOnce({ ok: false, status: 503, detail: 'down' });

    await service.sweep();

    expect(db.calls.some((call) => call.params?.[1] === 'product_unavailable')).toBe(true);
  });

  it('rotates and audits, even when the audit chain refuses the row', async () => {
    const { service, product, audit, db } = build({ candidates: [], rotations: [ROTATION] });
    product.findUserByLogin.mockResolvedValueOnce({
      ok: true,
      value: { id: 'user-9', admin: false },
    });
    audit.append.mockRejectedValueOnce(new Error('chain down'));

    await service.sweep();

    expect(product.resetPassword).toHaveBeenCalledOnce();
    expect(
      db.calls.some(
        (call) =>
          call.sql.includes('UPDATE product_account') && call.sql.includes('rotated_at = now()'),
      ),
    ).toBe(true);
  });

  it('marks a rotation failed even when the row and the chain both refuse', async () => {
    const { service, adapters, audit } = build({
      candidates: [],
      rotations: [ROTATION],
      override: (sql) => {
        if (sql.includes('UPDATE product_account') && sql.includes("state = 'failed'")) {
          throw new Error('row locked');
        }
        return undefined;
      },
    });
    adapters.for.mockReturnValue(null);
    audit.append.mockRejectedValueOnce(new Error('chain down'));

    await expect(service.sweep()).resolves.toBeUndefined();
  });
});

describe('offboarding', () => {
  const MAPPING = [
    { id: 'account-1', instance_id: 'instance-1', login: 'jane.doe', secret_ref: 'secret-1' },
  ];

  it('does nothing when the mappings cannot be read', async () => {
    const { service, secrets, redis } = build({
      override: (sql) => {
        if (sql.includes('FROM product_account WHERE subject_idp_id')) {
          throw new Error('database unavailable');
        }
        return undefined;
      },
    });

    await expect(service.deprovision('subject-1')).resolves.toBeUndefined();
    expect(secrets.remove).not.toHaveBeenCalled();
    // Nothing to revoke, so the cache walk is not even attempted.
    expect(redis.scan).not.toHaveBeenCalled();
  });

  it('drops the cache even when the secret, the row and the audit row all fail', async () => {
    const { service, secrets, audit, redis, product } = build({
      override: (sql) => {
        if (sql.includes('FROM product_account WHERE subject_idp_id')) return rowsOf(MAPPING);
        if (sql.includes('LEFT JOIN instance_route r ON r.instance_id = i.id')) {
          return rowsOf([
            { slug: 'openproject', payload: { httpPort: 80 }, host: 'openproject.localhost' },
          ]);
        }
        if (sql.startsWith('DELETE FROM product_account')) throw new Error('row locked');
        return undefined;
      },
    });
    product.findUserByLogin.mockResolvedValueOnce({ ok: true, value: { id: 'user-9' } });
    secrets.remove.mockRejectedValueOnce(new Error('root key unavailable'));
    audit.append.mockRejectedValueOnce(new Error('chain down'));
    redis.store.set('relay:instance-1:subject-1', '{"cookies":["a=1"]}');

    await expect(service.deprovision('subject-1')).resolves.toBeUndefined();

    // "We could not disable the account" is not a reason to keep holding its password.
    expect(secrets.remove).toHaveBeenCalledOnce();
    expect(redis.store.size).toBe(0);
  });

  it('records an offboarding the product could not confirm', async () => {
    const { service, audit } = build({
      override: (sql) => {
        if (sql.includes('FROM product_account WHERE subject_idp_id')) return rowsOf(MAPPING);
        // No instance row: the platform stops holding the credential and says so.
        if (sql.includes('LEFT JOIN instance_route r ON r.instance_id = i.id')) return rowsOf([]);
        return undefined;
      },
    });

    await service.deprovision('subject-1');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.account.deprovisioned',
        detail: expect.objectContaining({ disabledInProduct: false }),
      }),
    );
  });

  it('records an offboarding whose product has no adapter', async () => {
    const { service, audit, adapters } = build({
      override: (sql) => {
        if (sql.includes('FROM product_account WHERE subject_idp_id')) return rowsOf(MAPPING);
        if (sql.includes('LEFT JOIN instance_route r ON r.instance_id = i.id')) {
          return rowsOf([
            { slug: 'openproject', payload: { httpPort: 80 }, host: 'openproject.localhost' },
          ]);
        }
        return undefined;
      },
    });
    adapters.for.mockReturnValue(null);

    await service.deprovision('subject-1');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ disabledInProduct: false }),
      }),
    );
  });

  it('records an offboarding whose account the product no longer has', async () => {
    const { service, audit, product } = build({
      override: (sql) => {
        if (sql.includes('FROM product_account WHERE subject_idp_id')) return rowsOf(MAPPING);
        if (sql.includes('LEFT JOIN instance_route r ON r.instance_id = i.id')) {
          return rowsOf([
            { slug: 'openproject', payload: { httpPort: 80 }, host: 'openproject.localhost' },
          ]);
        }
        return undefined;
      },
    });
    product.findUserByLogin.mockResolvedValueOnce({ ok: true, value: null });

    await service.deprovision('subject-1');

    expect(product.disableUser).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ disabledInProduct: false }),
      }),
    );
  });
});

describe('the generated product login', () => {
  it('falls back to the subject hash when the directory name is too short', async () => {
    const { service, product } = build({ candidates: [{ ...CANDIDATE, username: 'ab' }] });

    await service.sweep();

    const created = product.createUser.mock.calls[0]?.[1] as { login: string } | undefined;
    // The product's own minimum is three characters; a two-letter login would be refused there.
    expect(created?.login.startsWith('user-')).toBe(true);
  });

  it('suffixes a login another mapping already holds', async () => {
    const { service, product } = build({
      candidates: [{ ...CANDIDATE, username: 'jane.doe' }],
      override: (sql) => {
        if (sql.includes('SELECT login FROM product_account WHERE instance_id')) {
          return rowsOf([{ login: 'jane.doe' }]);
        }
        return undefined;
      },
    });

    await service.sweep();

    const created = product.createUser.mock.calls[0]?.[1] as { login: string } | undefined;
    expect(created?.login.startsWith('jane.doe-')).toBe(true);
  });

  it('keeps a login an earlier pass already derived', async () => {
    const { service, product } = build({ candidates: [RETRY_CANDIDATE] });

    await service.sweep();

    expect(product.createUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ login: 'jane.doe' }),
    );
  });
});
