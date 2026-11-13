import { createPublicKey, type KeyObject } from 'node:crypto';
import { providerUnavailable, unauthorized } from '../identity-errors';

/**
 * The provider's signing keys, cached by `kid`.
 *
 * Rotation is the reason this is not a one-shot fetch: Keycloak publishes the new key before it
 * starts signing with it, so an unknown `kid` is normal traffic and must trigger a refetch. The
 * refetch is single-flight and rate-limited, because an attacker who can mint tokens with random
 * `kid` values would otherwise turn every attempt into a request against the identity provider.
 */
export type JwksOptions = {
  /** Resolved per fetch: the discovery document may refresh and move the address. */
  readonly url: () => Promise<string>;
  /** Minimum interval between refetches triggered by an unknown `kid`. */
  readonly minRefreshIntervalMs: number;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
};

type JwkDocument = { keys?: unknown };

export class JwksCache {
  private readonly keys = new Map<string, KeyObject>();
  /** Used only when the provider publishes a single key and stamps no `kid` (rare, but legal). */
  private anonymous: KeyObject | undefined;
  private fetchedAt = 0;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: JwksOptions) {}

  async keyFor(kid: string | undefined, alg: string): Promise<KeyObject> {
    if (kid !== undefined) {
      const known = this.keys.get(kid);
      if (known !== undefined) return assertKeyType(known, alg);
    } else if (this.fetchedAt > 0 && this.keys.size === 1 && this.anonymous !== undefined) {
      return assertKeyType(this.anonymous, alg);
    }

    // Unknown key: refresh, unless we refreshed too recently to learn anything new.
    const stale = Date.now() - this.fetchedAt >= this.options.minRefreshIntervalMs;
    if (this.fetchedAt === 0 || stale) await this.refresh();

    if (kid !== undefined) {
      const resolved = this.keys.get(kid);
      if (resolved !== undefined) return assertKeyType(resolved, alg);
      throw unauthorized();
    }
    if (this.anonymous !== undefined) return assertKeyType(this.anonymous, alg);
    // A token with no `kid` against a multi-key set cannot be resolved unambiguously; guessing
    // would accept a signature made by a key the platform did not select.
    throw unauthorized();
  }

  /** Forced refresh, used by the readiness probe and by tests. */
  async refresh(): Promise<void> {
    this.inFlight ??= this.fetchKeys().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  private async fetchKeys(): Promise<void> {
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const url = await this.options.url();

    let document: JwkDocument;
    try {
      const response = await doFetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
      document = (await response.json()) as JwkDocument;
    } catch (error) {
      throw providerUnavailable(
        `The identity provider's signing keys could not be read (${String(
          error instanceof Error ? error.message : error,
        )}).`,
      );
    }

    if (!Array.isArray(document.keys)) {
      throw providerUnavailable('The identity provider published no signing keys.');
    }

    // Replaced wholesale rather than merged: a key the provider withdrew must stop verifying.
    this.keys.clear();
    this.anonymous = undefined;
    for (const entry of document.keys) {
      const jwk = entry as { kty?: unknown; kid?: unknown; use?: unknown; alg?: unknown };
      if (typeof jwk.kty !== 'string') continue;
      // `use` is optional; when present, an encryption key is not a signing key.
      if (typeof jwk.use === 'string' && jwk.use !== 'sig') continue;
      let key: KeyObject;
      try {
        // The global `JsonWebKey` type belongs to the DOM lib, which this project does not load;
        // the runtime accepts the RFC 7517 members as they arrive from the provider.
        key = createPublicKey({ key: jwk, format: 'jwk' } as unknown as Parameters<
          typeof createPublicKey
        >[0]);
      } catch {
        // An entry this runtime cannot parse (an unsupported curve, a malformed modulus) is
        // skipped: one bad key must not take the whole set down.
        continue;
      }
      if (typeof jwk.kid === 'string' && jwk.kid.length > 0) this.keys.set(jwk.kid, key);
      else this.anonymous = key;
    }

    if (this.keys.size === 0 && this.anonymous === undefined) {
      throw providerUnavailable('The identity provider published no usable signing keys.');
    }
    this.fetchedAt = Date.now();
  }
}

/**
 * A key of the wrong family cannot verify the algorithm the token header names, and `crypto.verify`
 * would answer "false" without saying why. Naming the mismatch here turns an opaque refusal into a
 * diagnosable one.
 */
function assertKeyType(key: KeyObject, alg: string): KeyObject {
  const expected = alg.startsWith('ES') ? 'ec' : 'rsa';
  if (key.asymmetricKeyType !== expected) throw unauthorized();
  return key;
}
