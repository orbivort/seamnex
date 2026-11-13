import { afterEach, describe, expect, it, vi } from 'vitest';
import { OidcDiscovery } from '../../../../../src/common/identity/oidc/discovery';

/**
 * Two hostnames describe the same realm and they are not interchangeable: the browser must be sent
 * to the public issuer, while this process must reach the container address. Getting it wrong
 * produced the loop where Keycloak answers "Invalid token issuer" and nothing says why, so the
 * rebase is asserted endpoint by endpoint rather than left to configuration discipline.
 */
const ISSUER = 'http://localhost:8082/realms/seamnex';
const INTERNAL = 'http://keycloak:8080/realms/seamnex';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
    end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
    ...overrides,
  };
}

function answer(body: unknown, status = 200) {
  return vi.fn(
    async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
}

function discovery(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return new OidcDiscovery({
    issuer: ISSUER,
    internalBase: INTERNAL,
    cacheSeconds: 0,
    timeoutMs: 1_000,
    fetch,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('endpoint resolution', () => {
  it('rebases the endpoints the server calls onto the internal address', async () => {
    const endpoints = await discovery(answer(document())).endpoints();

    expect(endpoints).toEqual({
      issuer: ISSUER,
      // The browser follows the advertised host, never the container address.
      authorizationEndpoint: `${ISSUER}/protocol/openid-connect/auth`,
      endSessionEndpoint: `${ISSUER}/protocol/openid-connect/logout`,
      internal: {
        tokenEndpoint: `${INTERNAL}/protocol/openid-connect/token`,
        jwksUri: `${INTERNAL}/protocol/openid-connect/certs`,
      },
    });
  });

  it('uses the public issuer as the internal base when none is configured', async () => {
    const fetch = answer(document());

    const endpoints = await discovery(fetch, { internalBase: '' }).endpoints();

    expect(endpoints.internal.tokenEndpoint).toBe(`${ISSUER}/protocol/openid-connect/token`);
    // One round trip, to the address that was actually used.
    expect(fetch.mock.calls[0]?.[0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('leaves an endpoint outside the issuer untouched', async () => {
    // A provider that terminates a third-party endpoint must not have its host rewritten.
    const endpoints = await discovery(
      answer(document({ token_endpoint: 'https://elsewhere.example.test/token' })),
    ).endpoints();

    expect(endpoints.internal.tokenEndpoint).toBe('https://elsewhere.example.test/token');
  });

  it('reports a missing end-session endpoint as null, not as an empty string', async () => {
    const endpoints = await discovery(
      answer(document({ end_session_endpoint: undefined })),
    ).endpoints();

    expect(endpoints.endSessionEndpoint).toBeNull();
  });

  it('trims a trailing slash from the configured and advertised issuer', async () => {
    const endpoints = await discovery(answer(document({ issuer: `${ISSUER}/` })), {
      issuer: `${ISSUER}/`,
    }).endpoints();

    expect(endpoints.issuer).toBe(ISSUER);
  });
});

describe('caching', () => {
  it('reuses a document for the configured window', async () => {
    const fetch = answer(document());
    const client = discovery(fetch, { cacheSeconds: 60 });

    await client.endpoints();
    await client.endpoints();

    expect(fetch).toHaveBeenCalledOnce();
  });

  it('refetches immediately when the window is zero', async () => {
    const fetch = answer(document());
    const client = discovery(fetch, { cacheSeconds: 0 });

    await client.endpoints();
    await client.endpoints();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('costs one round trip for a burst of sign-ins after a cold start', async () => {
    const fetch = answer(document());
    const client = discovery(fetch, { cacheSeconds: 60 });

    const [first, second, third] = await Promise.all([
      client.endpoints(),
      client.endpoints(),
      client.endpoints(),
    ]);

    expect(fetch).toHaveBeenCalledOnce();
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('does not cache a failure', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(document()), { status: 200 }));
    const client = discovery(fetch, { cacheSeconds: 60 });

    await expect(client.endpoints()).rejects.toThrow(/discovery document could not be read/);
    await expect(client.endpoints()).resolves.toMatchObject({ issuer: ISSUER });
  });
});

describe('document validation', () => {
  it('refuses a document that describes a different realm', async () => {
    // Trusting it would validate tokens minted by a provider nobody meant to trust.
    await expect(
      discovery(
        answer(document({ issuer: 'https://evil.example.test/realms/seamnex' })),
      ).endpoints(),
    ).rejects.toThrow(/advertises issuer/);
  });

  it('refuses a document with no issuer at all', async () => {
    await expect(discovery(answer(document({ issuer: 42 }))).endpoints()).rejects.toThrow(
      /advertises issuer/,
    );
  });

  it('names the endpoint a document is missing', async () => {
    await expect(
      discovery(answer(document({ token_endpoint: undefined }))).endpoints(),
    ).rejects.toThrow(/no token_endpoint/);
    await expect(
      discovery(answer(document({ authorization_endpoint: '' }))).endpoints(),
    ).rejects.toThrow(/no authorization_endpoint/);
    await expect(discovery(answer(document({ jwks_uri: undefined }))).endpoints()).rejects.toThrow(
      /no jwks_uri/,
    );
  });

  it('wraps a transport failure as provider-unavailable, quoting the reason', async () => {
    const failure = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    await expect(discovery(failure).endpoints()).rejects.toThrow(/ECONNREFUSED/);
  });

  it('quotes a non-Error failure without losing it', async () => {
    const failure = vi.fn(async () => {
      throw 'socket closed';
    });

    await expect(discovery(failure).endpoints()).rejects.toThrow(/socket closed/);
  });

  it('uses the global fetch when none is injected', async () => {
    const fetch = answer(document());
    vi.stubGlobal('fetch', fetch);

    const endpoints = await new OidcDiscovery({
      issuer: ISSUER,
      internalBase: INTERNAL,
      cacheSeconds: 0,
      timeoutMs: 1_000,
    }).endpoints();

    expect(fetch).toHaveBeenCalledOnce();
    expect(endpoints.issuer).toBe(ISSUER);
  });
});
