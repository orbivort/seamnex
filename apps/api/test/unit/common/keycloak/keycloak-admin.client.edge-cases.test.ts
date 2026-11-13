import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { jsonResponse } from '../../../support/fakes';
import { KeycloakAdminClient } from '../../../../src/common/keycloak/keycloak-admin.client';

/**
 * Two arms the registration path needs and the happy path does not reach:
 *
 * - a client that does **not** exist yet must get the group-claim scope too. The scope used to be
 *   assigned only on the update branch, so the first registration of a product with an essential
 *   group claim produced a client whose tokens never carried the claim — and the next run "fixed"
 *   it, which made the failure look intermittent;
 * - the admin token is cached until 30 s before expiry, and never for less than 30 s. A realm that
 *   hands out a 10-second token must not turn every call into a token round trip.
 */
const ADMIN_URL = 'https://idp.example.test';
const REALM = 'seamnex';

const tempDirs: string[] = [];

function secretFile(secret: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-kc-edge-'));
  tempDirs.push(dir);
  const path = join(dir, 'admin-secret');
  writeFileSync(path, `${secret}\n`, 'utf8');
  return path;
}

afterEach(() => {
  vi.useRealTimers();
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
type Route = readonly [fragment: string, answer: (init: RequestInit) => Response];

/**
 * A realm stand-in, ordered most-specific-first: `/default-client-scopes/x` contains the fragment
 * `/client-scopes`, so an unordered matcher would answer the wrong request and the test would pass
 * on the wrong body.
 */
function realm(
  routes: readonly Route[],
  token: () => Response = () => jsonResponse({ access_token: 'admin-token', expires_in: 300 }),
): ReturnType<typeof vi.fn> {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/protocol/openid-connect/token')) return token();
    for (const [fragment, answer] of routes) if (url.includes(fragment)) return answer(init);
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

const SPEC = {
  clientId: 'shop',
  redirectUris: ['https://shop.test/callback'],
  protocol: 'oidc' as const,
  accessTokenLifespanSeconds: 300,
  offlineAccessDisabled: false,
  secret: 'client-secret',
  groupClaim: 'essential-groups',
};

describe('upsertClient when the client does not exist yet', () => {
  it('assigns the group claim scope after creating it', async () => {
    let registered = false;
    let scopeCreated = false;
    const fetchMock = realm([
      [
        '/clients?clientId=shop',
        () => jsonResponse(registered ? [{ id: 'uuid-1', clientId: 'shop' }] : []),
      ],
      [
        '/admin/realms/seamnex/clients',
        () => {
          registered = true;
          return new Response('', { status: 201 });
        },
      ],
      [
        '/client-scopes',
        (init) => {
          if (init.method === 'POST') {
            scopeCreated = true;
            return new Response('', { status: 201 });
          }
          return jsonResponse(scopeCreated ? [{ id: 'scope-1', name: 'essential-groups' }] : []);
        },
      ],
      ['/protocol-mappers/models', () => new Response('', { status: 201 })],
      ['/default-client-scopes/scope-1', () => new Response(null, { status: 204 })],
    ]);

    const result = await new KeycloakAdminClient(makeConfig()).upsertClient(SPEC);

    expect(result).toEqual({ clientId: 'shop', created: true });

    const calls = callsOf(fetchMock);
    const create = calls.find(
      (call) => call.init.method === 'POST' && call.url.endsWith('/admin/realms/seamnex/clients'),
    );
    expect(bodyOf(create)).toMatchObject({ clientId: 'shop', protocol: 'openid-connect' });

    const scope = calls.find(
      (call) => call.init.method === 'POST' && call.url.endsWith('/client-scopes'),
    );
    expect(bodyOf(scope)).toEqual({
      name: 'essential-groups',
      protocol: 'openid-connect',
      attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'false' },
    });

    // The scope is only useful once the client is assigned it; the mapper alone mints nothing.
    expect(
      calls.some(
        (call) =>
          call.init.method === 'PUT' &&
          call.url.endsWith('/clients/uuid-1/default-client-scopes/scope-1'),
      ),
    ).toBe(true);
  });

  it('does not mistake a client whose id merely contains the requested one', async () => {
    const fetchMock = realm([
      ['/clients?clientId=shop', () => jsonResponse([{ id: 'uuid-9', clientId: 'shop-2' }])],
      ['/admin/realms/seamnex/clients', () => new Response('', { status: 201 })],
    ]);

    // The claim is *absent*, not `undefined`: `exactOptionalPropertyTypes` rejects the latter, and
    // the client branches on `spec.groupClaim !== undefined`, so both spellings reach the same arm.
    const { groupClaim: _omitted, ...withoutGroupClaim } = SPEC;
    const result = await new KeycloakAdminClient(makeConfig()).upsertClient(withoutGroupClaim);

    expect(result).toEqual({ clientId: 'shop', created: true });
    // `shop-2` is a different client: updating it would rewrite somebody else's registration.
    expect(callsOf(fetchMock).some((call) => call.url.includes('uuid-9'))).toBe(false);
  });
});

describe('admin token caching', () => {
  it('re-requests the token once it is within 30 s of expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const fetchMock = realm([['/admin/realms/seamnex/users', () => jsonResponse([])]]);
    const client = new KeycloakAdminClient(makeConfig());

    await client.adminJson('/users');
    await client.adminJson('/users');
    expect(callsOf(fetchMock).filter((call) => call.url.includes('/token'))).toHaveLength(1);

    // 300 s of validity is cached for 270 s, so the client never presents a token that expires
    // mid-request.
    await vi.advanceTimersByTimeAsync(271_000);
    await client.adminJson('/users');
    expect(callsOf(fetchMock).filter((call) => call.url.includes('/token'))).toHaveLength(2);
  });

  it('never caches a short-lived token for less than 30 s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const fetchMock = realm([['/admin/realms/seamnex/users', () => jsonResponse([])]], () =>
      jsonResponse({ access_token: 'admin-token', expires_in: 10 }),
    );
    const client = new KeycloakAdminClient(makeConfig());

    await client.adminJson('/users');
    await vi.advanceTimersByTimeAsync(29_000);
    await client.adminJson('/users');

    // A 10-second token would otherwise be re-requested on every call.
    expect(callsOf(fetchMock).filter((call) => call.url.includes('/token'))).toHaveLength(1);
  });
});
