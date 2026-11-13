import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import type { MeSession } from '../../../../src/modules/m10-portal-bff/portal-bff.contract';
import { PostgresPortalBffService } from '../../../../src/modules/m10-portal-bff/portal-bff.service';
import { fakeDb, type Route, type Row } from '../../../support/fakes';

/**
 * The portal BFF projections and the two refusals around them.
 *
 * Three properties are asserted rather than the shape of the SQL: what the platform knows is only
 * ever reported as what it has *proven* (a registered identity client is not a login), a launch is
 * only recorded or ticketed for an instance the subject actually holds, and every projection has an
 * explicit answer for a missing row — the fallbacks in `textOf`/`urlOf` are the difference between
 * a tile and a blank card.
 *
 * The service is instantiated directly: the Nest decorators are metadata, and every collaborator is
 * a `vi.fn()`, so a test states which statement it answered and which dependency it stubbed.
 */

const SUB = 'admin-1';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const SYNCED_AT = new Date('2026-03-01T10:00:00.000Z');
const SYNCED_ISO = '2026-03-01T10:00:00.000Z';

/** The development edge: plain HTTP on 8020, products under `*.localhost`. */
const CONFIG = {
  SEAMNEX_PRODUCT_URL_SCHEME: 'http',
  SEAMNEX_PRODUCT_URL_PORT: '8020',
  SEAMNEX_INGRESS_DOMAIN: 'localhost',
  SEAMNEX_SSO_EVIDENCE_TTL_MINUTES: 60,
  LAUNCH_TICKET_TTL_SECONDS: 60,
} as AppConfig;

/** Production: TLS terminated by the edge, so the URL carries no port. */
const EDGE_CONFIG = {
  SEAMNEX_PRODUCT_URL_SCHEME: 'https',
  SEAMNEX_PRODUCT_URL_PORT: '',
  SEAMNEX_INGRESS_DOMAIN: 'seamnex.local',
  SEAMNEX_SSO_EVIDENCE_TTL_MINUTES: 60,
  LAUNCH_TICKET_TTL_SECONDS: 30,
} as AppConfig;

/** A stack that never set the evidence window: the documented 60-minute default has to apply. */
const NO_WINDOW_CONFIG = {
  SEAMNEX_PRODUCT_URL_SCHEME: 'https',
  SEAMNEX_PRODUCT_URL_PORT: '',
  SEAMNEX_INGRESS_DOMAIN: 'seamnex.local',
  LAUNCH_TICKET_TTL_SECONDS: 30,
} as AppConfig;

const FRESH = new Date(Date.now() - 60_000);
const STALE = new Date(Date.now() - 3 * 60 * 60 * 1_000);

const SESSION: MeSession = {
  roles: ['R3'],
  mfaSatisfied: true,
  mfaMethod: 'totp',
  sessionExpiresAt: '2026-03-01T12:00:00.000Z',
  groups: ['/core'],
};

/** One row of the launcher projection, with every column the query selects. */
function tileRow(overrides: Row = {}): Row {
  return {
    instance_id: INSTANCE_ID,
    entry_key: 'D06-01',
    slug: 'erpnext',
    product_role: 'member',
    source: 'direct',
    sync_state: 'applied',
    synced_at: SYNCED_AT,
    state: 'ready',
    ready: true,
    reason: null,
    observed_at: SYNCED_AT,
    payload: { domain: 'ERP', product: 'ERPNext', description: 'One data model for the business.' },
    entry_payload: {
      domain: 'ERP',
      product: 'ERPNext',
      description: 'One data model for the business.',
    },
    guarantee_class: 'native',
    host: 'erpnext.localhost',
    path_prefix: null,
    published: true,
    auth_mode: 'native',
    maintenance_title: null,
    idp_client_id: null,
    sso_ok: null,
    sso_detail: null,
    sso_checked_at: null,
    deployed_version: 'v16.53.0',
    entry_version: '16.53.0',
    latest_version: '16.53.0',
    ...overrides,
  };
}

type Options = {
  readonly rows?: readonly Row[];
  readonly config?: AppConfig;
  readonly grants?: readonly Row[];
  readonly user?: Row;
  readonly windows?: readonly Row[];
  readonly catalog?: readonly Row[];
  /** Extra statements a test needs answered, tried before the projection routes. */
  readonly routes?: readonly Route[];
};

function setup(options: Options = {}) {
  const routes: Route[] = [
    ...(options.routes ?? []),
    ['FROM idp_user WHERE idp_id', options.user === undefined ? [] : [{ ...options.user }]],
    // Both projections read the same statement; a test answers it with the rows it wants projected.
    ['SELECT DISTINCT ON (i.id)', [...(options.rows ?? [])]],
    ['FROM maintenance_window', [...(options.windows ?? [])]],
    ['FROM catalog_entry c', [...(options.catalog ?? [])]],
  ];
  const db = fakeDb(routes);
  const access = { grantsFor: vi.fn(async () => options.grants ?? []) };
  const tickets = new Map<string, string>();
  const redis = {
    tickets,
    set: vi.fn(async (key: string, value: string, _mode: string, _ttl: number) => {
      tickets.set(key, value);
      return 'OK';
    }),
  };
  const audit = { append: vi.fn(async () => ({ seq: '1', hash: 'h' })) };
  const service = new PostgresPortalBffService(
    db.pool,
    options.config ?? CONFIG,
    access as never,
    redis as never,
    audit as never,
  );
  return { db, access, redis, audit, service };
}

/** The single tile a launcher response must project for one row. */
async function launcherTile(overrides: Row = {}, options: Omit<Options, 'rows'> = {}) {
  const { service } = setup({ ...options, rows: [tileRow(overrides)] });
  const response = await service.launcher(SUB);
  const [tile] = response.tiles;
  if (tile === undefined) throw new Error('no tile projected');
  return tile;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('grantDirectEntitlement', () => {
  it('grants the direct entitlement in the caller’s transaction, idempotently', async () => {
    const { service } = setup();
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));

    await service.grantDirectEntitlement({ query } as never, {
      subjectIdpId: SUB,
      target: 'erpnext',
    });

    // The grant commits with the decision that caused it, and a repeated approval is a no-op.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO entitlement'), [
      SUB,
      'erpnext',
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (subject_idp_id, instance_id, product_role)'),
      expect.any(Array),
    );
  });
});

describe('grantInstanceOwner', () => {
  it('grants the deploying subject owner access on its own connection', async () => {
    const { db, service } = setup({
      routes: [['INSERT INTO entitlement', { rows: [], rowCount: 1 }]],
    });

    await expect(service.grantInstanceOwner(INSTANCE_ID, SUB)).resolves.toBe(true);

    // The caller has no transaction open, so the statement runs on the pool and targets the instance
    // by id: a slug can be re-used, the id cannot.
    expect(db.calls[0]?.sql).toContain('INSERT INTO entitlement');
    expect(db.calls[0]?.params).toEqual([INSTANCE_ID, SUB]);
    expect(db.calls[0]?.sql).toContain("'Owner', 'direct', 'applied'");
  });

  it('reports success for a repeat grant instead of a failure', async () => {
    const { db, service } = setup({
      routes: [
        ['INSERT INTO entitlement', { rows: [], rowCount: 0 }],
        ['SELECT id FROM instance', [{ id: INSTANCE_ID }]],
      ],
    });

    await expect(service.grantInstanceOwner(INSTANCE_ID, SUB)).resolves.toBe(true);
    // The instance exists, so the conflict was the idempotent no-op, not a lost grant.
    expect(db.calls.some((call) => call.sql.includes('SELECT id FROM instance'))).toBe(true);
  });

  it('reports a miss when there is no live instance to grant on', async () => {
    const { service } = setup({
      routes: [
        ['INSERT INTO entitlement', { rows: [], rowCount: 0 }],
        ['SELECT id FROM instance', []],
      ],
    });

    await expect(service.grantInstanceOwner(INSTANCE_ID, SUB)).resolves.toBe(false);
  });
});

describe('me', () => {
  it('reports the durable binding over the role the provider asserted', async () => {
    const { access, service } = setup({
      user: {
        idp_id: SUB,
        username: 'dev-admin',
        display_name: 'Platform Administrator',
        email: 'admin@seamnex.test',
        updated_at: new Date('2026-02-01T00:00:00.000Z'),
      },
      grants: [
        {
          role: 'R2',
          scopeType: 'domain',
          scopeId: 'domain-1',
          expiresAt: '2026-12-01T00:00:00.000Z',
        },
      ],
    });

    const me = await service.me(SUB, SESSION);

    expect(access.grantsFor).toHaveBeenCalledWith(SUB);
    expect(me).toMatchObject({
      id: SUB,
      username: 'dev-admin',
      displayName: 'Platform Administrator',
      email: 'admin@seamnex.test',
      initials: 'PA',
      primaryRole: 'R2',
      mfaSatisfied: true,
      mfaMethod: 'totp',
      sessionExpiresAt: '2026-03-01T12:00:00.000Z',
      identitySyncedAt: '2026-02-01T00:00:00.000Z',
      groups: ['/core'],
    });
    expect(me.roles).toEqual([
      {
        role: 'R2',
        scopeType: 'domain',
        scopeId: 'domain-1',
        scopeLabel: 'domain-1',
        source: 'role_binding',
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
    ]);
  });

  it('projects the session roles when no binding exists', async () => {
    const { service } = setup();

    const me = await service.me(SUB, { ...SESSION, roles: ['R4'] });

    expect(me.primaryRole).toBe('R4');
    expect(me.roles).toEqual([
      {
        role: 'R4',
        scopeType: 'platform',
        scopeId: null,
        scopeLabel: 'Platform',
        source: 'session',
        expiresAt: null,
      },
    ]);
    // No mirror row: the subject id is the only name the platform holds, and it is not invented.
    expect(me).toMatchObject({
      username: SUB,
      displayName: SUB,
      email: `${SUB}@seamnex.local`,
      initials: 'A1',
    });
    expect(Date.parse(me.identitySyncedAt)).not.toBeNaN();
  });

  it('falls back to the lowest role when neither the bindings nor the session name one', async () => {
    const { service } = setup();

    const me = await service.me(SUB, { ...SESSION, roles: [] });

    expect(me.primaryRole).toBe('R5');
    expect(me.roles).toEqual([]);
  });

  it('labels a binding by its scope, and falls back to the scope type', async () => {
    const { service } = setup({
      user: {
        idp_id: SUB,
        username: 'dev-admin',
        display_name: null,
        email: null,
        updated_at: new Date('2026-02-01T00:00:00.000Z'),
      },
      grants: [
        { role: 'R1', scopeType: 'platform', scopeId: null, expiresAt: null },
        { role: 'R5', scopeType: 'instance', scopeId: null, expiresAt: null },
      ],
    });

    const me = await service.me(SUB, SESSION);

    // The login name is the fallback for a directory that carries no display name.
    expect(me.displayName).toBe('dev-admin');
    expect(me.initials).toBe('DA');
    expect(me.email).toBe(`${SUB}@seamnex.local`);
    expect(me.roles.map((grant) => grant.scopeLabel)).toEqual(['Platform', 'instance']);
  });
});

describe('entitlements', () => {
  it('projects one row per instance with the sign-in label in force', async () => {
    const { service } = setup({
      rows: [
        tileRow({
          instance_id: 'i-1',
          entry_key: 'D06-01',
          slug: 'erpnext',
          source: 'group',
          entry_payload: { domain: 'ERP', product: 'ERPNext' },
          payload: { domain: 'ERP', product: 'ERPNext' },
          guarantee_class: 'fa_header',
          auth_mode: 'fa_header',
        }),
        // Published nowhere yet, but the sync is still pending: it must not be launchable.
        tileRow({
          instance_id: 'i-2',
          entry_key: 'D01-01',
          slug: 'espocrm',
          source: 'direct',
          sync_state: 'pending',
          published: false,
          guarantee_class: null,
          auth_mode: null,
          idp_client_id: null,
          entry_payload: {},
          payload: {},
        }),
        tileRow({
          instance_id: 'i-3',
          entry_key: 'D09-01',
          slug: 'openproject',
          source: 'direct',
          ready: null,
          guarantee_class: 'fa_gate',
          auth_mode: 'fa_gate',
          entry_payload: { domain: 'Projects', product: 'OpenProject' },
          payload: {},
        }),
      ],
    });

    const response = await service.entitlements(SUB);

    expect(response.subject).toEqual({ id: SUB, name: SUB });
    expect(response.entitlements).toEqual([
      {
        instanceId: 'i-1',
        entryKey: 'D06-01',
        domain: 'ERP',
        product: 'ERPNext',
        slug: 'erpnext',
        productRole: 'member',
        source: 'group',
        groupPath: '/erp',
        syncState: 'applied',
        syncedAt: SYNCED_ISO,
        launchable: true,
        authLabel: 'Header SSO',
      },
      {
        instanceId: 'i-2',
        entryKey: 'D01-01',
        domain: 'Platform',
        product: 'D01-01',
        slug: 'espocrm',
        productRole: 'member',
        source: 'direct',
        groupPath: 'Direct grant',
        syncState: 'pending',
        syncedAt: SYNCED_ISO,
        launchable: false,
        authLabel: 'Sign-in required',
      },
      {
        instanceId: 'i-3',
        entryKey: 'D09-01',
        domain: 'Projects',
        product: 'OpenProject',
        slug: 'openproject',
        productRole: 'member',
        source: 'direct',
        groupPath: 'Direct grant',
        syncState: 'applied',
        syncedAt: SYNCED_ISO,
        launchable: false,
        authLabel: 'Sign-in required',
      },
    ]);
    expect(response.summary).toEqual({ total: 3, domains: 3, pending: 1, signInRequired: 2 });
  });

  it('reports an empty projection for a subject with no entitlement', async () => {
    const { service } = setup();

    await expect(service.entitlements(SUB)).resolves.toMatchObject({
      entitlements: [],
      summary: { total: 0, domains: 0, pending: 0, signInRequired: 0 },
    });
  });
});

describe('launcher', () => {
  const STATUS_ROWS: readonly Row[] = [
    tileRow({ instance_id: 'i-maint', maintenance_title: 'Maintenance in progress' }),
    tileRow({ instance_id: 'i-up' }),
    tileRow({ instance_id: 'i-unpublished', published: false }),
    tileRow({
      instance_id: 'i-degraded',
      ready: false,
      state: 'degraded',
      reason: 'health check failing',
    }),
    tileRow({
      instance_id: 'i-down',
      ready: false,
      state: 'stopped',
      sync_state: 'pending',
      observed_at: null,
    }),
  ];

  it('counts each plain status, maintenance winning over the health state', async () => {
    const { service } = setup({ rows: STATUS_ROWS });

    const response = await service.launcher(SUB);

    expect(response.tiles.map((tile) => tile.plainStatus)).toEqual([
      'maintenance',
      'available',
      'available',
      'degraded',
      'unavailable',
    ]);
    expect(response.counts).toEqual({
      total: 5,
      available: 2,
      degraded: 1,
      unavailable: 1,
      maintenance: 1,
    });
  });

  it('refuses to launch a maintenance, degraded or unpublished tile', async () => {
    const { service } = setup({ rows: STATUS_ROWS });

    const [maintenance, up, unpublished, degraded, down] = (await service.launcher(SUB)).tiles;

    expect(maintenance).toMatchObject({
      launchable: false,
      maintenanceTitle: 'Maintenance in progress',
      degradedReason: null,
      badge: null,
    });
    expect(up).toMatchObject({ launchable: true, degradedReason: null, badge: null });
    expect(unpublished).toMatchObject({ plainStatus: 'available', launchable: false });
    expect(degraded).toMatchObject({
      launchable: false,
      degradedReason: 'health check failing',
      maintenanceTitle: null,
    });
    // A stopped instance keeps no observation: the last sync is the newest fact available.
    expect(down).toMatchObject({
      launchable: false,
      degradedReason: null,
      badge: 'Sync pending',
      lastVerifiedAt: SYNCED_ISO,
    });
  });

  it('prints the environment name the stack declares', async () => {
    vi.stubEnv('SEAMNEX_ENVIRONMENT_NAME', 'seamnex-ci');

    const { service } = setup({ rows: [tileRow()] });

    await expect(service.launcher(SUB)).resolves.toMatchObject({ environment: 'seamnex-ci' });
  });

  it('falls back to the local environment name', async () => {
    vi.stubEnv('SEAMNEX_ENVIRONMENT_NAME', undefined);

    const { service } = setup({ rows: [tileRow()] });

    await expect(service.launcher(SUB)).resolves.toMatchObject({ environment: 'seamnex-local' });
  });

  it.each([
    [
      'the reviewed catalog document',
      { entry_payload: { product: 'Catalog name' }, payload: { product: 'Snapshot name' } },
      'Catalog name',
    ],
    [
      'the instance snapshot when the catalog field is blank',
      { entry_payload: { product: '' }, payload: { product: 'Snapshot name' } },
      'Snapshot name',
    ],
    [
      'the instance snapshot when the entry has no payload at all',
      { entry_payload: null, payload: { product: 'Snapshot name' } },
      'Snapshot name',
    ],
    ['the entry key when neither carries a name', { entry_payload: {}, payload: null }, 'D06-01'],
    [
      'the entry key when the values are not text',
      { entry_payload: { product: 42 }, payload: { product: ['x'] } },
      'D06-01',
    ],
  ] as ReadonlyArray<readonly [string, Row, string]>)(
    'names the product from %s',
    async (_description, overrides, expected) => {
      const tile = await launcherTile(overrides);

      expect(tile.product).toBe(expected);
    },
  );

  it('reports the running image tag and advertises only a strictly newer catalog version', async () => {
    const tile = await launcherTile({
      deployed_version: 'v16.53.0',
      entry_version: '16.53.0',
      latest_version: '16.54.0',
    });

    expect(tile.version).toBe('16.53.0');
    expect(tile.availableVersion).toBe('16.54.0');
  });

  it('falls back to the catalog pin when the instance keeps no service row', async () => {
    const tile = await launcherTile({
      deployed_version: null,
      entry_version: '16.53.0',
      latest_version: '16.53.0',
    });

    expect(tile.version).toBe('16.53.0');
    expect(tile.availableVersion).toBeNull();
  });

  it('reports no version at all when neither the deployment nor the catalog names one', async () => {
    const tile = await launcherTile({
      deployed_version: null,
      entry_version: null,
      latest_version: '16.53.0',
    });

    expect(tile.version).toBeNull();
    expect(tile.availableVersion).toBeNull();
  });

  it('defaults an instance with no declared guarantee class to native', async () => {
    const tile = await launcherTile({ guarantee_class: null, auth_mode: null });

    expect(tile.guaranteeClass).toBe('native');
    expect(tile.ssoState).toBe('sign_in_required');
    expect(tile.authLabel).toBe('Sign-in required');
  });

  it.each([
    [
      'a forward-auth header route',
      { auth_mode: 'fa_header', guarantee_class: 'fa_header' },
      'sso',
      'Header SSO',
    ],
    [
      'a delegated forward-auth route',
      { auth_mode: 'fa_delegated', guarantee_class: 'fa_delegated' },
      'sso',
      'Delegated SSO',
    ],
    [
      // The gate has a registered client and a passing check, and still asks for a product login.
      'a proxy gate holding a leftover client',
      {
        auth_mode: 'fa_gate',
        guarantee_class: 'fa_gate',
        idp_client_id: 'seamnex-openproject',
        sso_ok: true,
        sso_checked_at: FRESH,
      },
      'sign_in_required',
      'Sign-in required',
    ],
    [
      'a native route with no identity client',
      { auth_mode: 'native', idp_client_id: null },
      'sign_in_required',
      'Sign-in required',
    ],
    [
      'a native route whose check passed inside the window',
      {
        auth_mode: 'native',
        idp_client_id: 'seamnex-espocrm',
        sso_ok: true,
        sso_checked_at: FRESH,
        sso_detail: 'ok',
      },
      'sso',
      'Native SSO',
    ],
    [
      'a native route whose check failed',
      {
        auth_mode: 'native',
        idp_client_id: 'seamnex-espocrm',
        sso_ok: false,
        sso_checked_at: FRESH,
        sso_detail: 'token request error',
      },
      'sso_unverified',
      'SSO unverified',
    ],
    [
      'a native route whose passing check is stale',
      {
        auth_mode: 'native',
        idp_client_id: 'seamnex-espocrm',
        sso_ok: true,
        sso_checked_at: STALE,
      },
      'sso_unverified',
      'SSO unverified',
    ],
    [
      'a native route never checked',
      { auth_mode: 'native', idp_client_id: 'seamnex-espocrm', sso_ok: null, sso_checked_at: null },
      'sso_unverified',
      'SSO unverified',
    ],
  ] as ReadonlyArray<readonly [string, Row, string, string]>)(
    'states the sign-in posture of %s',
    async (_description, overrides, state, label) => {
      const tile = await launcherTile(overrides);

      expect(tile.ssoState).toBe(state);
      expect(tile.authLabel).toBe(label);
    },
  );

  it.each([
    [
      'nothing has ever run',
      { sso_checked_at: null, sso_ok: null, sso_detail: null },
      { checked: false, ok: false, checkedAt: null, detail: '', reason: 'never_checked' },
    ],
    [
      'the last check failed',
      { sso_checked_at: FRESH, sso_ok: false, sso_detail: 'stage 0 failed' },
      {
        checked: true,
        ok: false,
        checkedAt: FRESH.toISOString(),
        detail: 'stage 0 failed',
        reason: 'failed',
      },
    ],
    [
      'the last check passed inside the window',
      { sso_checked_at: FRESH, sso_ok: true },
      { checked: true, ok: true, checkedAt: FRESH.toISOString(), detail: '', reason: 'ok' },
    ],
    [
      'the last passing check is older than the window',
      { sso_checked_at: STALE, sso_ok: true, sso_detail: 'ok' },
      {
        checked: true,
        ok: true,
        checkedAt: STALE.toISOString(),
        detail: 'ok',
        reason: 'stale',
      },
    ],
  ] as ReadonlyArray<readonly [string, Row, Row]>)(
    'reports the evidence behind the label when %s',
    async (_description, overrides, expected) => {
      const tile = await launcherTile(overrides);

      expect(tile.ssoHealth).toEqual(expected);
    },
  );

  it('uses the documented evidence window when the stack declares none', async () => {
    const checkedAt = new Date(Date.now() - 30 * 60_000);

    const tile = await launcherTile(
      {
        auth_mode: 'native',
        idp_client_id: 'seamnex-espocrm',
        sso_ok: true,
        sso_checked_at: checkedAt,
      },
      { config: NO_WINDOW_CONFIG },
    );

    expect(tile.ssoHealth.reason).toBe('ok');
    expect(tile.ssoState).toBe('sso');
  });

  it.each([
    [
      'the route host and the configured edge port',
      CONFIG,
      { host: 'erpnext.localhost', path_prefix: null },
      'http://erpnext.localhost:8020',
    ],
    [
      'the ingress domain when the route names no host',
      CONFIG,
      { host: null },
      'http://erpnext.localhost:8020',
    ],
    [
      'no port when the edge serves its default',
      EDGE_CONFIG,
      { host: null, slug: 'shop' },
      'https://shop.seamnex.local',
    ],
    [
      'the route path prefix',
      EDGE_CONFIG,
      { host: 'shop.seamnex.local', path_prefix: '/erp' },
      'https://shop.seamnex.local/erp',
    ],
  ] as ReadonlyArray<readonly [string, AppConfig, Row, string]>)(
    'builds the launch URL from %s',
    async (_description, config, overrides, expected) => {
      const tile = await launcherTile(overrides, { config });

      expect(tile.url).toBe(expected);
    },
  );
});

describe('launchTarget', () => {
  it('refuses an id that is not a uuid before reading anything', async () => {
    const { db, service } = setup();

    await expect(service.launchTarget(SUB, 'erpnext')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: undefined,
      detail: 'No instance erpnext.',
      remediation: 'Refresh the launcher.',
    });
    expect(db.calls).toEqual([]);
  });

  it('refuses an instance the subject holds no entitlement for', async () => {
    const { service } = setup({ rows: [tileRow()] });

    await expect(service.launchTarget(SUB, OTHER_ID)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: undefined,
      detail: 'The subject holds no entitlement for this instance.',
      remediation: 'Request access to the product.',
    });
  });

  it.each([
    [
      'a forward-auth header route',
      { auth_mode: 'fa_header', guarantee_class: 'fa_header' },
      true,
      'sso',
      /forwards the authenticated session at the edge/,
    ],
    [
      'a proxy gate',
      { entry_key: 'D09-01', auth_mode: 'fa_gate', guarantee_class: 'fa_gate' },
      true,
      'sign_in_required',
      // ADR-BE-22: the relay removes the second password prompt, not the label. The tile keeps
      // saying "Sign-in required" because a relayed password is not single sign-on.
      /does not ask for a second password/,
    ],
    [
      // The deployed row carries the composed key (ADR-BE-20), not the legacy one the table above
      // uses. This case is the one that failed in the browser: the override was unreachable, so the
      // dialog printed the pre-relay sentence.
      'a proxy gate addressed by its composed catalogue key',
      { entry_key: 'D09-01', auth_mode: 'fa_gate', guarantee_class: 'fa_gate' },
      true,
      'sign_in_required',
      /does not ask for a second password/,
    ],
    [
      'a native route with a registered client',
      {
        entry_key: 'D01-01',
        auth_mode: 'native',
        idp_client_id: 'seamnex-espocrm',
        sso_ok: true,
        sso_checked_at: FRESH,
      },
      false,
      'sso',
      /EspoCRM shows its own "Sign in" card first/,
    ],
    [
      'a native route with no identity client',
      { auth_mode: 'native', idp_client_id: null, guarantee_class: null, host: 'shop.localhost' },
      false,
      'sign_in_required',
      /has its own credential, provisioned outside the platform/,
    ],
  ] as ReadonlyArray<readonly [string, Row, boolean, string, RegExp]>)(
    'describes the sign-in path of %s',
    async (_description, overrides, bootstrapRequired, ssoState, note) => {
      const { service } = setup({ rows: [tileRow(overrides)] });

      const target = await service.launchTarget(SUB, INSTANCE_ID);

      expect(target).toMatchObject({
        instanceId: INSTANCE_ID,
        ssoState,
        bootstrapRequired,
        opensInNewTab: true,
        note: expect.stringMatching(note),
      });
      expect(target.authClass).toBe((overrides.guarantee_class as string | null) ?? 'native');
    },
  );
});

describe('launchTicket', () => {
  it('refuses to mint a ticket for a caller with no browser session', async () => {
    const { redis, service } = setup();

    await expect(service.launchTicket(SUB, INSTANCE_ID, null)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: undefined,
      detail: 'A launch ticket is minted for a browser session only.',
      remediation: 'Sign in through the portal and open the product from the launcher.',
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('refuses a ticket for an instance the subject holds no entitlement for', async () => {
    const { service } = setup({ rows: [tileRow()] });

    await expect(service.launchTicket(SUB, OTHER_ID, 'sess-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      detail: 'The subject holds no entitlement for this instance.',
    });
  });

  it.each([[null], ['native']] as ReadonlyArray<readonly [string | null]>)(
    'refuses a ticket for an ungated route (auth_mode %j)',
    async (authMode) => {
      const { redis, service } = setup({ rows: [tileRow({ auth_mode: authMode })] });

      await expect(service.launchTicket(SUB, INSTANCE_ID, 'sess-1')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        status: undefined,
        detail: 'This product is not gated at the edge; its plain URL needs no ticket.',
        remediation: 'Open the product from the launcher instead of requesting a ticket.',
      });
      expect(redis.set).not.toHaveBeenCalled();
    },
  );

  it('mints a single-use ticket bound to the session and the instance', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-01T09:00:00.000Z') });
    const { redis, service } = setup({
      rows: [tileRow({ auth_mode: 'fa_header', guarantee_class: 'fa_header' })],
    });

    const ticket = await service.launchTicket(SUB, INSTANCE_ID, 'sess-1');

    // The ticket only carries a session id the browser already holds, and expires in a minute.
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^seamnex:launch:[A-Za-z0-9_-]{32}$/),
      JSON.stringify({ sessionId: 'sess-1', instanceId: INSTANCE_ID }),
      'EX',
      60,
    );
    const [key] = [...redis.tickets.keys()];
    if (key === undefined) throw new Error('no ticket stored');
    const value = key.slice('seamnex:launch:'.length);
    expect(ticket.url).toBe(
      `http://erpnext.localhost:8020/__seamnex/session?ticket=${encodeURIComponent(value)}`,
    );
    expect(ticket.expiresAt).toBe('2026-05-01T09:01:00.000Z');
  });
});

describe('recordLaunch', () => {
  it('refuses an id that is not a uuid', async () => {
    const { audit, service } = setup();

    await expect(service.recordLaunch(SUB, 'not-a-uuid')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No instance not-a-uuid.',
    });
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses an instance the subject holds no entitlement for', async () => {
    const { audit, service } = setup({ rows: [tileRow()] });

    await expect(service.recordLaunch(SUB, OTHER_ID)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      detail: 'The subject holds no entitlement for this instance.',
    });
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('records the click with the sign-in shape in force at that moment', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-01T09:00:00.000Z') });
    const { audit, service } = setup({
      rows: [
        tileRow({
          entry_key: 'D09-01',
          slug: 'openproject',
          auth_mode: 'fa_gate',
          guarantee_class: 'fa_gate',
          sso_ok: true,
          sso_checked_at: FRESH,
        }),
      ],
    });

    const event = await service.recordLaunch(SUB, INSTANCE_ID);

    expect(event).toEqual({
      instanceId: INSTANCE_ID,
      recordedAt: '2026-05-01T09:00:00.000Z',
      ssoState: 'sign_in_required',
    });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'portal.launch.requested',
      actorType: 'user',
      actorId: SUB,
      targetType: 'instance',
      targetId: INSTANCE_ID,
      outcome: 'success',
      detail: {
        entryKey: 'D09-01',
        slug: 'openproject',
        ssoState: 'sign_in_required',
        ssoOk: true,
      },
    });
  });
});

describe('product', () => {
  it('projects the requested slug', async () => {
    const { service } = setup({
      rows: [tileRow(), tileRow({ instance_id: OTHER_ID, entry_key: 'D01-01', slug: 'espocrm' })],
    });

    await expect(service.product(SUB, 'espocrm')).resolves.toMatchObject({
      instanceId: OTHER_ID,
      entryKey: 'D01-01',
      slug: 'espocrm',
    });
  });

  it('refuses a product the subject cannot see', async () => {
    const { service } = setup({ rows: [tileRow()] });

    await expect(service.product(SUB, 'github')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: undefined,
      detail: 'No product github is visible to this subject.',
      remediation: 'Refresh the launcher; unentitled products are not listed.',
    });
  });
});

describe('requestable', () => {
  it('offers the catalog entries the subject holds no deployment of', async () => {
    const { db, service } = setup({
      catalog: [
        {
          key: 'D06-01',
          domain: 'ERP',
          product: 'ERPNext',
          guarantee_class: 'native',
          payload: { description: 'One data model for the business.', owner: { name: 'Ops' } },
          requested_at: new Date('2026-01-02T00:00:00.000Z'),
        },
        {
          key: 'D01-01',
          domain: 'CRM',
          product: 'EspoCRM',
          guarantee_class: 'fa_header',
          payload: {},
          // No open access request: the column is selected and comes back null.
          requested_at: null,
        },
        {
          key: 'D09-01',
          domain: 'Projects',
          product: 'OpenProject',
          guarantee_class: 'fa_gate',
          payload: { owner: {} },
          requested_at: null,
        },
      ],
    });

    const products = await service.requestable(SUB);

    expect(products).toEqual([
      {
        entryKey: 'D06-01',
        domain: 'ERP',
        product: 'ERPNext',
        description: 'One data model for the business.',
        guaranteeClass: 'native',
        productRole: 'member',
        owner: 'Ops',
        requested: true,
        requestedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        entryKey: 'D01-01',
        domain: 'CRM',
        product: 'EspoCRM',
        description: 'EspoCRM in CRM.',
        guaranteeClass: 'fa_header',
        productRole: 'member',
        owner: 'CRM',
        requested: false,
        requestedAt: null,
      },
      {
        entryKey: 'D09-01',
        domain: 'Projects',
        product: 'OpenProject',
        description: 'OpenProject in Projects.',
        guaranteeClass: 'fa_gate',
        productRole: 'member',
        owner: 'Projects',
        requested: false,
        requestedAt: null,
      },
    ]);
    const statement = db.calls[0];
    expect(statement?.sql).toContain('NOT EXISTS');
    expect(statement?.params).toEqual([SUB]);
  });

  it('offers nothing when the subject already holds every entry', async () => {
    const { service } = setup({ catalog: [] });

    await expect(service.requestable(SUB)).resolves.toEqual([]);
  });
});

describe('statusBanner', () => {
  it('reports the active window as a warning banner', async () => {
    const { service } = setup({
      windows: [
        {
          id: 'w-1',
          scope: 'platform',
          starts_at: new Date('2026-05-01T08:00:00.000Z'),
          ends_at: new Date('2026-05-01T10:00:00.000Z'),
          created_at: new Date('2026-04-30T08:00:00.000Z'),
        },
      ],
    });

    await expect(service.statusBanner()).resolves.toEqual({
      id: 'w-1',
      severity: 'warning',
      title: 'Maintenance in progress',
      message: 'A maintenance window ends at 2026-05-01T10:00:00.000Z.',
      active: true,
      updatedAt: '2026-04-30T08:00:00.000Z',
      windowId: 'w-1',
    });
  });

  it('reports no banner when no window is active', async () => {
    const { service } = setup();

    await expect(service.statusBanner()).resolves.toBeNull();
  });
});
