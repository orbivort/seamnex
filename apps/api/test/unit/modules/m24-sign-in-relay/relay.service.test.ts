import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { RelaySignInService } from '../../../../src/modules/m24-sign-in-relay/relay.service';
import { relaySessionKey } from '../../../../src/modules/m24-sign-in-relay/relay-cache';
import { fakeDb, globMatches, type Route } from '../../../support/fakes';

/**
 * The transport, not the global: `productFetch` exists because `fetch` cannot send the product's
 * `Host` header, so a test that stubs `globalThis.fetch` would either be bypassed or silently prove
 * nothing. Stubbing the module keeps the seam where the real code puts it.
 */
const { productFetchMock } = vi.hoisted(() => ({ productFetchMock: vi.fn() }));
vi.mock('../../../../src/modules/m24-sign-in-relay/product-http', () => ({
  productFetch: productFetchMock,
}));

/**
 * The relay decides *whether* to touch a product at all, and that decision is where every security
 * property lives: no flag, no mapping, no entitlement, or another tab already signing in all mean
 * "fall back". The password half is covered by the driver's own tests; here the driver is replayed
 * through the injected `fetch`, so the two halves are exercised together.
 */

const LOGIN_PAGE = `<html><body><form class="user-login--form" action="/login">
  <input type="hidden" name="authenticity_token" value="csrf-1" />
  <input name="username" /><input type="password" name="password" />
</form></body></html>`;
const APP_PAGE = '<html><body><div id="main-menu">Projects</div></body></html>';

type Page = 'login' | 'login-post' | 'app' | { status: number; body: string };

function respond(init: {
  status: number;
  body?: string;
  location?: string;
  cookie?: string;
}): Response {
  const headers = new Headers();
  if (init.location !== undefined) headers.set('location', init.location);
  if (init.cookie !== undefined) headers.append('set-cookie', init.cookie);
  return new Response(init.body ?? '', { status: init.status, headers });
}

function cacheRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) store.delete(key);
      return keys.length;
    }),
    // The cache no longer hands a subject id to `KEYS`; the double applies real `MATCH` glob
    // semantics, so a pattern that matches nothing is visible instead of being papered over.
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      return ['0', [...store.keys()].filter((key) => globMatches(pattern, key))] as [
        string,
        string[],
      ];
    }),
    // The release script compares the token and deletes the key; the double does the delete so a
    // test asserting "nothing was cached" is not tripped by a lock that was in fact released.
    eval: vi.fn(async (_script: string, _keys: number, key: string) => {
      store.delete(key);
      return 1;
    }),
  };
}

type Setup = {
  allowRelay?: boolean;
  authMode?: string;
  entryKey?: string;
  /** The operator's allow-list; the shipped default is the composed key. */
  entryKeys?: string;
  account?: { id: string; login: string; secret_ref: string; state: string } | null;
  entitled?: boolean;
  sessionMaxMinutes?: number | null;
  lockAvailable?: boolean;
  cachedCookies?: string[];
  /** Makes the breaker reset fail, which must not fail the launch but must be visible. */
  failureResetFails?: boolean;
  /** The route table knows nothing about this instance and host. */
  noRoute?: boolean;
  /** The instance's rendered payload; `null` is a row written before a render. */
  payload?: Record<string, unknown> | null;
  /** The instance's lifecycle state, as the launch card's readiness read sees it. */
  instanceState?: string;
  /** Makes the audit chain refuse the outcome row. */
  auditFails?: 'error' | 'string';
  /** Makes the credential-failure counter refuse its update. */
  countFails?: boolean;
  /** Makes the integration check refuse to record. */
  checkFails?: boolean;
  /**
   * The provisioning role's double. A launch may ask for a mapping the sweep has not created yet;
   * `setAccount` is what lets the double be the thing that creates it.
   */
  accounts?: { provisionInstance: ReturnType<typeof vi.fn> };
};

function setup(options: Setup = {}) {
  // Mutable on purpose: a launch may provision and then read the row back, so the mapping has to
  // appear between two reads of the same fake route.
  let accountRow: { id: string; login: string; secret_ref: string; state: string } | null =
    options.account === null
      ? null
      : (options.account ?? {
          id: 'account-1',
          login: 'jdoe',
          secret_ref: 'secret-1',
          state: 'active',
        });

  const db = fakeDb([
    [
      'FROM instance_route r',
      options.noRoute === true
        ? []
        : [
            {
              auth_mode: options.authMode ?? 'fa_gate',
              slug: 'openproject',
              entry_key: options.entryKey ?? 'D09-01',
              payload: options.payload === undefined ? { httpPort: 80 } : options.payload,
              session_max_minutes:
                options.sessionMaxMinutes === undefined ? 120 : options.sessionMaxMinutes,
              host: 'openproject.localhost',
              state: options.instanceState ?? 'ready',
            },
          ],
    ],
    ['SELECT 1 FROM entitlement', options.entitled === false ? [] : [{ '?column?': 1 }]],
    [
      'UPDATE product_account',
      (sql: string) => {
        if (options.countFails === true && sql.includes('consecutive_failures + 1')) {
          throw new Error('database unavailable');
        }
        if (options.failureResetFails === true) throw new Error('database unavailable');
        return [];
      },
    ],
    ['FROM product_account', () => (accountRow === null ? [] : [accountRow])],
  ] as Route[]);

  const key = relaySessionKey('instance-1', 'subject-1');
  const redis = cacheRedis(
    options.cachedCookies === undefined
      ? {}
      : {
          [key]: JSON.stringify({ cookies: options.cachedCookies, cachedAt: 1 }),
        },
  );
  if (options.lockAvailable === false) {
    redis.set.mockImplementation(async () => null as unknown as string);
  }
  const secrets = {
    open: vi.fn(async () => 'product-password'),
    find: vi.fn(async () => null),
    put: vi.fn(),
    rotate: vi.fn(),
    remove: vi.fn(),
  };
  const audit = {
    append: vi.fn(async () => {
      if (options.auditFails === 'error') throw new Error('audit chain unavailable');
      if (options.auditFails === 'string') throw 'audit chain unavailable';
      return { seq: '1', hash: 'h' };
    }),
  };
  const integration = {
    recordCheck: vi.fn(async () => {
      if (options.checkFails === true) throw new Error('check store unavailable');
      return undefined;
    }),
  };
  const metrics = {
    relayAuditFailures: { labels: vi.fn(() => ({ inc: vi.fn() })) },
    relayCredentialResetFailures: { inc: vi.fn() },
  };
  const docker = { connectNetwork: vi.fn(async () => undefined) };
  const config = {
    SEAMNEX_RELAY_ENABLED: options.allowRelay ?? true,
    SEAMNEX_RELAY_HTTP_TIMEOUT_MS: 1_000,
    SEAMNEX_RELAY_LOCK_SECONDS: 30,
    SEAMNEX_RELAY_SESSION_TTL_SECONDS: 1_800,
    SEAMNEX_RELAY_ENTRY_KEYS: options.entryKeys ?? 'D09-01',
    SEAMNEX_RELAY_CONTAINER: '',
    SEAMNEX_PRODUCT_URL_SCHEME: 'http',
    SEAMNEX_PRODUCT_URL_PORT: '8020',
    SEAMNEX_INGRESS_DOMAIN: 'localhost',
    SEAMNEX_ROLE: 'relay',
  };

  const service = new RelaySignInService(
    db.pool,
    redis as never,
    config as never,
    secrets as never,
    audit as never,
    integration as never,
    metrics as never,
    docker as never,
    options.accounts as never,
  );
  return {
    service,
    db,
    redis,
    secrets,
    audit,
    integration,
    metrics,
    docker,
    accounts: options.accounts,
    setAccount: (row: { id: string; login: string; secret_ref: string; state: string }) => {
      accountRow = row;
    },
  };
}

const input = {
  instanceId: 'instance-1',
  subjectIdpId: 'subject-1',
  routeHost: 'openproject.localhost',
  publicOrigin: 'http://openproject.localhost:8020',
};

function stubProduct(pages: Page[]): void {
  const queue = [...pages];
  productFetchMock.mockImplementation(async (url: string, _init?: RequestInit) => {
    // Step ③'s positive confirmation. Answered out of band so each test's page list stays about
    // the login flow it exercises.
    if (url.endsWith('/api/v3/users/me')) {
      return respond({ status: 200, body: JSON.stringify({ login: 'jdoe', admin: null }) });
    }
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected product request');
    if (next === 'login') return respond({ status: 200, body: LOGIN_PAGE });
    if (next === 'app') return respond({ status: 200, body: APP_PAGE });
    if (next === 'login-post') {
      return respond({ status: 302, location: '/', cookie: '_open_project_session=s1' });
    }
    return respond(next);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  productFetchMock.mockReset();
});

describe('RelaySignInService', () => {
  it('does nothing at all when the deployment switch is off', async () => {
    const { service, db, secrets } = setup({ allowRelay: false });

    const outcome = await service.attempt(input);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'disabled' });
    expect(db.calls).toEqual([]);
    expect(secrets.open).not.toHaveBeenCalled();
  });

  it('skips a product that is not a proxy gate', async () => {
    const { service } = setup({ authMode: 'native' });

    expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'not_gated' });
  });

  it('skips an entry that is not allow-listed for a managed credential', async () => {
    const { service } = setup({ entryKey: 'D01-01' });

    expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'not_gated' });
  });

  /*
   * An environment file may still carry the catalogue's legacy grammar (`D9`) while the deployed
   * instance carries `D09-01`. Comparing the strings matched nothing, so the relay skipped every
   * launch on the dev stack and the browser saw the login form — the exact silent degradation the ADR
   * lists as a failure mode. The alias still has to resolve.
   */
  it('recognises a gated entry addressed by its composed catalogue key', async () => {
    const { service, secrets } = setup({ entryKey: 'D09-01' });
    stubProduct(['login', 'login-post', 'app']);

    const outcome = await service.attempt(input);

    expect(outcome.kind).toBe('relayed');
    expect(secrets.open).toHaveBeenCalledTimes(1);
  });

  it('still accepts the legacy spelling of the same key in an existing environment file', async () => {
    const { service } = setup({ entryKey: 'D09-01', entryKeys: 'D9' });
    stubProduct(['login', 'login-post', 'app']);

    expect((await service.attempt(input)).kind).toBe('relayed');
  });

  /*
   * `catalog_entry.key` is a primary key, so one entry names one product. A sibling deployment
   * definition (`D09-02`) must not inherit the allow-list entry of `D09-01`: comparisons are exact
   * after `resolveKey`, and a prefix match here would silently widen the FR-2.16 exception.
   */
  it('does not let one composed key select a sibling definition of the same product', async () => {
    const { service } = setup({ entryKey: 'D09-02' });

    expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'not_gated' });
  });

  it('reports an allow-listed entry that has no login adapter instead of guessing', async () => {
    const { service } = setup({ entryKey: 'D11-01', entryKeys: 'D09-01,D11-01' });

    // Metabase-style: gated and consented, but nothing registered to drive its form.
    expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'no_adapter' });
  });

  it('does not let the legacy alias of another domain match', async () => {
    const { service } = setup({ entryKey: 'D03-01' });

    expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'not_gated' });
  });

  it('skips a subject with no product account mapping', async () => {
    const { service, secrets } = setup({ account: null });

    expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'no_mapping' });
    expect(secrets.open).not.toHaveBeenCalled();
  });

  it('skips a subject whose entitlement is gone, even when a mapping remains', async () => {
    const { service, secrets } = setup({ entitled: false });

    expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'no_mapping' });
    expect(secrets.open).not.toHaveBeenCalled();
  });

  it('normalises the forwarded host so a browser port neither skips the route nor doubles the origin', async () => {
    const { service, db } = setup({ cachedCookies: ['_open_project_session=s1'] });
    const calls: string[] = [];
    productFetchMock.mockImplementation(async (url: string) => {
      calls.push(url);
      // Step ③'s positive confirmation, which the cache-reuse path also performs.
      if (url.endsWith('/api/v3/users/me')) {
        return respond({ status: 200, body: JSON.stringify({ login: 'jdoe' }) });
      }
      return respond({ status: 200, body: APP_PAGE });
    });

    // The edge forwards the browser's Host verbatim; the browser includes `:8020`.
    const outcome = await service.attempt({ ...input, routeHost: 'openproject.localhost:8020' });

    expect(outcome.kind).toBe('reused');
    // `instance_route.host` never carries a port, so the lookup must use the bare host.
    expect(db.calls.some((call) => call.params?.[1] === 'openproject.localhost')).toBe(true);
    // And the product is dialled by its internal alias, never by the public origin.
    expect(calls.every((url) => url.startsWith('http://openproject:80'))).toBe(true);
  });

  it('refuses an account that is not active and never opens its secret', async () => {
    const { service, secrets } = setup({
      account: { id: 'a1', login: 'jdoe', secret_ref: 's1', state: 'failed' },
    });

    // Three codes, not one: `failed` is the breaker, `pending` is provisioning catching up, and
    // the operator action differs for each.
    expect(await service.attempt(input)).toEqual({ kind: 'failed', reason: 'account_failed' });
    expect(secrets.open).not.toHaveBeenCalled();
  });

  it('reports a pending mapping as pending rather than as a generic disable', async () => {
    const { service } = setup({
      account: { id: 'a1', login: 'jdoe', secret_ref: 's1', state: 'pending' },
    });

    expect(await service.attempt(input)).toEqual({ kind: 'failed', reason: 'account_pending' });
  });

  it('reuses a cached session that the product still accepts, without reading the secret', async () => {
    const { service, secrets, audit } = setup({ cachedCookies: ['_open_project_session=old'] });
    stubProduct(['app']);

    const outcome = await service.attempt(input);

    expect(outcome).toEqual({ kind: 'reused', cookies: ['_open_project_session=old'] });
    expect(secrets.open).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.signin.reused' }),
    );
  });

  it('signs in, caches the product cookie and audits a relayed outcome', async () => {
    const { service, redis, audit, integration } = setup();
    stubProduct(['login', 'login-post', 'app']);

    const outcome = await service.attempt(input);

    expect(outcome).toEqual({ kind: 'relayed', cookies: ['_open_project_session=s1'] });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.signin.relayed',
        detail: expect.objectContaining({ outcome: 'relayed' }),
      }),
    );
    expect(integration.recordCheck).toHaveBeenCalledWith(
      input.instanceId,
      'relay_login',
      true,
      expect.any(String),
    );
    const stored = redis.store.get(relaySessionKey(input.instanceId, input.subjectIdpId));
    expect(stored).toContain('_open_project_session=s1');
  });

  /*
   * The credential is a per-user product password; `open` takes the scope and the owner so that a
   * `secret_ref` that drifted onto an instance secret (the admin API token, a break-glass
   * password) is refused instead of being submitted as this person's password.
   */
  it('opens the credential as this mapping’s own secret, naming its scope and owner', async () => {
    const { service, secrets } = setup();
    stubProduct(['login', 'login-post', 'app']);

    await service.attempt(input);

    expect(secrets.open).toHaveBeenCalledWith('secret-1', expect.stringContaining('subject-1'), {
      scope: 'product_account',
      ownerId: 'account-1',
    });
  });

  it('clears the failure counter once a sign-in succeeds', async () => {
    const { service, db } = setup();
    stubProduct(['login', 'login-post', 'app']);

    await service.attempt(input);

    expect(
      db.calls.some(
        (call) => call.sql.includes('consecutive_failures = 0') && call.params?.[0] === 'account-1',
      ),
    ).toBe(true);
  });

  /*
   * The reset is best-effort but not silent. A transient database failure after a successful
   * sign-in used to leave the counter elevated, so two later rejections the mapping did not earn
   * marked it `failed` and stopped relayed sign-in until the rotation pass ran.
   */
  it('still relays when the failure counter cannot be reset, and counts the failure', async () => {
    const { service, metrics } = setup({ failureResetFails: true });
    stubProduct(['login', 'login-post', 'app']);

    const outcome = await service.attempt(input);

    expect(outcome.kind).toBe('relayed');
    expect(metrics.relayCredentialResetFailures.inc).toHaveBeenCalled();
  });

  /*
   * 20 refused logins lock the account for 30 minutes. Before the counter, a broken credential
   * produced one refused login per click until the product did exactly that — the blast radius
   * ADR-BE-22 names. The relay now stops at three and leaves the recovery to the rotation pass.
   */
  it('counts a refused credential so the mapping stops before the product locks it', async () => {
    const { service, db, audit } = setup();
    stubProduct([
      'login',
      { status: 422, body: `${LOGIN_PAGE}<div role="alert">Invalid user or password.</div>` },
    ]);

    const outcome = await service.attempt(input);

    expect(outcome).toEqual({ kind: 'failed', reason: 'credential_rejected' });
    const counted = db.calls.find((call) => call.sql.includes('consecutive_failures + 1'));
    expect(counted?.params).toEqual(['account-1', 3]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.signin.failed',
        detail: expect.objectContaining({ reason: 'credential_rejected' }),
      }),
    );
  });

  it('does not count a failure that is not about the credential', async () => {
    const { service, db } = setup();
    stubProduct(['login', { status: 200, body: '<html>Maintenance</html>' }]);

    await service.attempt(input);

    expect(db.calls.some((call) => call.sql.includes('consecutive_failures + 1'))).toBe(false);
  });

  it('does not count an unreadable credential as a password the product rejected', async () => {
    const { service, db, secrets } = setup();
    secrets.open.mockRejectedValueOnce(new Error('SECRET_NOT_FOUND'));

    const outcome = await service.attempt(input);

    expect(outcome).toEqual({ kind: 'failed', reason: 'credential_unavailable' });
    expect(db.calls.some((call) => call.sql.includes('consecutive_failures + 1'))).toBe(false);
  });

  it('bounds the cached lifetime by the product session maximum when it is shorter', async () => {
    const { service, redis } = setup({ sessionMaxMinutes: 5 });
    stubProduct(['login', 'login-post', 'app']);

    await service.attempt(input);

    // Five minutes of product session minus the one-minute safety margin.
    expect(redis.set).toHaveBeenCalledWith(
      relaySessionKey(input.instanceId, input.subjectIdpId),
      expect.any(String),
      'EX',
      240,
    );
  });

  it('drops a cache entry the product no longer accepts and signs in again', async () => {
    const { service, secrets } = setup({ cachedCookies: ['_open_project_session=stale'] });
    // First `login` answers the reuse check with the form (a dead session), the rest is the sign-in.
    stubProduct(['login', 'login', 'login-post', 'app']);

    const outcome = await service.attempt(input);

    expect(outcome).toEqual({ kind: 'relayed', cookies: ['_open_project_session=s1'] });
    expect(secrets.open).toHaveBeenCalledTimes(1);
  });

  /*
   * ADR-BE-22 §Session reuse — "drop on any signal". Platform sign-out calls `invalidate` with no
   * instance, so the subject walk is the whole control; when the pattern escaped its own wildcard it
   * matched nothing and the product's bearer cookie stayed in Redis for the full TTL.
   */
  it('drops every cached product session for the subject on sign-out', async () => {
    const { service, redis } = setup({ cachedCookies: ['_open_project_session=old'] });
    redis.store.set(relaySessionKey('instance-2', 'subject-1'), '{"cookies":["x=1"]}');
    redis.store.set(relaySessionKey('instance-1', 'subject-2'), '{"cookies":["y=2"]}');

    await service.invalidate({ subjectIdpId: 'subject-1' });

    expect([...redis.store.keys()]).toEqual([relaySessionKey('instance-1', 'subject-2')]);
  });

  it('falls back and records the reason when the login page changed shape', async () => {
    const { service, redis, audit, integration, secrets } = setup();
    stubProduct([{ status: 200, body: '<html>Maintenance</html>' }]);

    const outcome = await service.attempt(input);

    expect(outcome).toEqual({ kind: 'failed', reason: 'form_changed' });
    expect(redis.store.size).toBe(0);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.signin.failed',
        outcome: 'failure',
        detail: expect.objectContaining({ reason: 'form_changed' }),
      }),
    );
    expect(integration.recordCheck).toHaveBeenCalledWith(
      input.instanceId,
      'relay_login',
      false,
      expect.any(String),
    );
    // The secret was opened once (the attempt had already started) but no second attempt was made.
    expect(secrets.open).toHaveBeenCalledTimes(1);
  });

  it('skips instead of queueing a second login while another tab holds the lock', async () => {
    const { service, secrets } = setup({ lockAvailable: false });
    stubProduct([]);

    const outcome = await service.attempt(input);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'in_flight' });
    expect(secrets.open).not.toHaveBeenCalled();
  });

  it('never writes the credential into an audit detail or a check detail', async () => {
    const { service, audit, integration } = setup();
    stubProduct(['login', { status: 200, body: `${LOGIN_PAGE}<div role="alert">refused</div>` }]);

    await service.attempt(input);

    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('product-password');
    expect(JSON.stringify(integration.recordCheck.mock.calls)).not.toContain('product-password');
  });

  /*
   * The route lookup is the first decision, and "the relay did nothing" has to stay distinguishable
   * from "the relay is not configured": both answer `not_gated`, and only the log line says which
   * instance was tried.
   */
  it('declines a launch whose host and instance the route table does not know', async () => {
    const { service, secrets } = setup({ noRoute: true });

    expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'not_gated' });
    expect(secrets.open).not.toHaveBeenCalled();
  });

  it('reports an instance that declares no port instead of dialling a default one', async () => {
    const { service, secrets } = setup({ payload: null });

    // A row written before a render has no payload at all; the origin cannot be derived, and
    // guessing a port would reach the edge rather than the product.
    expect(await service.attempt(input)).toEqual({ kind: 'failed', reason: 'product_unavailable' });
    expect(secrets.open).not.toHaveBeenCalled();
  });

  it('assumes the conservative cache lifetime when the catalogue declares no session maximum', async () => {
    const { service, redis } = setup({ sessionMaxMinutes: null });
    stubProduct(['login', 'login-post', 'app']);

    await service.attempt(input);

    expect(redis.set).toHaveBeenCalledWith(
      relaySessionKey(input.instanceId, input.subjectIdpId),
      expect.any(String),
      'EX',
      600,
    );
  });

  it('names a deliberate disable as a disable, not as a pending or failed mapping', async () => {
    const { service } = setup({
      account: { id: 'a1', login: 'jdoe', secret_ref: 's1', state: 'disabled' },
    });

    expect(await service.attempt(input)).toEqual({ kind: 'failed', reason: 'account_disabled' });
  });

  /*
   * The audit row is the record of a relayed sign-in. A chain outage must not turn a working launch
   * into a broken one — but it must be counted and logged, because a silent gap here is a
   * repudiation gap an operator has to be able to see.
   */
  it('still relays when the outcome cannot be audited, and counts the gap', async () => {
    const { service, metrics } = setup({ auditFails: 'string' });
    stubProduct(['login', 'login-post', 'app']);

    const outcome = await service.attempt(input);

    expect(outcome.kind).toBe('relayed');
    expect(metrics.relayAuditFailures.labels).toHaveBeenCalledWith('relay.signin.relayed');
  });

  it('keeps a refused credential counted even when the counter cannot be written', async () => {
    const { service } = setup({ countFails: true });
    stubProduct([
      'login',
      { status: 422, body: `${LOGIN_PAGE}<div role="alert">Invalid user or password.</div>` },
    ]);

    // The product's own lockout is the danger, so the verdict is the same either way.
    expect(await service.attempt(input)).toEqual({
      kind: 'failed',
      reason: 'credential_rejected',
    });
  });

  it('keeps a check store failure out of the launch', async () => {
    const { service } = setup({ checkFails: true });
    stubProduct(['login', 'login-post', 'app']);

    expect((await service.attempt(input)).kind).toBe('relayed');
  });

  /*
   * The first click after an install.
   *
   * Provisioning is otherwise a sweep, and a sweep is a cadence: a deployment could finish, a person
   * could open the product, and the only thing between them and the product's own login form was
   * the timer. Restarting the scheduler was the workaround, which is why the defect looked like an
   * operational quirk rather than a lifecycle gap.
   */
  describe('provisioning on the launch path', () => {
    it('asks for this subject’s mapping and signs in once it lands', async () => {
      const accounts = { provisionInstance: vi.fn(async () => undefined) };
      const { service, setAccount } = setup({ account: null, accounts });
      accounts.provisionInstance.mockImplementation(async () => {
        setAccount({ id: 'account-1', login: 'jdoe', secret_ref: 'secret-1', state: 'active' });
      });
      stubProduct(['login', 'login-post', 'app']);

      const outcome = await service.attempt(input);

      // One subject, not the instance: a launch must not pay for the other people on it.
      expect(accounts.provisionInstance).toHaveBeenCalledWith('instance-1', 'subject-1');
      expect(outcome.kind).toBe('relayed');
    });

    it('falls back to the product form when the pass produces no mapping', async () => {
      const accounts = { provisionInstance: vi.fn(async () => undefined) };
      const { service } = setup({ account: null, accounts });

      expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'no_mapping' });
    });

    it('does not ask twice for the same pair inside the window', async () => {
      const accounts = { provisionInstance: vi.fn(async () => undefined) };
      const { service } = setup({ account: null, accounts });

      await service.attempt(input);
      await service.attempt(input);

      // A double-click must not become two passes against the product's administrator credential.
      expect(accounts.provisionInstance).toHaveBeenCalledOnce();
    });

    it('is not attempted at all when no provisioning role is mounted', async () => {
      // The launch hop stays mountable without M24's provisioning half: it then behaves as before.
      const { service } = setup({ account: null });

      expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'no_mapping' });
    });

    it('logs a failed pass and leaves the launch to the product form', async () => {
      const accounts = {
        provisionInstance: vi.fn(async () => {
          throw new Error('the product is down');
        }),
      };
      const { service } = setup({ account: null, accounts });
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      expect(await service.attempt(input)).toEqual({ kind: 'skipped', reason: 'no_mapping' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('the launch could not provision subject-1 on instance-1'),
      );
      warn.mockRestore();
    });

    it('stops waiting at the deadline and leaves the pass running for the next launch', async () => {
      const accounts = { provisionInstance: vi.fn(() => new Promise(() => undefined)) };
      const { service } = setup({ account: null, accounts });
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        const pending = service.attempt(input);
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(pending).resolves.toEqual({ kind: 'skipped', reason: 'no_mapping' });
        expect(log).toHaveBeenCalledWith(
          expect.objectContaining({ entryKey: 'D09-01', deadlineMs: 10_000 }),
          expect.stringContaining('did not wait for provisioning'),
        );
      } finally {
        vi.useRealTimers();
        log.mockRestore();
      }
    });

    it('forgets attempts older than the window instead of growing the map forever', async () => {
      const accounts = { provisionInstance: vi.fn(async () => undefined) };
      const { service } = setup({ account: null, accounts });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
        await service.attempt(input);

        vi.setSystemTime(new Date('2026-11-01T00:01:01.000Z'));
        await service.attempt(input);

        // The second launch is outside the window, so it asks again.
        expect(accounts.provisionInstance).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * FR-2.6 — the launch card's word.
   *
   * `state` is the only channel through which a card can say "the platform intends to sign you in"
   * without leaking an operator's reason to an end user. All three answers have to be reachable,
   * including the one that refuses to promise a pass that cannot run.
   */
  describe('accountState', () => {
    const state = { instanceId: 'instance-1', subjectIdpId: 'subject-1' };

    it('answers unavailable without reading anything when the deployment switch is off', async () => {
      const { service, db } = setup({ allowRelay: false });

      await expect(service.accountState(state)).resolves.toBe('unavailable');
      expect(db.calls).toEqual([]);
    });

    it('answers unavailable when the instance has no route to launch', async () => {
      const { service } = setup({ noRoute: true });

      await expect(service.accountState(state)).resolves.toBe('unavailable');
    });

    it('answers unavailable for an entry the relay does not manage', async () => {
      const { service } = setup({ entryKeys: 'D07-01' });

      await expect(service.accountState(state)).resolves.toBe('unavailable');
    });

    it('answers preparing for an entitled subject the pass has not reached yet', async () => {
      const { service } = setup({ account: null });

      await expect(service.accountState(state)).resolves.toBe('preparing');
    });

    it('refuses to promise a pass for a product with no login adapter', async () => {
      const { service } = setup({ account: null, entryKey: 'D01-01', entryKeys: 'D01-01' });

      await expect(service.accountState(state)).resolves.toBe('unavailable');
    });

    it('refuses to promise a pass for an instance that is not serving', async () => {
      const { service } = setup({ account: null, instanceState: 'failed' });

      await expect(service.accountState(state)).resolves.toBe('unavailable');
    });

    it('answers ready for an active mapping', async () => {
      const { service } = setup();

      await expect(service.accountState(state)).resolves.toBe('ready');
    });

    it('answers preparing for a mapping the pass has not finished', async () => {
      const { service } = setup({
        account: { id: 'account-1', login: 'jdoe', secret_ref: 'secret-1', state: 'pending' },
      });

      await expect(service.accountState(state)).resolves.toBe('preparing');
    });

    it('answers unavailable for a mapping the platform will not sign in with', async () => {
      const { service } = setup({
        account: { id: 'account-1', login: 'jdoe', secret_ref: 'secret-1', state: 'failed' },
      });

      await expect(service.accountState(state)).resolves.toBe('unavailable');
    });
  });
});
