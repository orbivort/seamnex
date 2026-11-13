import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../../../../src/config/config';
import { challengeFor } from '../../../../../src/common/identity/pkce';
import { OidcDiscovery } from '../../../../../src/common/identity/oidc/discovery';
import { OidcIdentityProvider } from '../../../../../src/common/identity/oidc/oidc-identity.provider';

/**
 * The exchange against a provider that answers over HTTP, with the network faked and everything
 * else real: the PKCE check, the redirect check, the JWT verification, the claim mapping and the
 * assurance policy. Only the transport is synthetic, so a failure here is a failure in the relying
 * party rather than in the test's imagination.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ISSUER = 'http://localhost:8082/realms/seamnex';
const INTERNAL = 'http://keycloak:8080/realms/seamnex';
const CLIENT = 'seamnex-platform-ui';
const REDIRECT = 'http://localhost:5173/sign-in';

const config: AppConfig = loadConfig({
  DATABASE_URL: 'postgres://seamnex:secret@localhost:5432/seamnex',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_PROVIDER: 'oidc',
  AUTH_ISSUER_URL: ISSUER,
  AUTH_INTERNAL_URL: INTERNAL,
  AUTH_CLIENT_ID: CLIENT,
});

const endpoints = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/protocol/openid-connect/auth`,
  endSessionEndpoint: `${ISSUER}/protocol/openid-connect/logout`,
  internal: {
    tokenEndpoint: `${INTERNAL}/protocol/openid-connect/token`,
    jwksUri: `${INTERNAL}/protocol/openid-connect/certs`,
  },
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function idToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1_000);
  const claims = {
    iss: ISSUER,
    aud: CLIENT,
    azp: CLIENT,
    sub: 'cee4c1a0-0000-4000-8000-000000000001',
    preferred_username: 'dev-owner',
    name: 'Revenue Owner',
    email: 'dev-owner@seamnex.local',
    realm_access: { roles: ['R3'] },
    groups: ['/seamnex-domain-owners'],
    amr: ['pwd'],
    iat: now - 5,
    exp: now + 300,
    ...overrides,
  };
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key' };
  const input = `${encode(header)}.${encode(claims)}`;
  const signature = signBytes('sha256', Buffer.from(input, 'utf8'), privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

function provider(handler: (url: string, init?: RequestInit) => Response): OidcIdentityProvider {
  return new OidcIdentityProvider({
    config,
    discovery: { endpoints: () => Promise.resolve(endpoints) },
    keys: { keyFor: () => Promise.resolve(publicKey), refresh: () => Promise.resolve() },
    fetch: (input, init) => Promise.resolve(handler(String(input), init)),
  });
}

function tokenResponse(token: string): Response {
  return new Response(JSON.stringify({ id_token: token, access_token: 'ignored' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const verifier = 'v'.repeat(43);
const input = {
  code: 'authorization-code',
  codeVerifier: verifier,
  codeChallenge: challengeFor(verifier),
  redirectUri: REDIRECT,
  mfaCode: undefined,
};

describe('OIDC exchange', () => {
  it('redeems the code, verifies the token and maps the claims', async () => {
    const identity = await provider(() => tokenResponse(idToken())).exchangeCode(input);
    expect(identity.sub).toBe('cee4c1a0-0000-4000-8000-000000000001');
    expect(identity.username).toBe('dev-owner');
    expect(identity.roles).toEqual(['R3']);
    expect(identity.groups).toEqual(['/seamnex-domain-owners']);
  });

  it('posts the verifier, the redirect URI and the code to the *internal* token endpoint', async () => {
    let seen: { url: string; body: string } | undefined;
    await provider((url, init) => {
      seen = { url, body: String(init?.body ?? '') };
      return tokenResponse(idToken());
    }).exchangeCode(input);

    expect(seen?.url).toBe(endpoints.internal.tokenEndpoint);
    const body = new URLSearchParams(seen?.body ?? '');
    expect(body.get('code_verifier')).toBe(verifier);
    expect(body.get('redirect_uri')).toBe(REDIRECT);
    expect(body.get('client_secret')).toBeNull();
  });

  it('refuses a verifier that does not match the challenge before calling the provider', async () => {
    let called = false;
    const relied = provider(() => {
      called = true;
      return tokenResponse(idToken());
    });
    await expect(
      relied.exchangeCode({ ...input, codeChallenge: challengeFor('w'.repeat(43)) }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(called).toBe(false);
  });

  it('refuses a redirect URI outside the registered origins and paths', async () => {
    for (const redirectUri of [
      'https://evil.test/sign-in',
      `${REDIRECT}?next=/admin`,
      'http://localhost:5173/admin',
    ]) {
      await expect(
        provider(() => tokenResponse(idToken())).exchangeCode({ ...input, redirectUri }),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
  });

  it('reports a refused exchange as a credential failure', async () => {
    const refused = provider(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(refused.exchangeCode(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('reports an unreachable provider as unavailable, not as a bad credential', async () => {
    const down = provider(() => new Response('', { status: 503 }));
    await expect(down.exchangeCode(input)).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    const unreachable = new OidcIdentityProvider({
      config,
      discovery: { endpoints: () => Promise.resolve(endpoints) },
      keys: { keyFor: () => Promise.resolve(publicKey), refresh: () => Promise.resolve() },
      fetch: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });
    await expect(unreachable.exchangeCode(input)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('refuses a token response with no ID token', async () => {
    const noToken = provider(() => new Response('{"access_token":"x"}', { status: 200 }));
    await expect(noToken.exchangeCode(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses an R1 session the provider explicitly says used a password only', async () => {
    const passwordOnly = idToken({ realm_access: { roles: ['R1'] }, amr: ['pwd'] });
    await expect(
      provider(() => tokenResponse(passwordOnly)).exchangeCode(input),
    ).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
  });

  it('keeps an R1 session whose token says nothing about methods, and records it as unasserted', async () => {
    // The realm's browser flow enforces the factor; the token not saying so must not become a
    // lockout. The PDP gate refuses the step-up capabilities on the resulting session instead.
    const silent = idToken({ realm_access: { roles: ['R1'] }, amr: [] });
    const identity = await provider(() => tokenResponse(silent)).exchangeCode(input);
    expect(identity.mfaSatisfied).toBe(false);
    expect(identity.mfaAsserted).toBe(false);
  });

  it('exposes browser-facing URLs and keeps the internal token endpoint out of the payload', async () => {
    const auth = await provider(() => tokenResponse(idToken())).authConfig();
    expect(auth.authorizeUrl).toBe(endpoints.authorizationEndpoint);
    expect(auth.endSessionUrl).toBe(endpoints.endSessionEndpoint);
    expect(JSON.stringify(auth)).not.toContain('keycloak:8080');
    expect(auth.clientId).toBe(CLIENT);
    expect(auth.redirectPath).toBe('/sign-in');
  });
});

describe('the module surfaces the provider does or does not have', () => {
  function wired(options: Partial<ConstructorParameters<typeof OidcIdentityProvider>[0]>) {
    return new OidcIdentityProvider({
      config,
      discovery: { endpoints: () => Promise.resolve(endpoints) },
      keys: { keyFor: () => Promise.resolve(publicKey), refresh: () => Promise.resolve() },
      ...options,
    });
  }

  it('mirrors through the injected directory reader', async () => {
    const snapshot = { users: [], groups: [] };
    const wiredProvider = wired({ directory: () => Promise.resolve(snapshot) });

    await expect(wiredProvider.directory()).resolves.toBe(snapshot);
  });

  it('refuses to mirror when no reader is wired', async () => {
    // Reporting an empty directory would make the mirror delete every account it knows.
    await expect(wired({}).directory()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('writes a disable through the admin client', async () => {
    let seen: [string, boolean] | undefined;
    const admin = {
      setUserEnabled: (sub: string, enabled: boolean) => {
        seen = [sub, enabled];
        return Promise.resolve();
      },
    };

    await wired({ admin }).setUserEnabled('cee4c1a0-0000-4000-8000-000000000001', false);

    expect(seen).toEqual(['cee4c1a0-0000-4000-8000-000000000001', false]);
  });

  it('refuses a disable it cannot write, instead of reporting success the next sync erases', async () => {
    await expect(wired({}).setUserEnabled('sub', false)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('has no logout URL of its own: the SPA sends client_id and the redirect', () => {
    expect(wired({}).logoutUrl()).toBeNull();
  });

  it('reports reachability for the probe, and an unreachable provider as false rather than throwing', async () => {
    await expect(wired({}).reachable()).resolves.toBe(true);
    await expect(
      wired({
        discovery: {
          endpoints: () => Promise.reject(new Error('connect ECONNREFUSED')),
        },
      }).reachable(),
    ).resolves.toBe(false);
  });
});

describe('the default wiring', () => {
  it('builds its own discovery and key cache, and reads the JWKS through the internal address', async () => {
    // With no injected discovery or keys the provider must still be able to sign someone in: this
    // is the path production takes, and it is the only one where `jwksUri()` is used.
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const urls: string[] = [];
    const stand = new OidcIdentityProvider({
      config,
      fetch: (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('.well-known')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                issuer: ISSUER,
                authorization_endpoint: endpoints.authorizationEndpoint,
                token_endpoint: endpoints.internal.tokenEndpoint,
                jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
                end_session_endpoint: endpoints.endSessionEndpoint,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith('/certs')) {
          return Promise.resolve(
            new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', use: 'sig' }] }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(tokenResponse(idToken()));
      },
    });

    const identity = await stand.exchangeCode(input);

    expect(identity.sub).toBe('cee4c1a0-0000-4000-8000-000000000001');
    expect(urls).toContain(`${INTERNAL}/protocol/openid-connect/certs`);
  });
});

describe('the token request', () => {
  it('sends the client secret when the client is confidential', async () => {
    // A public client authenticates with PKCE alone; presenting a secret it does not have is an
    // `invalid_client` that reads like a bad credential to everyone who sees it.
    const confidential = loadConfig({
      DATABASE_URL: 'postgres://seamnex:secret@localhost:5432/seamnex',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_PROVIDER: 'oidc',
      AUTH_ISSUER_URL: ISSUER,
      AUTH_INTERNAL_URL: INTERNAL,
      AUTH_CLIENT_ID: CLIENT,
      AUTH_CLIENT_SECRET: 'confidential-secret',
    });
    let body: URLSearchParams | undefined;

    await new OidcIdentityProvider({
      config: confidential,
      discovery: { endpoints: () => Promise.resolve(endpoints) },
      keys: { keyFor: () => Promise.resolve(publicKey), refresh: () => Promise.resolve() },
      fetch: (_input, init) => {
        body = new URLSearchParams(String(init?.body ?? ''));
        return Promise.resolve(tokenResponse(idToken()));
      },
    }).exchangeCode(input);

    expect(body?.get('client_secret')).toBe('confidential-secret');
  });

  it('treats 429 as an outage rather than as a bad credential', async () => {
    const limited = provider(() => new Response('', { status: 429 }));
    await expect(limited.exchangeCode(input)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('refuses a token response that is not JSON', async () => {
    const garbled = provider(() => new Response('<html>gateway</html>', { status: 200 }));
    await expect(garbled.exchangeCode(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('quotes a non-Error transport failure', async () => {
    const broken = new OidcIdentityProvider({
      config,
      discovery: { endpoints: () => Promise.resolve(endpoints) },
      keys: { keyFor: () => Promise.resolve(publicKey), refresh: () => Promise.resolve() },
      fetch: () => Promise.reject('socket hang up'),
    });

    await expect(broken.exchangeCode(input)).rejects.toThrow(/socket hang up/);
  });
});

describe('discovery', () => {
  const document = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
    end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
  };

  function discovery(respond: () => Response): OidcDiscovery {
    return new OidcDiscovery({
      issuer: ISSUER,
      internalBase: INTERNAL,
      cacheSeconds: 0,
      timeoutMs: 1_000,
      fetch: () => Promise.resolve(respond()),
    });
  }

  it('fetches from the internal address and rewrites only the endpoints it calls itself', async () => {
    let fetched = '';
    const resolved = await new OidcDiscovery({
      issuer: ISSUER,
      internalBase: INTERNAL,
      cacheSeconds: 60,
      timeoutMs: 1_000,
      fetch: (input) => {
        fetched = String(input);
        return Promise.resolve(new Response(JSON.stringify(document), { status: 200 }));
      },
    }).endpoints();

    expect(fetched).toBe(`${INTERNAL}/.well-known/openid-configuration`);
    // The browser must be sent to the host it can resolve; the process uses the container name.
    expect(resolved.authorizationEndpoint).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(resolved.internal.tokenEndpoint).toBe(`${INTERNAL}/protocol/openid-connect/token`);
    expect(resolved.internal.jwksUri).toBe(`${INTERNAL}/protocol/openid-connect/certs`);
  });

  it('refuses a document whose issuer is not the configured one', async () => {
    const wrong = discovery(
      () =>
        new Response(JSON.stringify({ ...document, issuer: 'http://evil.test/realms/seamnex' })),
    );
    await expect(wrong.endpoints()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('reports an unreachable discovery document as unavailable', async () => {
    await expect(
      discovery(() => new Response('', { status: 502 })).endpoints(),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});
