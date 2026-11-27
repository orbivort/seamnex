import { describe, expect, it, vi } from 'vitest';

import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { AppError } from '../../../../src/common/problem/app-error';
import {
  PostgresIntegrationService,
  adapterFor,
} from '../../../../src/modules/m07-integration/integration.service';
import type { RouteInput } from '../../../../src/modules/m07-integration/integration.contract';

/**
 * M07 owns three claims an operator reads as facts: the route that publishes a product, the
 * identity client that signs a person in, and the five checks `ready` is derived from. Each test
 * below pins one of the ways those claims can be wrong — a route whose auth mode contradicts the
 * catalog, a client registered with a secret the product never receives, a check that reports
 * "single sign-on" for a product the IdP cannot be reached from, and an SSO failure that blocks a
 * `native` deployment it has nothing to do with.
 */
const CRM = '11111111-1111-4111-8111-111111111111';
const ACTOR = '99999999-9999-4999-8999-999999999999';

type Mock = ReturnType<typeof vi.fn>;

const CONFIG = {
  SEAMNEX_PRODUCT_URL_SCHEME: 'http',
  SEAMNEX_PRODUCT_URL_PORT: '8020',
  SEAMNEX_IDP_ALIAS: 'keycloak',
  SEAMNEX_IDP_CONTAINER: 'seamnex-idp',
  SEAMNEX_IDP_INTERNAL_PORT: 8080,
  SEAMNEX_KEYCLOAK_REALM: 'seamnex',
  // Presence of this path is what distinguishes "no IdP admin client on this host" (a deployment
  // may proceed) from "the IdP refused" (a deployment must fail) — see `registerIdentity`.
  SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '/run/seamnex/kc-admin-client-secret',
  SEAMNEX_SSO_EVIDENCE_TTL_MINUTES: 60,
  SEAMNEX_INGRESS_DOMAIN: 'seamnex.local',
  SEAMNEX_EDGE_CONTAINER: 'seamnex-edge',
  // NFR-4.1 / ISSUE-07: the certificate mode the deployment's edge runs, projected onto each route.
  SEAMNEX_EDGE_TLS_MODE: 'acme',
  // ADR-BE-22: one deployment-wide bootstrap origin; the relay role is a different value here.
  SEAMNEX_BOOTSTRAP_URL: 'http://auth-gateway:8090',
};

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return { ...CONFIG, ...overrides } as unknown as AppConfig;
}

function auditFake(overrides: Record<string, unknown> = {}): { append: Mock; lockChain: Mock } {
  return Object.assign(
    {
      append: vi.fn(async (): Promise<{ seq: string; hash: string }> => ({ seq: '1', hash: 'h' })),
      lockChain: vi.fn(async (): Promise<void> => undefined),
    },
    overrides,
  ) as unknown as { append: Mock; lockChain: Mock };
}

function secretsFake(overrides: Record<string, unknown> = {}): {
  find: Mock;
  open: Mock;
  put: Mock;
  rotate: Mock;
  describe: Mock;
} {
  return Object.assign(
    {
      find: vi.fn(async (): Promise<{ id: string; name: string } | null> => null),
      open: vi.fn(async (): Promise<string> => 'operator-secret'),
      put: vi.fn(async (): Promise<{ id: string }> => ({ id: 'secret-generated' })),
      rotate: vi.fn(),
      describe: vi.fn(),
    },
    overrides,
  ) as unknown as { find: Mock; open: Mock; put: Mock; rotate: Mock; describe: Mock };
}

function dockerFake(overrides: Record<string, unknown> = {}): {
  runCli: Mock;
  connectNetwork: Mock;
  containers: Mock;
  inspect: Mock;
  logs: Mock;
} {
  return Object.assign(
    {
      // The product probe prints a status line, the IdP probe prints `ANSWER …` and the sign-in page
      // probe prints `SIGNIN …`. One runner answers all three, by the marker the platform passes as a
      // positional argument.
      runCli: vi.fn(async (_file: string, args: readonly string[]) => {
        if (args.includes('seamnex-signin-probe'))
          return { code: 0, stdout: 'SIGNIN offered\n', stderr: '', truncated: false };
        if (args.includes('seamnex-idp-probe'))
          return { code: 0, stdout: 'ANSWER HTTP/1.1 200 OK\n', stderr: '', truncated: false };
        return { code: 0, stdout: 'HTTP 200\n', stderr: '', truncated: false };
      }),
      connectNetwork: vi.fn(async (): Promise<void> => undefined),
      containers: vi.fn(async (): Promise<unknown[]> => []),
      inspect: vi.fn(async (): Promise<unknown> => ({})),
      logs: vi.fn(async (): Promise<string> => ''),
    },
    overrides,
  ) as unknown as {
    runCli: Mock;
    connectNetwork: Mock;
    containers: Mock;
    inspect: Mock;
    logs: Mock;
  };
}

/**
 * M03 is where the client secret becomes real: the product reads it from `instance_env_value`, so
 * `ensureIdentitySecret` writes through the renderer and `ssoLogin` reads the same row. Both entries
 * that declare a secret variable are "applied" by default, so a test about something else is not
 * accidentally a test about an unapplied credential.
 */
function rendererFake(overrides: Record<string, unknown> = {}): {
  instanceEnv: Mock;
  updateInstanceEnv: Mock;
} {
  return Object.assign(
    {
      instanceEnv: vi.fn(async (): Promise<unknown[]> => [
        { name: 'ESPOCRM_CONFIG_OIDC_CLIENT_SECRET', source: 'secret', masked: true, value: null },
        { name: 'ERPNEXT_SSO_CLIENT_SECRET', source: 'secret', masked: true, value: null },
      ]),
      updateInstanceEnv: vi.fn(async (): Promise<unknown> => ({
        diff: [],
        requiresRecreate: false,
        applied: false,
        note: 'Stored.',
      })),
    },
    overrides,
  ) as unknown as { instanceEnv: Mock; updateInstanceEnv: Mock };
}

function keycloakFake(overrides: Record<string, unknown> = {}): {
  upsertClient: Mock;
  realmReachable: Mock;
  deleteClient: Mock;
} {
  return Object.assign(
    {
      upsertClient: vi.fn(async (spec: { clientId: string }) => ({
        clientId: spec.clientId,
        created: true,
      })),
      realmReachable: vi.fn(async (): Promise<boolean> => true),
      deleteClient: vi.fn(),
    },
    overrides,
  ) as unknown as { upsertClient: Mock; realmReachable: Mock; deleteClient: Mock };
}

function traefikFake(): { write: Mock; remove: Mock; prune: Mock } {
  return { write: vi.fn(), remove: vi.fn(), prune: vi.fn() };
}

function ssoProbeFake(overrides: Record<string, unknown> = {}): { verify: Mock } {
  return Object.assign(
    {
      verify: vi.fn(async (): Promise<{ ok: boolean; detail: string }> => ({
        ok: true,
        detail: 'stages 1–2 passed',
      })),
    },
    overrides,
  ) as unknown as { verify: Mock };
}

/**
 * Every key is allowed to be explicitly `undefined`: each consumer (`fakeDb`, `dockerFake`, …)
 * falls back to its own default, so a test that forwards an absent fixture is well-typed.
 */
type BuildOptions = {
  routes?: readonly Route[] | undefined;
  config?: Record<string, unknown> | undefined;
  audit?: Record<string, unknown> | undefined;
  secrets?: Record<string, unknown> | undefined;
  docker?: Record<string, unknown> | undefined;
  keycloak?: Record<string, unknown> | undefined;
  ssoProbe?: Record<string, unknown> | undefined;
  renderer?: Record<string, unknown> | undefined;
};

function build(options: BuildOptions = {}) {
  const db = fakeDb(options.routes ?? [], { allowUnmatched: false });
  const audit = auditFake(options.audit);
  const secrets = secretsFake(options.secrets);
  const docker = dockerFake(options.docker);
  const keycloak = keycloakFake(options.keycloak);
  const traefik = traefikFake();
  const ssoProbe = ssoProbeFake(options.ssoProbe);
  const renderer = rendererFake(options.renderer);
  const service = new PostgresIntegrationService(
    db.pool,
    config(options.config),
    audit as never,
    secrets as never,
    docker as never,
    keycloak as never,
    traefik as never,
    ssoProbe as never,
    renderer as never,
  );
  return { db, audit, secrets, docker, keycloak, traefik, ssoProbe, renderer, service };
}

function statement(db: ReturnType<typeof fakeDb>, fragment: string) {
  return db.calls.find((entry) => entry.sql.includes(fragment));
}

function statements(db: ReturnType<typeof fakeDb>, fragment: string) {
  return db.calls.filter((entry) => entry.sql.includes(fragment));
}

function instanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CRM,
    slug: 'crm',
    entry_key: 'D01-01',
    host: 'crm.seamnex.local',
    payload: { guaranteeClass: 'native', authMethod: 'oidc', httpPort: 8080 },
    ...overrides,
  };
}

function routeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: 'crm.seamnex.local',
    path_prefix: null,
    publish_model: 'subdomain',
    tls_mode: 'acme',
    auth_mode: 'native',
    published: true,
    gated: false,
    ...overrides,
  };
}

function clientRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: 'seamnex-crm',
    client_secret_ref: 'secret-1',
    redirect_uris: ['http://crm.seamnex.local:8020/oauth-callback.php'],
    protocol: 'oidc',
    access_token_lifespan_seconds: 300,
    offline_access_disabled: true,
    backchannel_logout_url: 'http://crm.seamnex.local:8020/api/v1/Oidc/action/backchannelLogout',
    ...overrides,
  };
}

function projectionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: 'crm.seamnex.local',
    path_prefix: null,
    publish_model: 'subdomain',
    published: true,
    gated: false,
    auth_mode: 'native',
    tls_mode: 'acme',
    slug: 'crm',
    payload: { httpPort: 8080 },
    ...overrides,
  };
}

/** Everything `ssoLogin` needs to reach the probe: a client row, a secret, and a reachable IdP. */
function ssoRoutes(
  overrides: {
    // Explicitly `undefined` means "use the default row", so it is part of the accepted input.
    client?: Record<string, unknown>[] | undefined;
    verdict?: { ok: boolean }[] | undefined;
  } = {},
): readonly Route[] {
  return [
    ['FROM idp_client WHERE instance_id', overrides.client ?? [clientRow()]],
    ['SELECT ok FROM integration_check', overrides.verdict ?? []],
  ];
}

describe('the adapter a guarantee class gets', () => {
  it.each([
    [
      'saml',
      'native',
      {
        adapter: 'saml',
        propagatesGroupRoles: true,
        revokesProductSessions: true,
        syncState: 'applied',
      },
    ],
    [
      'oidc',
      'fa_gate',
      {
        adapter: 'fa_header',
        propagatesGroupRoles: false,
        revokesProductSessions: false,
        syncState: 'unsupported',
      },
    ],
    [
      'oidc',
      'fa_delegated',
      {
        adapter: 'fa_delegated',
        propagatesGroupRoles: false,
        revokesProductSessions: false,
        syncState: 'unsupported',
      },
    ],
    [
      'oidc',
      'fa_header',
      {
        adapter: 'fa_header',
        propagatesGroupRoles: false,
        revokesProductSessions: true,
        syncState: 'applied',
      },
    ],
    [
      'oidc',
      'native',
      {
        adapter: 'oidc',
        propagatesGroupRoles: true,
        revokesProductSessions: true,
        syncState: 'applied',
      },
    ],
  ])('maps %s / %s onto %o', (authMethod, guaranteeClass, expected) => {
    expect(adapterFor(guaranteeClass, authMethod)).toEqual(expected);
  });
});

describe('reading the recorded integration state', () => {
  it('labels each check, and falls back to the stored name for one the platform does not know', async () => {
    const { service } = build({
      routes: [
        [
          'DISTINCT ON (check_type)',
          [
            {
              check_type: 'http',
              ok: true,
              detail: 'HTTP answered on :8080 (HTTP 200)',
              checked_at: new Date('2024-05-01T00:00:00.000Z'),
            },
            {
              check_type: 'custom_probe',
              ok: false,
              detail: null,
              checked_at: new Date('2024-05-01T00:01:00.000Z'),
            },
          ],
        ],
      ],
    });

    await expect(service.checks(CRM)).resolves.toEqual([
      {
        check: 'http',
        label: 'HTTP response',
        ok: true,
        detail: 'HTTP answered on :8080 (HTTP 200)',
        checkedAt: '2024-05-01T00:00:00.000Z',
      },
      {
        check: 'custom_probe',
        label: 'custom_probe',
        ok: false,
        detail: '',
        checkedAt: '2024-05-01T00:01:00.000Z',
      },
    ]);
  });

  it('returns no route for an instance that has never been published', async () => {
    const { service } = build({ routes: [['FROM instance_route WHERE instance_id', []]] });

    await expect(service.route(CRM)).resolves.toBeNull();
  });

  it.each([
    [
      'a published subdomain route',
      { path_prefix: null, published: true, gated: false },
      { pathPrefix: '/', published: true },
    ],
    [
      'a route published under a subpath',
      { path_prefix: '/app', published: true, gated: false },
      { pathPrefix: '/app', published: true },
    ],
    [
      'an unpublished route',
      { path_prefix: null, published: false, gated: false },
      { pathPrefix: '/', published: false },
    ],
    [
      'a route behind the platform gate',
      { path_prefix: null, published: true, gated: true },
      { pathPrefix: '/', published: false },
    ],
  ])('reports %s', async (_name, overrides, expected) => {
    const { service } = build({
      routes: [['FROM instance_route WHERE instance_id', [routeRow(overrides)]]],
    });

    await expect(service.route(CRM)).resolves.toMatchObject(expected);
  });

  it('returns no metadata for an instance that was never verified', async () => {
    const { service } = build({ routes: [['FROM integration_metadata', []]] });

    await expect(service.metadata(CRM)).resolves.toBeNull();
  });

  it('projects the verified facts with their review dates', async () => {
    const { service } = build({
      routes: [
        [
          'FROM integration_metadata',
          [
            {
              credential_granularity: 'scoped',
              session_max_minutes: 60,
              api_base_url: 'http://crm.seamnex.local:8020/api/v1',
              auth_method: 'oidc',
              guarantee_class_verified: 'native',
              operation_inventory: [{ name: 'contact.read' }],
              event_modes: ['webhook'],
              slo_supported: true,
              verified_by: ACTOR,
              verified_at: new Date('2024-05-01T00:00:00.000Z'),
              next_review_at: new Date('2024-11-01T00:00:00.000Z'),
            },
          ],
        ],
      ],
    });

    await expect(service.metadata(CRM)).resolves.toEqual({
      credentialGranularity: 'scoped',
      sessionMaxMinutes: 60,
      apiBaseUrl: 'http://crm.seamnex.local:8020/api/v1',
      authMethod: 'oidc',
      guaranteeClassVerified: 'native',
      operationInventory: [{ name: 'contact.read' }],
      eventModes: ['webhook'],
      sloSupported: true,
      // FR-2.10/AC-41: the projection says which facts were verified, so a consumer can tell a
      // measured value from a catalogue assumption without diffing two documents.
      verifiedFacts: [],
      verifiedBy: ACTOR,
      verifiedAt: '2024-05-01T00:00:00.000Z',
      nextReviewAt: '2024-11-01T00:00:00.000Z',
    });
  });

  it('reports a missing review date as absent rather than as an epoch', async () => {
    const { service } = build({
      routes: [
        [
          'FROM integration_metadata',
          [
            {
              credential_granularity: 'shared',
              session_max_minutes: null,
              api_base_url: null,
              auth_method: null,
              guarantee_class_verified: null,
              operation_inventory: null,
              event_modes: null,
              slo_supported: null,
              verified_by: null,
              verified_at: null,
              next_review_at: null,
            },
          ],
        ],
      ],
    });

    await expect(service.metadata(CRM)).resolves.toMatchObject({
      verifiedAt: null,
      nextReviewAt: null,
    });
  });
});

describe('applying the identity client secret', () => {
  it('has nothing to apply for an entry that declares no secret variable', async () => {
    const { renderer, service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow({ entry_key: 'D09-01' })]]],
    });

    await expect(service.ensureIdentitySecret(CRM, ACTOR)).resolves.toEqual({
      variable: null,
      status: 'not-declared',
    });
    expect(renderer.updateInstanceEnv).not.toHaveBeenCalled();
  });

  it('writes nothing for a variable the projected schema does not carry', async () => {
    const { renderer, service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow({ entry_key: 'D06-01' })]]],
      renderer: { instanceEnv: vi.fn(async () => []) },
    });

    await expect(service.ensureIdentitySecret(CRM, ACTOR)).resolves.toEqual({
      variable: 'ERPNEXT_SSO_CLIENT_SECRET',
      status: 'not-declared',
    });
    expect(renderer.updateInstanceEnv).not.toHaveBeenCalled();
  });

  it('leaves an applied secret alone, so a redeploy does not rotate it', async () => {
    const { renderer, secrets, service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow({ entry_key: 'D06-01' })]]],
    });

    await expect(service.ensureIdentitySecret(CRM, ACTOR)).resolves.toEqual({
      variable: 'ERPNEXT_SSO_CLIENT_SECRET',
      status: 'applied',
    });
    expect(renderer.updateInstanceEnv).not.toHaveBeenCalled();
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it('mints a secret when the instance holds none and applies it through M03', async () => {
    // The defect this closes: a value that only reaches M15 never reaches the container, because the
    // renderer and the executor resolve `instance_env_value` and nothing else.
    const { renderer, service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow({ entry_key: 'D06-01' })]]],
      renderer: {
        instanceEnv: vi.fn(async () => [{ name: 'ERPNEXT_SSO_CLIENT_SECRET', source: 'default' }]),
      },
    });

    await expect(service.ensureIdentitySecret(CRM, ACTOR)).resolves.toEqual({
      variable: 'ERPNEXT_SSO_CLIENT_SECRET',
      status: 'minted',
    });
    expect(renderer.updateInstanceEnv).toHaveBeenCalledWith(
      CRM,
      { ERPNEXT_SSO_CLIENT_SECRET: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ACTOR,
    );
  });

  it('links a secret M15 already holds instead of replacing the one the IdP was registered with', async () => {
    const { renderer, secrets, service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow({ entry_key: 'D06-01' })]]],
      renderer: {
        instanceEnv: vi.fn(async () => [{ name: 'ERPNEXT_SSO_CLIENT_SECRET', source: 'default' }]),
      },
      secrets: {
        find: vi.fn(async () => ({ id: 'secret-existing', name: 'ERPNEXT_SSO_CLIENT_SECRET' })),
        open: vi.fn(async () => 'already-registered-value'),
      },
    });

    await expect(service.ensureIdentitySecret(CRM, ACTOR)).resolves.toEqual({
      variable: 'ERPNEXT_SSO_CLIENT_SECRET',
      status: 'linked',
    });
    expect(secrets.open).toHaveBeenCalledWith('secret-existing', expect.stringContaining(CRM));
    expect(renderer.updateInstanceEnv).toHaveBeenCalledWith(
      CRM,
      { ERPNEXT_SSO_CLIENT_SECRET: 'already-registered-value' },
      ACTOR,
    );
  });
});

describe('registering the identity client', () => {
  it('refuses an instance that does not exist', async () => {
    const { service } = build({ routes: [['LEFT JOIN instance_route r', []]] });

    await expect(service.registerIdentity(CRM, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No instance ${CRM}.`,
    });
  });

  it('refuses a derived client id longer than Keycloak accepts', async () => {
    const { keycloak, service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow({ slug: 'a'.repeat(200) })]]],
    });

    await expect(service.registerIdentity(CRM, ACTOR)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
    expect(keycloak.upsertClient).not.toHaveBeenCalled();
  });

  it('registers the client with the redirect URI and back-channel endpoint the product declares', async () => {
    const { audit, db, keycloak, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['INSERT INTO idp_client', []],
      ],
      secrets: {
        find: vi.fn(async () => ({ id: 'secret-1', name: 'ESPOCRM_CONFIG_OIDC_CLIENT_SECRET' })),
        open: vi.fn(async () => 'operator-secret'),
      },
    });

    await expect(service.registerIdentity(CRM, ACTOR)).resolves.toEqual({
      clientId: 'seamnex-crm',
      adapter: {
        adapter: 'oidc',
        propagatesGroupRoles: true,
        revokesProductSessions: true,
        syncState: 'applied',
      },
    });

    expect(keycloak.upsertClient.mock.calls[0]?.[0]).toEqual({
      clientId: 'seamnex-crm',
      redirectUris: ['http://crm.seamnex.local:8020/oauth-callback.php'],
      protocol: 'oidc',
      accessTokenLifespanSeconds: 300,
      offlineAccessDisabled: true,
      secret: 'operator-secret',
      backchannelLogoutUrl: 'http://crm.seamnex.local:8020/api/v1/Oidc/action/backchannelLogout',
      groupClaim: 'groups',
    });
    // FR-3.8: the back-channel endpoint is recorded with the client, because sign-out can only
    // claim a product was notified when the provider has somewhere to notify it.
    expect(statement(db, 'INSERT INTO idp_client')?.params).toEqual([
      CRM,
      'seamnex-crm',
      'secret-1',
      'oidc',
      ['http://crm.seamnex.local:8020/oauth-callback.php'],
      'http://crm.seamnex.local:8020/api/v1/Oidc/action/backchannelLogout',
    ]);
    // Which value the client was registered with: the operator's own variable, not a generated one.
    expect(audit.append.mock.calls[0]?.[0]).toMatchObject({
      action: 'instance.idp_client.registered',
      detail: { clientId: 'seamnex-crm', secretSource: 'instance', created: true },
    });
  });

  it('generates a secret and stores it under the variable the product reads', async () => {
    const { audit, db, keycloak, secrets, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['INSERT INTO idp_client', []],
      ],
    });

    await service.registerIdentity(CRM, ACTOR);

    // The renderer resolves `instance_env_value` and nothing else: a secret parked in an
    // `idp_client` scope never reaches the container, and the product's login fails at the token
    // exchange with a value it does not have.
    expect(secrets.put.mock.calls[0]).toEqual([
      'instance',
      CRM,
      'ESPOCRM_CONFIG_OIDC_CLIENT_SECRET',
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(keycloak.upsertClient.mock.calls[0]?.[0]).toMatchObject({
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(statement(db, 'INSERT INTO idp_client')?.params[2]).toBe('secret-generated');
    expect(audit.append.mock.calls[0]?.[0]).toMatchObject({
      detail: { secretSource: 'generated' },
    });
  });

  it('falls back to the idp_client scope for an entry that declares no secret variable', async () => {
    const { keycloak, secrets, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow({ entry_key: 'D09-01' })]],
        ['INSERT INTO idp_client', []],
      ],
    });

    await service.registerIdentity(CRM, ACTOR);

    expect(secrets.find).not.toHaveBeenCalled();
    expect(secrets.put.mock.calls[0]?.slice(0, 3)).toEqual(['idp_client', CRM, 'client_secret']);
    // No back-channel endpoint and no required claim: registering either would be a claim the
    // product does not make.
    const spec = keycloak.upsertClient.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spec).not.toHaveProperty('backchannelLogoutUrl');
    expect(spec).not.toHaveProperty('groupClaim');
    expect(spec['protocol']).toBe('oidc');
  });

  it('treats a secret lookup that fails as one that found nothing', async () => {
    const { secrets, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['INSERT INTO idp_client', []],
      ],
      secrets: { find: vi.fn(async () => Promise.reject(new Error('store unavailable'))) },
    });

    await service.registerIdentity(CRM, ACTOR);

    expect(secrets.put).toHaveBeenCalled();
  });

  it('registers a SAML client on the assertion consumer endpoint', async () => {
    const { keycloak, service } = build({
      routes: [
        [
          'LEFT JOIN instance_route r',
          [instanceRow({ payload: { guaranteeClass: 'native', authMethod: 'saml' } })],
        ],
        ['INSERT INTO idp_client', []],
      ],
    });

    await expect(service.registerIdentity(CRM, ACTOR)).resolves.toMatchObject({
      adapter: { adapter: 'saml', propagatesGroupRoles: true },
    });
    expect(keycloak.upsertClient.mock.calls[0]?.[0]).toMatchObject({
      protocol: 'saml',
      redirectUris: ['http://crm.seamnex.local:8020/saml/consume'],
    });
  });

  it('takes the guarantee class and auth method from the payload, defaulting both', async () => {
    const { keycloak, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow({ payload: {} })]],
        ['INSERT INTO idp_client', []],
      ],
    });

    await service.registerIdentity(CRM, ACTOR);

    expect(keycloak.upsertClient.mock.calls[0]?.[0]).toMatchObject({ protocol: 'oidc' });
  });

  it('falls back to the ingress domain when the instance has no route yet', async () => {
    const { keycloak, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow({ host: null })]],
        ['INSERT INTO idp_client', []],
      ],
    });

    await service.registerIdentity(CRM, ACTOR);

    expect(keycloak.upsertClient.mock.calls[0]?.[0]).toMatchObject({
      redirectUris: ['http://crm.seamnex.local:8020/oauth-callback.php'],
    });
  });

  it('records a host with no admin client instead of failing the deployment', async () => {
    const { audit, db, service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow()]]],
      config: { SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '' },
      keycloak: {
        upsertClient: vi.fn(async () =>
          Promise.reject(
            new AppError({
              code: 'ADAPTER_UNAVAILABLE',
              detail: 'No Keycloak admin client secret.',
            }),
          ),
        ),
      },
    });

    await expect(service.registerIdentity(CRM, ACTOR)).resolves.toEqual({
      clientId: 'seamnex-crm',
      adapter: {
        adapter: 'oidc',
        propagatesGroupRoles: true,
        revokesProductSessions: true,
        syncState: 'unsupported',
      },
    });

    expect(audit.append.mock.calls[0]?.[0]).toMatchObject({
      action: 'instance.idp_client.unavailable',
      outcome: 'failure',
      detail: { clientId: 'seamnex-crm', reason: 'No Keycloak admin client secret.' },
    });
    // Nothing was registered, so nothing is claimed in the table either.
    expect(statement(db, 'INSERT INTO idp_client')).toBeUndefined();
  });

  /**
   * The exemption above is for a host that *cannot* provision a client, not for one whose provider
   * said no. Every non-2xx from the Admin API is reduced to `ADAPTER_UNAVAILABLE`, so a refusal —
   * a 403 after a permission change, a 500 — used to be recorded as "unsupported" and the
   * deployment stayed green with a product whose sign-in was dead.
   */
  it('fails the deployment when the provider refuses a registration it is configured to make', async () => {
    const { audit, service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow()]]],
      keycloak: {
        upsertClient: vi.fn(async () =>
          Promise.reject(
            new AppError({
              code: 'ADAPTER_UNAVAILABLE',
              detail: 'Keycloak POST /client-scopes answered 403.',
            }),
          ),
        ),
      },
    });

    await expect(service.registerIdentity(CRM, ACTOR)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('lets a failure that is not an unavailable adapter through', async () => {
    const { service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow()]]],
      keycloak: {
        upsertClient: vi.fn(async () => Promise.reject(new Error('connection refused'))),
      },
    });

    await expect(service.registerIdentity(CRM, ACTOR)).rejects.toThrow('connection refused');
  });

  it('lets an AppError with another code through', async () => {
    const { service } = build({
      routes: [['LEFT JOIN instance_route r', [instanceRow()]]],
      keycloak: {
        upsertClient: vi.fn(async () =>
          Promise.reject(new AppError({ code: 'CONFLICT', detail: 'the client id is taken' })),
        ),
      },
    });

    await expect(service.registerIdentity(CRM, ACTOR)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('reports an IdP that could not join the instance network without refusing the registration', async () => {
    const { audit, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['INSERT INTO idp_client', []],
      ],
      docker: { connectNetwork: vi.fn(async () => Promise.reject(new Error('network not found'))) },
    });

    await expect(service.registerIdentity(CRM, ACTOR)).resolves.toMatchObject({
      clientId: 'seamnex-crm',
    });

    expect(audit.append.mock.calls[0]?.[0]).toMatchObject({
      action: 'instance.idp_network.unavailable',
      detail: {
        network: 'seamnex-inst-crm',
        alias: 'keycloak',
        reason: 'the identity provider could not join seamnex-inst-crm: network not found',
      },
    });
  });
});

describe('materialising a route', () => {
  const happyRoutes: readonly Route[] = [
    ['LEFT JOIN instance_route r', [instanceRow()]],
    ['FROM catalog_entry WHERE key', [{ guarantee_class: 'native' }]],
    ['INSERT INTO instance_route', []],
    ['instance_route r JOIN instance i', [projectionRow()]],
    ['FROM instance_route WHERE instance_id', [routeRow()]],
  ];

  function materialise(
    options: {
      routes?: readonly Route[];
      input?: RouteInput;
      config?: Record<string, unknown>;
    } = {},
  ) {
    return build({ routes: options.routes ?? happyRoutes, config: options.config });
  }

  it('refuses an instance that does not exist', async () => {
    const { service } = materialise({ routes: [['LEFT JOIN instance_route r', []]] });

    await expect(service.materialiseRoute(CRM, {}, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('derives the host, the publish model and the auth mode from the catalog entry', async () => {
    const { db, service } = materialise();

    await expect(service.materialiseRoute(CRM, {}, ACTOR)).resolves.toMatchObject({
      host: 'crm.seamnex.local',
      pathPrefix: '/',
      publishModel: 'subdomain',
      authMode: 'native',
    });

    expect(statement(db, 'INSERT INTO instance_route')?.params).toEqual([
      CRM,
      'crm.seamnex.local',
      null,
      'subdomain',
      'acme',
      'native',
      true,
    ]);
  });

  it('lower-cases the host it is given and publishes under the subpath', async () => {
    const { db, service } = materialise();

    await service.materialiseRoute(CRM, { host: 'SHOP.Example.TEST', pathPrefix: '/app' }, ACTOR);

    expect(statement(db, 'INSERT INTO instance_route')?.params).toEqual([
      CRM,
      'shop.example.test',
      '/app',
      'subpath',
      'acme',
      'native',
      true,
    ]);
  });

  it('takes an explicit publish model and an unpublished state as given', async () => {
    const { db, service } = materialise();

    await service.materialiseRoute(
      CRM,
      { publishModel: 'subdomain', published: false, pathPrefix: '/app' },
      ACTOR,
    );

    expect(statement(db, 'INSERT INTO instance_route')?.params).toEqual([
      CRM,
      'crm.seamnex.local',
      '/app',
      'subdomain',
      'acme',
      'native',
      false,
    ]);
  });

  /**
   * NFR-4.1 / ISSUE-07: the route records the certificate the deployment's edge actually serves.
   * The literal `'acme'` it used to write claimed a resolver nothing had configured, and the
   * overview screen repeated the claim to the operator.
   */
  it('records the deployment’s edge certificate mode and re-writes it on conflict', async () => {
    const { db, service } = materialise({
      config: { SEAMNEX_EDGE_TLS_MODE: 'internal' },
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM catalog_entry WHERE key', [{ guarantee_class: 'native' }]],
        ['INSERT INTO instance_route', []],
        ['instance_route r JOIN instance i', [projectionRow({ tls_mode: 'internal' })]],
        ['FROM instance_route WHERE instance_id', [routeRow({ tls_mode: 'internal' })]],
      ],
    });

    await service.materialiseRoute(CRM, {}, ACTOR);

    const insert = statement(db, 'INSERT INTO instance_route');
    expect(insert?.params[4]).toBe('internal');
    // A re-materialised route follows the deployment, so the update has to carry the column too.
    expect(insert?.sql).toMatch(/tls_mode = EXCLUDED\.tls_mode/);
  });

  it('follows the catalog entry rather than the caller when no auth mode is named', async () => {
    const { db, service } = materialise({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM catalog_entry WHERE key', [{ guarantee_class: 'fa_gate' }]],
        ['INSERT INTO instance_route', []],
        ['instance_route r JOIN instance i', [projectionRow({ auth_mode: 'fa_gate' })]],
        ['FROM instance_route WHERE instance_id', [routeRow({ auth_mode: 'fa_gate' })]],
      ],
    });

    await expect(service.materialiseRoute(CRM, {}, ACTOR)).resolves.toMatchObject({
      authMode: 'fa_gate',
    });
    expect(statement(db, 'INSERT INTO instance_route')?.params[5]).toBe('fa_gate');
  });

  it('refuses an auth mode that contradicts the catalog entry', async () => {
    const { db, service } = materialise({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM catalog_entry WHERE key', [{ guarantee_class: 'fa_gate' }]],
      ],
    });

    await expect(
      service.materialiseRoute(CRM, { authMode: 'native' }, ACTOR),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'authMode "native" contradicts guaranteeClass "fa_gate" of catalog entry D01-01.',
    });
    expect(statement(db, 'INSERT INTO instance_route')).toBeUndefined();
  });

  it('accepts an auth mode that agrees with the catalog entry', async () => {
    const { db, service } = materialise({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM catalog_entry WHERE key', [{ guarantee_class: 'fa_header' }]],
        ['INSERT INTO instance_route', []],
        ['instance_route r JOIN instance i', [projectionRow({ auth_mode: 'fa_header' })]],
        ['FROM instance_route WHERE instance_id', [routeRow({ auth_mode: 'fa_header' })]],
      ],
    });

    await service.materialiseRoute(CRM, { authMode: 'fa_header' }, ACTOR);

    expect(statement(db, 'INSERT INTO instance_route')?.params[5]).toBe('fa_header');
  });

  it('defaults an entry with no catalog row to native', async () => {
    const { db, service } = materialise({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM catalog_entry WHERE key', []],
        ['INSERT INTO instance_route', []],
        ['instance_route r JOIN instance i', [projectionRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
      ],
    });

    await service.materialiseRoute(CRM, {}, ACTOR);

    expect(statement(db, 'INSERT INTO instance_route')?.params[5]).toBe('native');
  });

  it('reports an internal error when the route row cannot be read back', async () => {
    const { service } = materialise({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM catalog_entry WHERE key', [{ guarantee_class: 'native' }]],
        ['INSERT INTO instance_route', []],
        ['instance_route r JOIN instance i', [projectionRow()]],
        ['FROM instance_route WHERE instance_id', []],
      ],
    });

    await expect(service.materialiseRoute(CRM, {}, ACTOR)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The route row was not created.',
    });
  });
});

describe('the five deployment checks', () => {
  function runChecksOptions(
    options: {
      route?: Record<string, unknown>[] | null;
      payload?: Record<string, unknown>;
      entryKey?: string;
      schedule?: unknown;
      hooks?: unknown;
      eventModes?: string[];
      verdict?: { ok: boolean }[];
      client?: Record<string, unknown>[];
      config?: Record<string, unknown>;
      docker?: Record<string, unknown>;
      sso?: Record<string, unknown>;
      renderer?: Record<string, unknown>;
    } = {},
  ): BuildOptions {
    const routes: Route[] = [
      [
        'LEFT JOIN instance_route r',
        [
          instanceRow({
            entry_key: options.entryKey ?? 'D01-01',
            payload: options.payload ?? { guaranteeClass: 'native', httpPort: 8080 },
          }),
        ],
      ],
      [
        'FROM instance_route WHERE instance_id',
        options.route === null ? [] : [routeRow(options.route?.[0])],
      ],
      ...ssoRoutes({ client: options.client, verdict: options.verdict }),
      ['FROM backup_schedule', options.schedule ?? [{ '?column?': 1 }]],
      ['FROM trigger_endpoint', options.hooks ?? [{ '?column?': 1 }]],
      // What the product declares, as opposed to what it registered: a product with no declared
      // events has nothing to register, and the check has to be able to say so.
      ['FROM integration_metadata', [{ event_modes: options.eventModes ?? [] }]],
      ['INSERT INTO integration_check', []],
      [
        'DISTINCT ON (check_type)',
        [{ check_type: 'http', ok: true, detail: 'answered', checked_at: new Date() }],
      ],
    ];
    return {
      routes,
      docker: options.docker,
      ssoProbe: options.sso,
      config: options.config,
      renderer: options.renderer,
    };
  }

  it('passes a product that answers, resolves and can be signed into', async () => {
    const { db, service } = build(runChecksOptions());

    const result = await service.runChecks(CRM);

    expect(result.ready).toBe(true);
    expect(result.blocking).toEqual([]);
    // Five rows, one per check: the check is the evidence a later review reads.
    expect(statements(db, 'INSERT INTO integration_check')).toHaveLength(5);
  });

  it('names the port the entry declared in the HTTP detail', async () => {
    const { db, service } = build(runChecksOptions({ payload: { httpPort: 3000 } }));

    await service.runChecks(CRM);

    const row = statements(db, 'INSERT INTO integration_check')[0]?.params;
    expect(row?.[3]).toBe('HTTP answered on :3000 (HTTP 200)');
  });

  it('assumes port 80 for an entry that declares none', async () => {
    const { db, service } = build(runChecksOptions({ payload: { guaranteeClass: 'native' } }));

    await service.runChecks(CRM);

    expect(statements(db, 'INSERT INTO integration_check')[0]?.params[3]).toBe(
      'HTTP answered on :80 (HTTP 200)',
    );
  });

  it('blocks a product that does not answer on its port', async () => {
    const { service } = build(
      runChecksOptions({
        docker: {
          runCli: vi.fn(async (_file: string, args: readonly string[]) =>
            args.includes('seamnex-idp-probe')
              ? { code: 0, stdout: 'ANSWER HTTP/1.1 200 OK\n', stderr: '', truncated: false }
              : { code: 1, stdout: 'no HTTP answer\n', stderr: '', truncated: false },
          ),
        },
      }),
    );

    const result = await service.runChecks(CRM);

    expect(result.ready).toBe(false);
    expect(result.blocking).toEqual(['http: no HTTP answer on :8080']);
  });

  it('blocks on a route that was never materialised', async () => {
    const { service } = build(runChecksOptions({ route: null }));

    const result = await service.runChecks(CRM);

    expect(result.blocking).toContain('dns: no route materialised');
  });

  it('blocks an SSO failure for a forward-auth product', async () => {
    const { service } = build(
      runChecksOptions({
        route: [{ auth_mode: 'fa_gate' }],
        sso: { verify: vi.fn(async () => ({ ok: false, detail: 'audience mismatch' })) },
      }),
    );

    const result = await service.runChecks(CRM);

    expect(result.ready).toBe(false);
    expect(result.blocking).toEqual(['sso_login: audience mismatch']);
  });

  it('does not block a native product on an SSO failure', async () => {
    // The product is its own identity authority: an IdP that is not wired up says nothing about
    // whether the instance works, and blocking made every native deployment fail after the
    // containers were already running.
    const { service } = build(
      runChecksOptions({
        sso: { verify: vi.fn(async () => ({ ok: false, detail: 'no identity client' })) },
      }),
    );

    await expect(service.runChecks(CRM)).resolves.toMatchObject({ ready: true, blocking: [] });
  });

  it('refuses to call it single sign-on when the product was never given the client secret', async () => {
    /*
     * The observed incident: a registered client, a successful code exchange, and an ERPNext site
     * that had not received `ERPNEXT_SSO_CLIENT_SECRET` — so its bootstrap wrote no `Social Login Key`
     * and the only way in was a password. The IdP-side probe passed because it used the platform's
     * own copy of the secret.
     */
    const { db, service } = build(
      runChecksOptions({
        entryKey: 'D06-01',
        renderer: {
          instanceEnv: vi.fn(async () => [
            { name: 'ERPNEXT_SSO_CLIENT_SECRET', source: 'default' },
          ]),
        },
      }),
    );

    await service.runChecks(CRM);

    expect(statements(db, 'INSERT INTO integration_check')[1]?.params[3]).toContain(
      'ERPNEXT_SSO_CLIENT_SECRET is registered at the identity provider but was never applied',
    );
  });

  it('reads the product’s own sign-in page for the provider entry point', async () => {
    const { db, service } = build(
      runChecksOptions({
        entryKey: 'D06-01',
        docker: {
          runCli: vi.fn(async (_file: string, args: readonly string[]) => {
            if (args.includes('seamnex-signin-probe'))
              return { code: 1, stdout: 'SIGNIN absent\n', stderr: '', truncated: false };
            if (args.includes('seamnex-idp-probe'))
              return { code: 0, stdout: 'ANSWER HTTP/1.1 200 OK\n', stderr: '', truncated: false };
            return { code: 0, stdout: 'HTTP 200\n', stderr: '', truncated: false };
          }),
        },
      }),
    );

    await service.runChecks(CRM);

    const detail = statements(db, 'INSERT INTO integration_check')[1]?.params[3];
    expect(detail).toContain('stage 0.5 (sign-in page)');
    expect(detail).toContain('does not offer the identity provider');
  });

  it('records what the product side established, not only what the realm answered', async () => {
    // "stages 1–2 passed" was true of a deployment whose product had never been configured; the row
    // an operator reads has to name the legs that make the claim true of this instance.
    const { db, service } = build(runChecksOptions({ entryKey: 'D06-01' }));

    await service.runChecks(CRM);

    const detail = String(statements(db, 'INSERT INTO integration_check')[1]?.params[3]);
    expect(detail).toContain('ERPNEXT_SSO_CLIENT_SECRET is applied');
    expect(detail).toContain('/login offers the provider');
    expect(detail).toContain('stages 1–2 passed');
  });

  it('never blocks on a backup or webhook that is not registered yet', async () => {
    const { db, service } = build(
      runChecksOptions({
        schedule: { rows: [], rowCount: null },
        hooks: { rows: [], rowCount: null },
      }),
    );

    await expect(service.runChecks(CRM)).resolves.toMatchObject({ ready: true, blocking: [] });
    const details = statements(db, 'INSERT INTO integration_check').map((entry) => entry.params[3]);
    expect(details).toContain('no backup schedule registered');
    // Not a failure: the declaration is empty, so there is nothing to register. Reporting it red put
    // a permanent failed row on every deployment of such a product, with a detail that already said
    // it was not a fault.
    expect(details).toContain('the product declares no triggers, so there is nothing to register');
  });

  it('still reports a missing trigger endpoint for a product that declares events', async () => {
    const { db, service } = build(
      runChecksOptions({
        hooks: { rows: [], rowCount: null },
        eventModes: ['ticket.created'],
      }),
    );

    await service.runChecks(CRM);

    const details = statements(db, 'INSERT INTO integration_check').map((entry) => entry.params[3]);
    expect(details).toContain('the product declares events but no trigger endpoint is registered');
  });

  it('reports an installer page as reachable-but-uninstalled, not as a blocked deployment', async () => {
    // The observed incident: D07-01 answered `302 -> /installer/index.php/welcome`, the check called
    // that a pass, and the instance, the portal tile and the job all reported success. Failing the
    // job instead would be no better — the route is the only way to finish the install in a browser.
    const { db, service } = build(
      runChecksOptions({
        route: [{ auth_mode: 'fa_gate' }],
        docker: {
          runCli: vi.fn(async () => ({
            code: 0,
            stdout: 'HTTP 302\nLOCATION /installer/index.php/welcome\n',
            stderr: '',
            truncated: false,
          })),
        },
        sso: { verify: vi.fn(async () => ({ ok: false, detail: 'account_failed' })) },
      }),
    );

    const result = await service.runChecks(CRM);

    expect(result.installPending).toBe('/installer/index.php/welcome');
    expect(result.ready).toBe(true);
    expect(result.blocking).toEqual([]);
    const details = statements(db, 'INSERT INTO integration_check').map((entry) => entry.params[3]);
    expect(details[0]).toBe(
      "HTTP answered on :8080 (HTTP 302) with the product's installer at /installer/index.php/welcome",
    );
    expect(details[1]).toContain('not checked');
  });

  it('records a change of SSO verdict as the event worth auditing', async () => {
    const { audit, service } = build(runChecksOptions({ verdict: [{ ok: false }] }));

    await service.runChecks(CRM);

    expect(audit.append.mock.calls[0]?.[0]).toMatchObject({
      action: 'sso.check.recovered',
      outcome: 'success',
      detail: { previous: false, now: true },
    });
  });

  it('reports the login leg as unverified when the instance has no identity client', async () => {
    const { db, service } = build(runChecksOptions({ client: [] }));

    await service.runChecks(CRM);

    expect(statements(db, 'INSERT INTO integration_check')[1]?.params[3]).toContain(
      'no identity client is recorded for this instance',
    );
  });
});

describe('the SSO check itself', () => {
  it('reports a realm that does not answer at all', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', []],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
      keycloak: { realmReachable: vi.fn(async () => false) },
    });

    const verdict = await service.verifyIdentity(CRM);

    expect(verdict.detail).toBe(
      'the identity provider is not reachable, so the login leg was not verified',
    );
  });

  it('treats a realm it cannot even ask about as unreachable', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', []],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
      keycloak: { realmReachable: vi.fn(async () => Promise.reject(new Error('no admin secret'))) },
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      detail: 'the identity provider is not reachable, so the login leg was not verified',
    });
  });

  it('does not claim the catalog promised single sign-on for a forward-auth product', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow({ auth_mode: 'fa_gate' })]],
        ['FROM idp_client WHERE instance_id', []],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
    });

    // The sentence is reserved for a `native` entry, where the catalog really does promise SSO.
    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      ok: false,
      detail: 'no identity client is recorded for this instance; the login leg was not verified',
    });
  });

  it('says the catalog promised single sign-on when a native product has no client', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', []],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      detail: expect.stringContaining('although the catalog declares single sign-on'),
    });
  });

  it('treats an instance with no route yet as a native product', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', []],
        ['FROM idp_client WHERE instance_id', []],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      detail: expect.stringContaining('no identity client is recorded for this instance'),
    });
  });

  it('refuses a client row with no secret on record', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow({ client_secret_ref: null })]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
    });

    await expect(service.verifyIdentity(CRM)).resolves.toEqual({
      ok: false,
      detail: 'client seamnex-crm has no secret or redirect URI on record; re-register it',
    });
  });

  it('refuses a client row with no redirect URI on record', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow({ redirect_uris: [] })]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      detail: expect.stringContaining('has no secret or redirect URI on record'),
    });
  });

  it('reports a secret the platform can no longer open as unverified, not as broken', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
      secrets: { open: vi.fn(async () => Promise.reject(new Error('root key rotated'))) },
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('root key rotated'),
    });
  });

  it('quotes a non-Error failure to open the secret', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
      secrets: { open: vi.fn(async () => Promise.reject('the root key is gone')) },
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      detail: expect.stringContaining('the root key is gone'),
    });
  });

  it('quotes a non-Error failure to attach the IdP to the network', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
      docker: { connectNetwork: vi.fn(async () => Promise.reject('network busy')) },
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      detail:
        'stage 0 (product network): the identity provider could not join seamnex-inst-crm: network busy',
    });
  });

  /**
   * Keycloak keeps a product's client in its own database: a Keycloak upgrade that migrates the
   * realm, or a `compose up` on a fresh volume, leaves the product's next login failing at the
   * authorization leg (`invalid_client`, the popup never closes) while the platform still has a row
   * to read. The check re-applies the registration from what it already holds before it measures,
   * so the repair does not wait for the next deployment of the instance.
   */
  it('re-applies the client registration before it probes the login', async () => {
    const { keycloak, ssoProbe, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
    });

    await service.verifyIdentity(CRM);

    expect(keycloak.upsertClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'seamnex-crm',
        secret: 'operator-secret',
        redirectUris: ['http://crm.seamnex.local:8020/oauth-callback.php'],
        protocol: 'oidc',
      }),
    );
    expect(ssoProbe.verify).toHaveBeenCalled();
  });

  it('reports a client the IdP refuses to re-apply instead of probing', async () => {
    const { ssoProbe, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
      keycloak: {
        upsertClient: vi.fn(async () =>
          Promise.reject(
            new AppError({
              code: 'ADAPTER_UNAVAILABLE',
              detail: 'Keycloak PUT /clients/uuid-1 answered 403.',
            }),
          ),
        ),
      },
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('stage 0.25 (client registration)'),
    });
    expect(ssoProbe.verify).not.toHaveBeenCalled();
  });

  it('stops at stage 0 when the IdP is not on the instance network', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
      config: { SEAMNEX_IDP_CONTAINER: '' },
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('stage 0 (product network)'),
    });
  });

  it('stops at stage 0 when the product cannot resolve the IdP', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
      docker: {
        runCli: vi.fn(async () => ({
          code: 2,
          stdout: 'DNS keycloak does not resolve on this network\n',
          stderr: '',
          truncated: false,
        })),
      },
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({
      detail: expect.stringContaining('does not resolve from seamnex-inst-crm'),
    });
  });

  it('drives the probe with the registered client, URI and required claim', async () => {
    const { ssoProbe, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow({ auth_mode: 'fa_gate' })]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
    });

    await service.verifyIdentity(CRM);

    expect(ssoProbe.verify.mock.calls[0]?.[0]).toEqual({
      clientId: 'seamnex-crm',
      redirectUri: 'http://crm.seamnex.local:8020/oauth-callback.php',
      clientSecret: 'operator-secret',
      expectedClaims: ['groups'],
    });
  });

  it('omits the claim expectation for a product that declares none', async () => {
    const { ssoProbe, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow({ entry_key: 'D09-01' })]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', []],
        ['INSERT INTO integration_check', []],
      ],
    });

    await service.verifyIdentity(CRM);

    expect(ssoProbe.verify.mock.calls[0]?.[0]).not.toHaveProperty('expectedClaims');
  });

  it('records every run and audits only the transition', async () => {
    const { audit, db, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', [{ ok: true }]],
        ['INSERT INTO integration_check', []],
      ],
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({ ok: true });

    expect(statements(db, 'INSERT INTO integration_check')).toHaveLength(1);
    // Same verdict as last time: nothing to report, so the chain stays readable.
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('audits a verdict that got worse', async () => {
    const { audit, service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', [{ ok: true }]],
        ['INSERT INTO integration_check', []],
      ],
      ssoProbe: { verify: vi.fn(async () => ({ ok: false, detail: 'audience mismatch' })) },
    });

    await service.verifyIdentity(CRM);

    expect(audit.append.mock.calls[0]?.[0]).toMatchObject({
      action: 'sso.check.failed',
      outcome: 'failure',
      detail: { previous: true, now: false, detail: 'audience mismatch' },
    });
  });

  it('does not turn a chain outage into a failed check run', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', [{ ok: false }]],
        ['INSERT INTO integration_check', []],
      ],
      audit: { append: vi.fn(async () => Promise.reject(new Error('chain unavailable'))) },
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({ ok: true });
  });

  it('quotes a non-Error chain outage without failing the check', async () => {
    const { service } = build({
      routes: [
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ['FROM idp_client WHERE instance_id', [clientRow()]],
        ['SELECT ok FROM integration_check', [{ ok: false }]],
        ['INSERT INTO integration_check', []],
      ],
      audit: { append: vi.fn(async () => Promise.reject('chain offline')) },
    });

    await expect(service.verifyIdentity(CRM)).resolves.toMatchObject({ ok: true });
  });
});

describe('reconciling the identity networks', () => {
  const RECONCILE = 'JOIN idp_client c ON';
  // The pass reads the client row and re-applies it: the registration is runtime state at the IdP,
  // so it is part of what a repair pass repairs.
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: CRM,
    entry_key: 'D01-01',
    last_checked: null as Date | null,
    ...clientRow(),
    ...overrides,
  });

  it('does nothing at all when no IdP container is configured', async () => {
    const { db, docker, service } = build({ config: { SEAMNEX_IDP_CONTAINER: '' } });

    await expect(service.reconcileIdentityNetworks()).resolves.toEqual({
      instances: 0,
      failed: 0,
      verified: 0,
    });
    expect(db.calls).toHaveLength(0);
    expect(docker.connectNetwork).not.toHaveBeenCalled();
  });

  it('re-applies the attachment and records one row per breakage', async () => {
    const { db, docker, service } = build({
      routes: [
        [RECONCILE, [row()]],
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['INSERT INTO integration_check', []],
      ],
      docker: { connectNetwork: vi.fn(async () => Promise.reject(new Error('network not found'))) },
    });

    await expect(service.reconcileIdentityNetworks()).resolves.toEqual({
      instances: 1,
      failed: 1,
      verified: 0,
    });
    expect(docker.connectNetwork).toHaveBeenCalledWith('seamnex-inst-crm', 'seamnex-idp', [
      'keycloak',
    ]);
    // Deduplicated: the same sentence is not re-recorded within five minutes, so a permanently
    // broken instance stays readable.
    expect(statement(db, 'INSERT INTO integration_check')?.sql).toContain('NOT EXISTS');
  });

  it('leaves fresh evidence alone', async () => {
    const { docker, service } = build({
      routes: [
        [RECONCILE, [row({ last_checked: new Date() })]],
        ['LEFT JOIN instance_route r', [instanceRow()]],
      ],
    });

    await expect(service.reconcileIdentityNetworks()).resolves.toEqual({
      instances: 1,
      failed: 0,
      verified: 0,
    });
    expect(docker.runCli).not.toHaveBeenCalled();
  });

  it('re-verifies the login leg once the evidence leaves the freshness window', async () => {
    const stale = new Date(Date.now() - 3_600_000);
    const { db, service } = build({
      routes: [
        [RECONCILE, [row({ last_checked: stale })]],
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ...ssoRoutes({ verdict: [{ ok: true }] }),
        ['INSERT INTO integration_check', []],
      ],
    });

    await expect(service.reconcileIdentityNetworks()).resolves.toEqual({
      instances: 1,
      failed: 0,
      verified: 1,
    });
    expect(statements(db, 'INSERT INTO integration_check')).toHaveLength(1);
  });

  it('counts an instance whose never-checked login leg fails to re-verify', async () => {
    const { db, service } = build({
      routes: [
        [RECONCILE, [row()]],
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ...ssoRoutes(),
        ['INSERT INTO integration_check', () => Promise.reject(new Error('check row unwritable'))],
      ],
    });

    await expect(service.reconcileIdentityNetworks()).resolves.toEqual({
      instances: 1,
      failed: 0,
      verified: 0,
    });
    expect(statements(db, 'INSERT INTO integration_check')).toHaveLength(1);
  });

  it('quotes a non-Error failure to re-verify as the periodic check sentence', async () => {
    const { service } = build({
      routes: [
        [RECONCILE, [row()]],
        ['LEFT JOIN instance_route r', [instanceRow()]],
        ['FROM instance_route WHERE instance_id', [routeRow()]],
        ...ssoRoutes(),
        ['INSERT INTO integration_check', () => Promise.reject('the check row was refused')],
      ],
    });

    await expect(service.reconcileIdentityNetworks()).resolves.toMatchObject({ verified: 0 });
  });

  it('reports no instances when the driver does not report a row count', async () => {
    const { service } = build({
      routes: [[RECONCILE, { rows: [], rowCount: null }]],
    });

    await expect(service.reconcileIdentityNetworks()).resolves.toMatchObject({ instances: 0 });
  });
});

describe('the route projection', () => {
  const GATE = 'UPDATE instance_route SET gated';

  it('closes every route in the caller transaction', async () => {
    const { db, service } = build({ routes: [[GATE, []]] });

    await service.setAllRoutesGated(db.client, true);

    // One statement, no WHERE clause: the gate is platform-wide by definition.
    expect(statement(db, GATE)?.params).toEqual([true]);
  });

  it('re-projects every route at boot and swallows a projection failure', async () => {
    const { traefik, service } = build({
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        ['instance_route r JOIN instance i', [projectionRow()]],
      ],
    });

    await expect(service.projectAll()).resolves.toBe(1);
    expect(traefik.write).toHaveBeenCalledOnce();
    // The database is the only truth about which routes exist, so everything it did not just write
    // is stale — including documents left on the pre-TLS `web` entrypoint (ISSUE-07).
    expect(traefik.prune).toHaveBeenCalledWith(new Set(['crm']));
  });

  it('still boots when the projection fails', async () => {
    const { service } = build({
      routes: [
        [
          'SELECT instance_id FROM instance_route',
          () => Promise.reject(new Error('table missing')),
        ],
      ],
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('reports no route count when the driver does not report one', async () => {
    const { service } = build({
      routes: [['SELECT instance_id FROM instance_route', { rows: [], rowCount: null }]],
    });

    await expect(service.projectAll()).resolves.toBe(0);
  });

  it('writes the upstream, the forward-auth address and the router for a live route', async () => {
    const { docker, traefik, service } = build({
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        ['instance_route r JOIN instance i', [projectionRow({ path_prefix: '/app' })]],
      ],
    });

    await service.projectAll();

    expect(docker.connectNetwork).toHaveBeenCalledWith('seamnex-inst-crm', 'seamnex-edge');
    expect(traefik.write.mock.calls[0]?.[0]).toEqual({
      slug: 'crm',
      host: 'crm.seamnex.local',
      pathPrefix: '/app',
      upstream: 'http://crm:8080',
      published: true,
      forwardAuthAddress: 'http://auth-gateway:8090/verify',
      bootstrapAddress: 'http://auth-gateway:8090',
      authMode: 'native',
      tlsMode: 'acme',
    });
  });

  /**
   * ISSUE-07: the column, not a constant, decides how the edge terminates TLS. A deployment whose
   * edge serves its own certificate must project that, or the router asks ACME for a host it cannot
   * validate.
   */
  it('projects the certificate mode recorded on the row', async () => {
    const { traefik, service } = build({
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        ['instance_route r JOIN instance i', [projectionRow({ tls_mode: 'internal' })]],
      ],
    });

    await service.projectAll();

    expect(traefik.write.mock.calls[0]?.[0]).toMatchObject({ tlsMode: 'internal' });
  });

  it('falls back to port 80 and to the native auth mode for a row that declares neither', async () => {
    const { traefik, service } = build({
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        [
          'instance_route r JOIN instance i',
          [projectionRow({ payload: {}, auth_mode: 'something' })],
        ],
      ],
    });

    await service.projectAll();

    expect(traefik.write.mock.calls[0]?.[0]).toMatchObject({
      upstream: 'http://crm:80',
      authMode: 'native',
    });
  });

  it('withdraws the file and skips the edge for an unpublished route', async () => {
    const { docker, traefik, service } = build({
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        ['instance_route r JOIN instance i', [projectionRow({ published: false })]],
      ],
    });

    await service.projectAll();

    expect(docker.connectNetwork).not.toHaveBeenCalled();
    expect(traefik.write.mock.calls[0]?.[0]).toMatchObject({ published: false });
  });

  it('treats a gated route as unpublished', async () => {
    const { docker, traefik, service } = build({
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        ['instance_route r JOIN instance i', [projectionRow({ gated: true })]],
      ],
    });

    await service.projectAll();

    expect(docker.connectNetwork).not.toHaveBeenCalled();
    expect(traefik.write.mock.calls[0]?.[0]).toMatchObject({ published: false });
  });

  it('writes no file for a route that has no instance row', async () => {
    const { traefik, service } = build({
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        ['instance_route r JOIN instance i', []],
      ],
    });

    await service.projectAll();

    expect(traefik.write).not.toHaveBeenCalled();
    // A row whose instance cannot be read projects nothing, so its document is stale too.
    expect(traefik.prune).toHaveBeenCalledWith(new Set());
  });

  it('publishes a route even when the edge could not join the network', async () => {
    const { traefik, service } = build({
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        ['instance_route r JOIN instance i', [projectionRow()]],
      ],
      docker: { connectNetwork: vi.fn(async () => Promise.reject(new Error('network not found'))) },
    });

    await service.projectAll();

    // The route file is still written: the edge can re-join on the next pass, and a missing file
    // would delete a route that is otherwise correct.
    expect(traefik.write).toHaveBeenCalledOnce();
  });

  it('quotes a non-Error edge failure and still writes the route', async () => {
    const { traefik, service } = build({
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        ['instance_route r JOIN instance i', [projectionRow()]],
      ],
      docker: { connectNetwork: vi.fn(async () => Promise.reject('network busy')) },
    });

    await service.projectAll();

    expect(traefik.write).toHaveBeenCalledOnce();
  });

  it('skips the edge entirely when no edge container is configured', async () => {
    const { docker, traefik, service } = build({
      config: { SEAMNEX_EDGE_CONTAINER: '' },
      routes: [
        ['SELECT instance_id FROM instance_route', [{ instance_id: CRM }]],
        ['instance_route r JOIN instance i', [projectionRow()]],
      ],
    });

    await service.projectAll();

    expect(docker.connectNetwork).not.toHaveBeenCalled();
    expect(traefik.write).toHaveBeenCalledOnce();
  });
});
