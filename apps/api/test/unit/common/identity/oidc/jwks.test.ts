import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { JwksCache } from '../../../../../src/common/identity/oidc/jwks';

/**
 * The signing-key cache exists because of rotation: Keycloak publishes a new key before signing
 * with it, so an unknown `kid` is normal traffic. It is rate-limited and single-flight because an
 * attacker who mints tokens with random `kid` values would otherwise turn every attempt into a
 * request against the identity provider.
 */
const { publicKey: rsaPublic } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_JWK = rsaPublic.export({ format: 'jwk' }) as Record<string, unknown>;

function signingKey(kid: string, overrides: Record<string, unknown> = {}) {
  return { ...RSA_JWK, kid, use: 'sig', alg: 'RS256', ...overrides };
}

/**
 * An entry this runtime cannot parse. A malformed modulus is accepted by `createPublicKey`, so the
 * failure has to come from the curve name — which is what an unrelated provider's key looks like.
 */
const UNPARSEABLE = { kty: 'EC', kid: 'malformed', crv: 'not-a-curve', x: 'AA', y: 'AA' };

function answer(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function cache(fetch: typeof globalThis.fetch, minRefreshIntervalMs = 0) {
  return new JwksCache({
    url: async () => 'https://idp.example.test/realms/seamnex/protocol/openid-connect/certs',
    minRefreshIntervalMs,
    timeoutMs: 1_000,
    fetch,
  });
}

describe('key lookup', () => {
  it('resolves a published key on the first call', async () => {
    const client = cache(answer({ keys: [signingKey('k1')] }));

    const key = await client.keyFor('k1', 'RS256');

    expect(key.asymmetricKeyType).toBe('rsa');
  });

  it('answers a known key from memory without a second round trip', async () => {
    const fetch = answer({ keys: [signingKey('k1')] });
    const client = cache(fetch);

    await client.keyFor('k1', 'RS256');
    await client.keyFor('k1', 'RS256');

    expect(fetch).toHaveBeenCalledOnce();
  });

  it('refetches once for a rotated key', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [signingKey('k1')] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [signingKey('k2')] })));
    const client = cache(fetch);

    await client.keyFor('k1', 'RS256');
    await expect(client.keyFor('k2', 'RS256')).resolves.toMatchObject({
      asymmetricKeyType: 'rsa',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops serving a key the provider withdrew', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [signingKey('k1')] })))
      // From the rotation onwards the provider publishes only the new key. A fresh response per
      // call: a `Response` body can only be read once.
      .mockImplementation(async () =>
        Promise.resolve(new Response(JSON.stringify({ keys: [signingKey('k2')] }))),
      );
    const client = cache(fetch);

    await client.keyFor('k1', 'RS256');
    await client.keyFor('k2', 'RS256');

    // Replaced wholesale, not merged: a withdrawn key must stop verifying.
    await expect(client.keyFor('k1', 'RS256')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses an unknown key when it refreshed too recently to learn anything new', async () => {
    const fetch = answer({ keys: [signingKey('k1')] });
    const client = cache(fetch, 60_000);

    await client.keyFor('k1', 'RS256');

    // A random `kid` must not become a request per attempt.
    await expect(client.keyFor('k-unknown', 'RS256')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('costs one round trip for a burst of unknown keys', async () => {
    const fetch = answer({ keys: [signingKey('k1')] });
    const client = cache(fetch);

    const results = await Promise.allSettled([
      client.keyFor('a', 'RS256'),
      client.keyFor('b', 'RS256'),
      client.keyFor('c', 'RS256'),
    ]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('keys published without a kid', () => {
  it('resolves the single anonymous key', async () => {
    const fetch = answer({ keys: [{ ...RSA_JWK, use: 'sig' }] });
    const client = cache(fetch, 60_000);

    await expect(client.keyFor(undefined, 'RS256')).resolves.toMatchObject({
      asymmetricKeyType: 'rsa',
    });
    // The second call is answered without another round trip.
    await expect(client.keyFor(undefined, 'RS256')).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('refuses to guess among several keys', async () => {
    // A token with no `kid` against a multi-key set cannot name a key; guessing would accept a
    // signature made by a key the platform did not select.
    const client = cache(answer({ keys: [signingKey('k1'), signingKey('k2')] }));

    await expect(client.keyFor(undefined, 'RS256')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses when the published set contains no anonymous key either', async () => {
    const client = cache(answer({ keys: [signingKey('k1')] }));

    await expect(client.keyFor(undefined, 'RS256')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('document handling', () => {
  it('skips entries a relying party cannot use', async () => {
    const client = cache(
      answer({
        keys: [
          { kid: 'no-kty', n: 'x', e: 'AQAB' },
          signingKey('enc-only', { use: 'enc' }),
          UNPARSEABLE,
          signingKey('good'),
        ],
      }),
    );

    await expect(client.keyFor('good', 'RS256')).resolves.toBeDefined();
    // The unusable entries are skipped rather than failing the whole set.
    for (const kid of ['no-kty', 'enc-only', 'malformed']) {
      await expect(client.keyFor(kid, 'RS256')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('refuses a document with no key array', async () => {
    await expect(cache(answer({ keys: 'soon' })).keyFor('k1', 'RS256')).rejects.toThrow(
      /published no signing keys/,
    );
  });

  it('refuses a set with no usable key', async () => {
    await expect(cache(answer({ keys: [UNPARSEABLE] })).keyFor('k1', 'RS256')).rejects.toThrow(
      /no usable signing keys/,
    );
  });

  it('wraps a transport failure, quoting the reason', async () => {
    const failure = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND idp');
    });

    await expect(cache(failure).keyFor('k1', 'RS256')).rejects.toThrow(/ENOTFOUND/);
  });

  it('quotes a non-Error transport failure', async () => {
    const failure = vi.fn(async () => {
      throw 'socket hang up';
    });

    await expect(cache(failure).keyFor('k1', 'RS256')).rejects.toThrow(/socket hang up/);
  });

  it('reports a non-2xx answer as provider-unavailable', async () => {
    await expect(cache(answer({}, 502)).keyFor('k1', 'RS256')).rejects.toThrow(/JWKS answered 502/);
  });
});

describe('algorithm and key family', () => {
  it('resolves an EC key for ES256', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = ec.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const client = cache(answer({ keys: [{ ...jwk, kid: 'ec-1', use: 'sig' }] }));

    await expect(client.keyFor('ec-1', 'ES256')).resolves.toMatchObject({
      asymmetricKeyType: 'ec',
    });
  });

  it('refuses an RSA key for an EC algorithm', async () => {
    // `crypto.verify` would answer "false" without saying why; naming the mismatch makes it
    // diagnosable instead of an opaque refusal.
    const client = cache(answer({ keys: [signingKey('k1')] }));

    await expect(client.keyFor('k1', 'ES256')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses an EC key for an RSA algorithm', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = ec.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const client = cache(answer({ keys: [{ ...jwk, kid: 'ec-1', use: 'sig' }] }));

    await expect(client.keyFor('ec-1', 'RS256')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
