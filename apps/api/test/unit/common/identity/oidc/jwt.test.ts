import {
  constants,
  createSecretKey,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { JwksCache } from '../../../../../src/common/identity/oidc/jwks';
import { verifyIdToken } from '../../../../../src/common/identity/oidc/jwt';

/**
 * The verification path is the only thing between a stranger's token and a platform session, so
 * these cases are the ones a reviewer should be able to read as a checklist: every rejection is a
 * claim an attacker would otherwise be able to make.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const ISSUER = 'https://idp.example.test/realms/seamnex';
const AUDIENCE = 'seamnex-platform-ui';
const NOW = 1_790_000_000_000;

const baseClaims = {
  iss: ISSUER,
  aud: AUDIENCE,
  azp: AUDIENCE,
  sub: 'user-1',
  iat: Math.floor(NOW / 1_000) - 10,
  exp: Math.floor(NOW / 1_000) + 300,
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signToken(
  claims: Record<string, unknown> = baseClaims,
  options: { header?: Record<string, unknown>; key?: KeyObject } = {},
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID, ...(options.header ?? {}) };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = signBytes(
    'sha256',
    Buffer.from(signingInput, 'utf8'),
    options.key ?? privateKey,
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}

const options = {
  issuer: ISSUER,
  audience: AUDIENCE,
  clockSkewSeconds: 60,
  keyFor: () => Promise.resolve(publicKey),
  now: () => NOW,
};

describe('ID token verification', () => {
  it('accepts a token this provider signed for this client', async () => {
    const claims = await verifyIdToken(signToken(), options);
    expect(claims.sub).toBe('user-1');
  });

  it('refuses a token signed by another key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(
      verifyIdToken(signToken(baseClaims, { key: other }), options),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses a tampered payload', async () => {
    const token = signToken();
    const [header, , signature] = token.split('.') as [string, string, string];
    const forged = `${header}.${encode({ ...baseClaims, sub: 'admin' })}.${signature}`;
    await expect(verifyIdToken(forged, options)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses an unsigned token, whatever its header claims', async () => {
    // `alg: none` is the classic downgrade: a verifier that trusts the header accepts anything.
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(baseClaims)}.`;
    await expect(verifyIdToken(unsigned, options)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses an HMAC algorithm even when the signature would check out', async () => {
    const token = signToken(baseClaims, { header: { alg: 'HS256' } });
    await expect(verifyIdToken(token, options)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a header that requires an extension this verifier does not implement', async () => {
    const token = signToken(baseClaims, { header: { crit: ['exp'] } });
    await expect(verifyIdToken(token, options)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses another issuer — the exact string, not a prefix match', async () => {
    for (const iss of [
      'https://evil.test/realms/seamnex',
      'https://idp.example.test/realms/f',
      'https://idp.example.test/realms/seamnex2',
    ]) {
      await expect(
        verifyIdToken(signToken({ ...baseClaims, iss }), options),
        iss,
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
  });

  it('tolerates a trailing slash on the issuer, which providers publish both ways', async () => {
    const claims = await verifyIdToken(signToken({ ...baseClaims, iss: `${ISSUER}/` }), options);
    expect(claims.iss).toBe(`${ISSUER}/`);
  });

  it('refuses a token minted for another client', async () => {
    const token = signToken({ ...baseClaims, aud: 'another-client', azp: 'another-client' });
    await expect(verifyIdToken(token, options)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('requires `azp` to name this client when the audience is shared', async () => {
    const shared = { ...baseClaims, aud: [AUDIENCE, 'another-client'], azp: 'another-client' };
    await expect(verifyIdToken(signToken(shared), options)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const ours = { ...baseClaims, aud: [AUDIENCE, 'another-client'], azp: AUDIENCE };
    await expect(verifyIdToken(signToken(ours), options)).resolves.toBeDefined();
  });

  it('refuses an expired token, but honours the clock skew', async () => {
    const expired = { ...baseClaims, exp: Math.floor(NOW / 1_000) - 61 };
    await expect(verifyIdToken(signToken(expired), options)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const justExpired = { ...baseClaims, exp: Math.floor(NOW / 1_000) - 30 };
    await expect(verifyIdToken(signToken(justExpired), options)).resolves.toBeDefined();
  });

  it('refuses a token issued in the future beyond the skew', async () => {
    const future = { ...baseClaims, iat: Math.floor(NOW / 1_000) + 120 };
    await expect(verifyIdToken(signToken(future), options)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses a token with no subject, or no issue/expiry at all', async () => {
    for (const claims of [
      { ...baseClaims, sub: '' },
      { ...baseClaims, sub: undefined },
      { ...baseClaims, exp: undefined },
    ]) {
      await expect(verifyIdToken(signToken(claims), options)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
  });

  it('refuses a malformed token rather than throwing', async () => {
    for (const token of ['', 'a.b', 'a.b.c.d.e', 'not-a-jwt']) {
      await expect(verifyIdToken(token, options)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });
});

describe('JWKS cache', () => {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

  function document(): { keys: Record<string, unknown>[] } {
    return { keys: [{ ...jwk, kid: KID, use: 'sig' }] };
  }

  it('resolves a key by `kid` and caches the document', async () => {
    let calls = 0;
    const cache = new JwksCache({
      url: () => Promise.resolve('https://idp.test/jwks'),
      minRefreshIntervalMs: 0,
      timeoutMs: 1_000,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify(document()), { status: 200 }));
      },
    });

    await cache.keyFor(KID, 'RS256');
    await cache.keyFor(KID, 'RS256');
    expect(calls).toBe(1);
  });

  it('refetches once for a rotated key, and refuses one it still does not know', async () => {
    let calls = 0;
    const cache = new JwksCache({
      url: () => Promise.resolve('https://idp.test/jwks'),
      minRefreshIntervalMs: 0,
      timeoutMs: 1_000,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify(document()), { status: 200 }));
      },
    });

    await cache.keyFor(KID, 'RS256');
    await expect(cache.keyFor('unknown-kid', 'RS256')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls).toBe(2);
  });

  it('rate-limits the refetch an unknown `kid` would otherwise trigger per attempt', async () => {
    let calls = 0;
    const cache = new JwksCache({
      url: () => Promise.resolve('https://idp.test/jwks'),
      minRefreshIntervalMs: 60_000,
      timeoutMs: 1_000,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify(document()), { status: 200 }));
      },
    });

    await cache.keyFor(KID, 'RS256');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(cache.keyFor(`kid-${attempt}`, 'RS256')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
    // One initial fetch and no refetch inside the window: a forged `kid` costs no round trip, and
    // a genuine rotation is picked up after the interval rather than on every token.
    expect(calls).toBe(1);
  });

  it('reports an unreachable key set as unavailable rather than as bad credentials', async () => {
    const cache = new JwksCache({
      url: () => Promise.resolve('https://idp.test/jwks'),
      minRefreshIntervalMs: 0,
      timeoutMs: 1_000,
      fetch: () => Promise.resolve(new Response('', { status: 503 })),
    });
    await expect(cache.keyFor(KID, 'RS256')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('signature algorithms and malformed input', () => {
  it('verifies a PS256 token with the RSA-PSS parameters the algorithm requires', async () => {
    const header = { alg: 'PS256', typ: 'JWT', kid: KID };
    const signingInput = `${encode(header)}.${encode(baseClaims)}`;
    const signature = signBytes('sha256', Buffer.from(signingInput, 'utf8'), {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    });

    const claims = await verifyIdToken(
      `${signingInput}.${signature.toString('base64url')}`,
      options,
    );
    expect(claims.sub).toBe('user-1');
  });

  it('refuses a token whose key cannot be used for the declared algorithm', async () => {
    const secret = createSecretKey(Buffer.from('not-an-rsa-key'));
    await expect(
      verifyIdToken(signToken(), { ...options, keyFor: () => Promise.resolve(secret) }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a header segment that is not JSON', async () => {
    await expect(verifyIdToken('%%%%.e30.c2ln', options)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses a token with the wrong number of segments', async () => {
    for (const token of ['', 'a.b', 'a.b.c.d.e']) {
      await expect(verifyIdToken(token, options), token).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
  });

  it('refuses a non-string issuer and a non-numeric expiry', async () => {
    await expect(
      verifyIdToken(signToken({ ...baseClaims, iss: 123 }), options),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await expect(
      verifyIdToken(signToken({ ...baseClaims, exp: '9999999999' }), options),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('header handling and key selection', () => {
  it('treats an empty kid as absent rather than as a key name', async () => {
    const keyFor = vi.fn(async () => publicKey as KeyObject);

    await verifyIdToken(signToken(baseClaims, { header: { kid: '' } }), { ...options, keyFor });

    expect(keyFor).toHaveBeenCalledWith(undefined, 'RS256');
  });

  it('refuses a signed token whose payload is not JSON', async () => {
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: KID });
    const payload = Buffer.from('not json at all', 'utf8').toString('base64url');
    const signingInput = `${header}.${payload}`;
    const signature = signBytes('sha256', Buffer.from(signingInput, 'utf8'), privateKey).toString(
      'base64url',
    );

    await expect(verifyIdToken(`${signingInput}.${signature}`, options)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('verifies an ES256 token with an EC key', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const header = encode({ alg: 'ES256', typ: 'JWT', kid: KID });
    const payload = encode(baseClaims);
    const signingInput = `${header}.${payload}`;
    const signature = signBytes('sha256', Buffer.from(signingInput, 'utf8'), {
      key: ec.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');

    await expect(
      verifyIdToken(`${signingInput}.${signature}`, {
        ...options,
        keyFor: () => Promise.resolve(ec.publicKey),
      }),
    ).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('refuses an EC key presented for an RSA algorithm', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });

    await expect(
      verifyIdToken(signToken(), { ...options, keyFor: () => Promise.resolve(ec.publicKey) }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('additional claim guarantees', () => {
  it('refuses a token whose azp names a different client', async () => {
    await expect(
      verifyIdToken(signToken({ ...baseClaims, azp: 'another-client' }), options),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts a token that carries no azp at all', async () => {
    const { azp: _azp, ...withoutAzp } = baseClaims;
    await expect(verifyIdToken(signToken(withoutAzp), options)).resolves.toMatchObject({
      sub: 'user-1',
    });
  });

  it('refuses an nbf that is not a number', async () => {
    await expect(
      verifyIdToken(signToken({ ...baseClaims, nbf: 'soon' }), options),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses an nbf in the future beyond the skew', async () => {
    await expect(
      verifyIdToken(signToken({ ...baseClaims, nbf: Math.floor(NOW / 1_000) + 600 }), options),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts a not-yet-valid-by-less-than-the-skew token', async () => {
    await expect(
      verifyIdToken(signToken({ ...baseClaims, nbf: Math.floor(NOW / 1_000) + 10 }), options),
    ).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('refuses a token with no subject', async () => {
    await expect(
      verifyIdToken(signToken({ ...baseClaims, sub: '' }), options),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a token issued in the future beyond the skew', async () => {
    await expect(
      verifyIdToken(signToken({ ...baseClaims, iat: Math.floor(NOW / 1_000) + 600 }), options),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a token with no issue time', async () => {
    await expect(
      verifyIdToken(signToken({ ...baseClaims, iat: 'yesterday' }), options),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
