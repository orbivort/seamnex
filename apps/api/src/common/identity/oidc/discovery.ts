import { providerUnavailable } from '../identity-errors';

/**
 * The provider's endpoint set, in both addresses it has.
 *
 * Two hostnames describe the same realm and they are not interchangeable:
 *
 *   - the *public* one is what the browser is sent to and what the ID token's `iss` says. In the
 *     development stack Keycloak runs with `KC_HOSTNAME=http://localhost:8082`, so every URL it
 *     advertises carries that host — which a container cannot resolve;
 *   - the *internal* one is how this process reaches the same realm (`http://keycloak:8080/realms/seamnex`).
 *
 * The document is fetched from the internal address, its `issuer` must equal the public one, and
 * the endpoints the server itself calls are rebased onto the internal address. Getting this wrong
 * produces the loop where Keycloak answers "Invalid token issuer. Expected …" and nothing says
 * why, so the split is validated here rather than left to configuration discipline.
 */
export type OidcEndpoints = {
  /** The public issuer, trailing slash removed: the value `iss` must carry. */
  readonly issuer: string;
  /** Browser-facing endpoints exactly as advertised. */
  readonly authorizationEndpoint: string;
  readonly endSessionEndpoint: string | null;
  /** Callable from this process. */
  readonly internal: {
    readonly tokenEndpoint: string;
    readonly jwksUri: string;
  };
};

export type OidcDiscoveryOptions = {
  /** The public issuer: the `iss` an ID token must carry, and the browser-facing base. */
  readonly issuer: string;
  /** The address this process uses for the same realm. Empty means "same as the issuer". */
  readonly internalBase: string;
  /** How long a fetched document is trusted. Zero refetches per call (tests, rotation drills). */
  readonly cacheSeconds: number;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
};

export class OidcDiscovery {
  private cached: { endpoints: OidcEndpoints; at: number } | undefined;
  private inFlight: Promise<OidcEndpoints> | undefined;

  constructor(private readonly options: OidcDiscoveryOptions) {}

  /** Cached after the first successful fetch; a failure is never cached. */
  async endpoints(): Promise<OidcEndpoints> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.cached.at < this.options.cacheSeconds * 1_000) {
      return this.cached.endpoints;
    }
    // Single flight: a burst of sign-ins after a cold start must cost one round trip, not one each.
    this.inFlight ??= this.fetchEndpoints().finally(() => {
      this.inFlight = undefined;
    });
    const endpoints = await this.inFlight;
    this.cached = { endpoints, at: Date.now() };
    return endpoints;
  }

  private async fetchEndpoints(): Promise<OidcEndpoints> {
    const issuer = trimSlash(this.options.issuer);
    const base = trimSlash(
      this.options.internalBase.length > 0 ? this.options.internalBase : issuer,
    );
    const doFetch = this.options.fetch ?? globalThis.fetch;

    let document: Record<string, unknown>;
    try {
      const response = await doFetch(`${base}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (!response.ok) throw new Error(`discovery answered ${response.status}`);
      document = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      throw providerUnavailable(
        `The identity provider's discovery document could not be read (${String(
          error instanceof Error ? error.message : error,
        )}).`,
      );
    }

    // A document whose issuer is not the configured one is a different realm (or a proxy rewriting
    // `Host`). Trusting it would validate tokens minted by a provider nobody meant to trust.
    const advertised = typeof document.issuer === 'string' ? trimSlash(document.issuer) : '';
    if (advertised !== issuer) {
      throw providerUnavailable(
        `The identity provider advertises issuer "${advertised}", but AUTH_ISSUER_URL is "${issuer}". ` +
          'Check the provider hostname configuration; a token minted there would fail issuer validation.',
      );
    }

    const authorization = required(document, 'authorization_endpoint');
    const token = required(document, 'token_endpoint');
    const jwks = required(document, 'jwks_uri');
    const endSession =
      typeof document.end_session_endpoint === 'string' ? document.end_session_endpoint : null;

    return {
      issuer,
      // The browser must be sent to the advertised host, never to the container address.
      authorizationEndpoint: authorization,
      endSessionEndpoint: endSession,
      internal: {
        tokenEndpoint: rebase(token, issuer, base),
        jwksUri: rebase(jwks, issuer, base),
      },
    };
  }
}

function required(document: Record<string, unknown>, key: string): string {
  const value = document[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw providerUnavailable(`The identity provider's discovery document has no ${key}.`);
  }
  return value;
}

/** Replaces the public issuer prefix with the internal base; a URL outside the issuer is left alone. */
function rebase(url: string, from: string, to: string): string {
  if (from === to) return url;
  return url.startsWith(from) ? `${to}${url.slice(from.length)}` : url;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
