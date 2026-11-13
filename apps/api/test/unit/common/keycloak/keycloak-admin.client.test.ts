import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { jsonResponse } from '../../../support/fakes';
import { KeycloakAdminClient } from '../../../../src/common/keycloak/keycloak-admin.client';

/**
 * The Admin API client is where three properties are asserted in one place: the admin token is
 * cached (one round trip per half-minute, never a cached rejection), every non-2xx answer becomes
 * an `ADAPTER_UNAVAILABLE` an operator can act on, and provisioning a client is idempotent
 * (`POST` when absent, `PUT` when present). `fetch` is stubbed rather than the class, so the
 * request bodies the realm actually receives are part of the assertions.
 */
const ADMIN_URL = 'https://idp.example.test';
const REALM = 'seamnex';

const tempDirs: string[] = [];

function secretFile(secret: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-kc-'));
  tempDirs.push(dir);
  const path = join(dir, 'admin-secret');
  writeFileSync(path, `${secret}\n`, 'utf8');
  return path;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    SEAMNEX_ADAPTERS_MODE: 'real',
    SEAMNEX_KEYCLOAK_ADMIN_URL: ADMIN_URL,
    SEAMNEX_KEYCLOAK_REALM: REALM,
    SEAMNEX_KEYCLOAK_ADMIN_CLIENT_ID: 'platform-admin',
    SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: secretFile('s3cret'),
    ...overrides,
  } as unknown as AppConfig;
}

type Call = { readonly url: string; readonly init: RequestInit };

/**
 * A realm stand-in: the token endpoint answers, everything else is routed by path. Unknown paths
 * answer 404 so a typo in a path shows up as an assertion failure, not a silent empty body.
 */
function realm(
  routes: Record<string, (init: RequestInit) => Response | Promise<Response>> = {},
  options: { token?: () => Response | Promise<Response> } = {},
): ReturnType<typeof vi.fn> {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/protocol/openid-connect/token')) {
      const token = options.token;
      return token === undefined
        ? jsonResponse({ access_token: 'admin-token', expires_in: 300 })
        : token();
    }
    for (const [fragment, answer] of Object.entries(routes)) {
      if (url.includes(fragment)) return answer(init);
    }
    return new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(fetchMock, { calls });
  return fetchMock;
}

function callsOf(fetchMock: ReturnType<typeof vi.fn>): Call[] {
  return (fetchMock as unknown as { calls: Call[] }).calls;
}

function bodyOf(call: Call | undefined): unknown {
  return typeof call?.init.body === 'string' ? JSON.parse(call.init.body) : undefined;
}

describe('admin token', () => {
  it('requests a client-credentials token once and reuses it', async () => {
    const fetchMock = realm({ '/admin/realms/seamnex/users': () => jsonResponse([]) });
    const client = new KeycloakAdminClient(makeConfig());

    await client.adminJson('/users');
    await client.adminJson('/users');

    const calls = callsOf(fetchMock);
    const tokenCalls = calls.filter((call) => call.url.includes('/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes('/admin/realms/seamnex/users'))).toHaveLength(
      2,
    );
    expect(calls[1]?.init.headers).toMatchObject({ authorization: 'Bearer admin-token' });
  });

  it('posts the client credentials as a form body', async () => {
    const fetchMock = realm({ '/admin/realms/seamnex/users': () => jsonResponse([]) });
    await new KeycloakAdminClient(makeConfig()).adminJson('/users');

    const tokenCall = callsOf(fetchMock).find((call) => call.url.includes('/token'));
    expect(tokenCall?.url).toBe(
      'https://idp.example.test/realms/seamnex/protocol/openid-connect/token',
    );
    const form = tokenCall?.init.body as URLSearchParams;
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('platform-admin');
    expect(form.get('client_secret')).toBe('s3cret');
  });

  it('does not cache a rejection: the next call asks again', async () => {
    let attempt = 0;
    const fetchMock = realm(
      { '/admin/realms/seamnex/users': () => jsonResponse([]) },
      {
        token: () => {
          attempt += 1;
          return attempt === 1
            ? new Response('', { status: 401 })
            : jsonResponse({ access_token: 'second-token', expires_in: 300 });
        },
      },
    );
    const client = new KeycloakAdminClient(makeConfig());

    await expect(client.adminJson('/users')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('refused the admin token (401)'),
    });

    await expect(client.adminJson('/users')).resolves.toEqual([]);
    expect(callsOf(fetchMock).filter((call) => call.url.includes('/token'))).toHaveLength(2);
  });

  it('refuses to call the realm when no secret file is configured', async () => {
    const fetchMock = realm({});
    const client = new KeycloakAdminClient(
      makeConfig({ SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '' }),
    );

    await expect(client.adminJson('/users')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('No Keycloak admin client secret'),
    });
    expect(callsOf(fetchMock)).toHaveLength(0);
  });

  it('refuses when the secret file cannot be read', async () => {
    realm({});
    const client = new KeycloakAdminClient(
      makeConfig({
        SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: join(tmpdir(), 'does-not-exist-seamnex'),
      }),
    );

    await expect(client.adminJson('/users')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('names the call that failed when the provider cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );

    await expect(new KeycloakAdminClient(makeConfig()).adminJson('/users')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('did not answer the admin token request (fetch failed)'),
    });
  });

  it('stringifies a transport failure that is not an Error', async () => {
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (first) {
          first = false;
          return jsonResponse({ access_token: 'tok', expires_in: 300 });
        }
        throw 'EHOSTUNREACH';
      }),
    );

    await expect(new KeycloakAdminClient(makeConfig()).adminJson('/users')).rejects.toMatchObject({
      detail: expect.stringContaining('(EHOSTUNREACH)'),
    });
  });

  it('never caches a zero-lifetime token as already expired', async () => {
    // `expires_in: 5` must still be usable for at least 30 s, otherwise every call re-authenticates.
    const fetchMock = realm(
      { '/admin/realms/seamnex/users': () => jsonResponse([]) },
      {
        token: () => jsonResponse({ access_token: 'short', expires_in: 5 }),
      },
    );
    const client = new KeycloakAdminClient(makeConfig());

    await client.adminJson('/users');
    await client.adminJson('/users');

    expect(callsOf(fetchMock).filter((call) => call.url.includes('/token'))).toHaveLength(1);
  });
});

describe('requests', () => {
  it('translates a non-2xx answer into ADAPTER_UNAVAILABLE naming method and path', async () => {
    realm({ '/admin/realms/seamnex/clients': () => new Response('', { status: 403 }) });

    await expect(new KeycloakAdminClient(makeConfig()).adminJson('/clients')).rejects.toMatchObject(
      {
        code: 'ADAPTER_UNAVAILABLE',
        detail: expect.stringContaining('Keycloak GET /clients answered 403.'),
      },
    );
  });

  it('sends a JSON content type only when there is a body', async () => {
    const fetchMock = realm({
      '/admin/realms/seamnex/clients': () => new Response(null, { status: 204 }),
      '/admin/realms/seamnex/users/u%2F1': () => new Response(null, { status: 204 }),
    });
    const client = new KeycloakAdminClient(makeConfig());

    await client.setUserEnabled('u/1', false);
    const [, put] = callsOf(fetchMock);
    expect(put?.init.method).toBe('PUT');
    expect(put?.url).toBe('https://idp.example.test/admin/realms/seamnex/users/u%2F1');
    expect(put?.init.headers).toMatchObject({
      authorization: 'Bearer admin-token',
      'content-type': 'application/json',
    });
    expect(bodyOf(put)).toEqual({ enabled: false });
  });

  it('exports the realm document', async () => {
    realm({ '/admin/realms/seamnex': () => jsonResponse({ realm: 'seamnex', enabled: true }) });
    await expect(new KeycloakAdminClient(makeConfig()).exportRealm()).resolves.toEqual({
      realm: 'seamnex',
      enabled: true,
    });
  });

  it('reports reachability from the token exchange', async () => {
    realm({});
    await expect(new KeycloakAdminClient(makeConfig()).realmReachable()).resolves.toBe(true);
  });

  it('reports unreachable instead of throwing', async () => {
    realm({}, { token: () => new Response('', { status: 500 }) });
    await expect(new KeycloakAdminClient(makeConfig()).realmReachable()).resolves.toBe(false);
  });
});

describe('upsertClient', () => {
  it('creates a missing client with the access-token and logout attributes', async () => {
    const fetchMock = realm({
      '/clients?clientId=shop': () => jsonResponse([]),
      '/admin/realms/seamnex/clients': () => new Response('', { status: 201 }),
    });

    const result = await new KeycloakAdminClient(makeConfig()).upsertClient({
      clientId: 'shop',
      redirectUris: ['https://shop.test/callback'],
      protocol: 'oidc',
      accessTokenLifespanSeconds: 300,
      offlineAccessDisabled: true,
      secret: 'client-secret',
      backchannelLogoutUrl: 'https://shop.test/backchannel',
    });

    expect(result).toEqual({ clientId: 'shop', created: true });
    const post = callsOf(fetchMock).find(
      (call) => call.init.method === 'POST' && call.url.endsWith('/clients'),
    );
    expect(bodyOf(post)).toEqual({
      clientId: 'shop',
      protocol: 'openid-connect',
      enabled: true,
      publicClient: false,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      redirectUris: ['https://shop.test/callback'],
      webOrigins: [],
      secret: 'client-secret',
      attributes: {
        'access.token.lifespan': '300',
        'offline.access.disabled': 'true',
        'backchannel.logout.url': 'https://shop.test/backchannel',
        'backchannel.logout.session.required': 'true',
      },
    });
  });

  it('updates an existing client in place and reports created: false', async () => {
    const fetchMock = realm({
      '/clients?clientId=shop': () => jsonResponse([{ id: 'uuid-1', clientId: 'shop' }]),
      '/admin/realms/seamnex/clients/uuid-1': () => new Response(null, { status: 204 }),
    });

    const result = await new KeycloakAdminClient(makeConfig()).upsertClient({
      clientId: 'shop',
      redirectUris: [],
      protocol: 'saml',
      accessTokenLifespanSeconds: 900,
      offlineAccessDisabled: false,
      secret: 'x',
    });

    expect(result).toEqual({ clientId: 'shop', created: false });
    const put = callsOf(fetchMock).find((call) => call.init.method === 'PUT');
    expect(put?.url).toContain('/clients/uuid-1');
    expect(bodyOf(put)).toMatchObject({
      protocol: 'saml',
      attributes: { 'access.token.lifespan': '900', 'offline.access.disabled': 'false' },
    });
  });

  it('assigns the group claim scope on both create and update', async () => {
    const scopes: Array<{ id: string; name: string }> = [];
    const fetchMock = realm({
      '/clients?clientId=shop': () => jsonResponse([{ id: 'uuid-1', clientId: 'shop' }]),
      '/client-scopes': (init) => {
        if (init.method === 'POST') {
          scopes.push({ id: 'scope-1', name: 'groups' });
          return new Response('', { status: 201 });
        }
        return jsonResponse(scopes);
      },
      '/protocol-mappers/models': () => new Response('', { status: 201 }),
      '/admin/realms/seamnex/clients/uuid-1': () => new Response(null, { status: 204 }),
      '/default-client-scopes/scope-1': () => new Response(null, { status: 204 }),
    });

    await new KeycloakAdminClient(makeConfig()).upsertClient({
      clientId: 'shop',
      redirectUris: [],
      protocol: 'oidc',
      accessTokenLifespanSeconds: 300,
      offlineAccessDisabled: false,
      secret: 'x',
      groupClaim: 'groups',
    });

    const urls = callsOf(fetchMock).map((call) => `${call.init.method} ${call.url}`);
    expect(urls.some((entry) => entry.includes('POST') && entry.endsWith('/client-scopes'))).toBe(
      true,
    );
    expect(
      urls.some((entry) => entry.includes('POST') && entry.endsWith('/protocol-mappers/models')),
    ).toBe(true);
    expect(
      urls.some((entry) => entry.endsWith('/clients/uuid-1/default-client-scopes/scope-1')),
    ).toBe(true);
  });
});

describe('ensureGroupClaimScope', () => {
  it('does nothing when the client does not exist', async () => {
    const fetchMock = realm({ '/clients?clientId=ghost': () => jsonResponse([]) });
    await new KeycloakAdminClient(makeConfig()).ensureGroupClaimScope('ghost', 'groups');

    expect(callsOf(fetchMock).some((call) => call.url.includes('/client-scopes'))).toBe(false);
  });

  it('reuses an existing scope rather than creating a duplicate', async () => {
    const fetchMock = realm({
      '/clients?clientId=shop': () => jsonResponse([{ id: 'uuid-1', clientId: 'shop' }]),
      '/client-scopes': () => jsonResponse([{ id: 'scope-9', name: 'groups' }]),
      '/default-client-scopes/scope-9': () => new Response(null, { status: 204 }),
    });

    await new KeycloakAdminClient(makeConfig()).ensureGroupClaimScope('shop', 'groups');

    const urls = callsOf(fetchMock).map((call) => `${call.init.method} ${call.url}`);
    expect(urls.some((entry) => entry.includes('POST') && entry.endsWith('/client-scopes'))).toBe(
      false,
    );
    expect(urls.some((entry) => entry.endsWith('/default-client-scopes/scope-9'))).toBe(true);
  });

  it('adds a group membership mapper to a scope it just created', async () => {
    let created = false;
    const fetchMock = realm({
      '/clients?clientId=shop': () => jsonResponse([{ id: 'uuid-1', clientId: 'shop' }]),
      '/client-scopes': (init) => {
        if (init.method === 'POST') {
          created = true;
          return new Response('', { status: 201 });
        }
        return jsonResponse(created ? [{ id: 'scope-new', name: 'groups' }] : []);
      },
      '/protocol-mappers/models': () => new Response('', { status: 201 }),
      '/default-client-scopes/scope-new': () => new Response(null, { status: 204 }),
    });

    await new KeycloakAdminClient(makeConfig()).ensureGroupClaimScope('shop', 'groups');

    const mapper = callsOf(fetchMock).find((call) => call.url.endsWith('/protocol-mappers/models'));
    expect(bodyOf(mapper)).toEqual({
      name: 'groups',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-group-membership-mapper',
      config: {
        'claim.name': 'groups',
        'full.path': 'true',
        'id.token.claim': 'true',
        'access.token.claim': 'true',
        'userinfo.token.claim': 'true',
        'jsonType.label': 'String',
      },
    });
  });

  it('fails loudly when the realm does not return the scope it just created', async () => {
    realm({
      '/clients?clientId=shop': () => jsonResponse([{ id: 'uuid-1', clientId: 'shop' }]),
      '/client-scopes': () => jsonResponse([]),
    });

    await expect(
      new KeycloakAdminClient(makeConfig()).ensureGroupClaimScope('shop', 'groups'),
    ).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('did not return the groups client scope'),
    });
  });
});

describe('deleteClient', () => {
  it('deletes a client that exists', async () => {
    const fetchMock = realm({
      '/clients?clientId=shop': () => jsonResponse([{ id: 'uuid-1', clientId: 'shop' }]),
      '/admin/realms/seamnex/clients/uuid-1': () => new Response(null, { status: 204 }),
    });

    await new KeycloakAdminClient(makeConfig()).deleteClient('shop');

    const del = callsOf(fetchMock).find((call) => call.init.method === 'DELETE');
    expect(del?.url).toBe('https://idp.example.test/admin/realms/seamnex/clients/uuid-1');
  });

  it('is a no-op for a client that is already gone', async () => {
    const fetchMock = realm({ '/clients?clientId=shop': () => jsonResponse([]) });
    await new KeycloakAdminClient(makeConfig()).deleteClient('shop');

    expect(callsOf(fetchMock).some((call) => call.init.method === 'DELETE')).toBe(false);
  });
});
