import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { JwksCache } from '../../../../../src/common/identity/oidc/jwks';

/**
 * Two behaviours the rotation story depends on but the happy path never shows:
 *
 * - a provider may publish a keyed set *and* an unkeyed key (Keycloak does this for realms that
 *   were re-created), so a token without a `kid` must still resolve when exactly one key is
 *   anonymous — otherwise every such token is refused as unresolvable;
 * - a failed refetch must leave the keys already known in place, because the alternative is that a
 *   five-second provider outage refuses every token the platform could still verify.
 */
const { publicKey: rsaPublic } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_JWK = rsaPublic.export({ format: 'jwk' }) as Record<string, unknown>;

function keyed(kid: string): Record<string, unknown> {
  return { ...RSA_JWK, kid, use: 'sig', alg: 'RS256' };
}

function unkeyed(): Record<string, unknown> {
  return { ...RSA_JWK, use: 'sig', alg: 'RS256' };
}

function answer(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function cache(fetch: typeof globalThis.fetch, minRefreshIntervalMs = 60_000) {
  return new JwksCache({
    url: async () => 'https://idp.example.test/realms/seamnex/protocol/openid-connect/certs',
    minRefreshIntervalMs,
    timeoutMs: 1_000,
    fetch,
  });
}

describe('a set with one keyed and one unkeyed key', () => {
  const document = { keys: [keyed('k1'), unkeyed()] };

  it('resolves a token with no kid from the anonymous key without another round trip', async () => {
    const fetch = answer(document);
    const client = cache(fetch);

    await client.keyFor('k1', 'RS256');
    const anonymous = await client.keyFor(undefined, 'RS256');

    expect(anonymous.asymmetricKeyType).toBe('rsa');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('still refuses the anonymous key for an algorithm it cannot verify', async () => {
    const client = cache(answer(document));

    await client.keyFor('k1', 'RS256');

    await expect(client.keyFor(undefined, 'ES256')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('refresh', () => {
  it('shares one round trip between concurrent callers and fetches again afterwards', async () => {
    const fetch = answer({ keys: [keyed('k1')] });
    const client = cache(fetch);

    await Promise.all([client.refresh(), client.refresh()]);
    expect(fetch).toHaveBeenCalledOnce();

    // `inFlight` is cleared in a `finally`, so the next forced refresh is not answered from a
    // promise that already settled.
    await client.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps serving the keys it already knows when a refetch fails', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [keyed('k1')] })))
      .mockImplementation(async () => new Response('', { status: 503 }));
    const client = cache(fetch);

    await client.keyFor('k1', 'RS256');
    await expect(client.refresh()).rejects.toThrow(/JWKS answered 503/);

    // The set is replaced wholesale only after a successful read, so the key survives the outage.
    await expect(client.keyFor('k1', 'RS256')).resolves.toMatchObject({ asymmetricKeyType: 'rsa' });
  });
});
