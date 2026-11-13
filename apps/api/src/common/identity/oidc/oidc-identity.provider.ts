import { MFA_REQUIRED_ROLES } from '@seamnex/domain';
import type { AppConfig } from '../../../config/config';
import { mfaRequired, providerUnavailable, unauthorized } from '../identity-errors';
import type {
  AuthProviderConfig,
  DirectorySnapshot,
  ExchangeCodeInput,
  IdentityClaims,
  IdentityProvider,
} from '../identity-provider.contract';
import { assertPkce } from '../pkce';
import { assertRedirectUri } from '../redirect-uri';
import { mapIdTokenClaims } from './claims';
import { OidcDiscovery, type OidcEndpoints } from './discovery';
import { verifyIdToken } from './jwt';
import { JwksCache } from './jwks';

/**
 * The Keycloak relying party (4D).
 *
 * The browser performs the front channel (authorization code + PKCE, `state` kept by the SPA) and
 * posts `{code, codeVerifier, codeChallenge, redirectUri}` to `POST /auth/session`; this class
 * performs the back channel — redeeming the code at the token endpoint, verifying the ID token and
 * mapping it to the platform's identity shape. The session surface above it does not change: that
 * is the point of the seam.
 *
 * Structural choices worth naming:
 *
 *   - **No `nonce` check.** An ID token is read from the token endpoint response over TLS, never
 *     from the browser, so the injection attack `nonce` defends against is not reachable here; the
 *     code is single-use and bound to the verifier, and `state` plus the origin check cover the
 *     front channel. Recorded as an accepted risk in ADR-BE-14 rather than left implicit.
 *   - **No `id_token_hint` on logout.** Storing the ID token to hand it back to the provider would
 *     put a credential at rest in Redis for the sake of a sign-out. Keycloak accepts
 *     `client_id` + a registered `post_logout_redirect_uri`, which is what the SPA sends.
 *   - **The exchange is per sign-in, not per request.** The Redis session stays the source of truth,
 *     so no request pays for a token round trip.
 */
export type OidcIdentityProviderOptions = {
  readonly config: AppConfig;
  /** Injected in tests; the defaults talk to the provider described by the configuration. */
  readonly discovery?: Pick<OidcDiscovery, 'endpoints'>;
  readonly keys?: Pick<JwksCache, 'keyFor' | 'refresh'>;
  /** The directory reader, wired by the module; absent disables the sync source. */
  readonly directory?: () => Promise<DirectorySnapshot>;
  /**
   * The Admin API write path, wired by the module. Absent makes `setUserEnabled` refuse rather than
   * pretend: a disable that only touched the platform mirror is undone by the next sync.
   */
  readonly admin?: { setUserEnabled(sub: string, enabled: boolean): Promise<void> };
  readonly fetch?: typeof globalThis.fetch;
};

export class OidcIdentityProvider implements IdentityProvider {
  readonly name = 'oidc' as const;

  private readonly config: AppConfig;
  private readonly discovery: Pick<OidcDiscovery, 'endpoints'>;
  private readonly keys: Pick<JwksCache, 'keyFor' | 'refresh'>;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly directoryReader: (() => Promise<DirectorySnapshot>) | undefined;
  private readonly admin:
    { setUserEnabled(sub: string, enabled: boolean): Promise<void> } | undefined;

  constructor(options: OidcIdentityProviderOptions) {
    this.config = options.config;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.discovery =
      options.discovery ??
      new OidcDiscovery({
        issuer: this.config.authIssuer,
        internalBase: this.config.authInternalBase,
        cacheSeconds: this.config.AUTH_DISCOVERY_CACHE_SECONDS,
        timeoutMs: this.config.AUTH_HTTP_TIMEOUT_MS,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    this.keys =
      options.keys ??
      new JwksCache({
        // Resolved per fetch: a discovery refresh may move the address.
        url: () => this.jwksUri(),
        minRefreshIntervalMs: this.config.AUTH_JWKS_MIN_REFRESH_MS,
        timeoutMs: this.config.AUTH_HTTP_TIMEOUT_MS,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    this.directoryReader = options.directory;
    this.admin = options.admin;
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<IdentityClaims> {
    // The same two assertions the stub performs. Keycloak will also refuse an unregistered
    // `redirect_uri` and a mismatched verifier; checking them here means a misconfigured client
    // fails the same way for both providers instead of depending on which one answered.
    assertRedirectUri(input.redirectUri, this.config.allowedOrigins, this.config.authRedirectPaths);
    assertPkce(input.codeVerifier, input.codeChallenge);

    const endpoints = await this.discovery.endpoints();
    const tokens = await this.redeem(endpoints, input);
    const claims = await verifyIdToken(tokens.idToken, {
      issuer: this.config.authIssuer,
      audience: this.config.AUTH_CLIENT_ID,
      clockSkewSeconds: this.config.AUTH_CLOCK_SKEW_SECONDS,
      keyFor: (kid, alg) => this.keys.keyFor(kid, alg),
    });

    const identity = mapIdTokenClaims(claims);
    /*
     * AC-46 is enforced where it can be enforced: by the realm's browser flow, which requires the
     * second factor for the roles this platform marks (verified against `seamnex-browser`). This layer
     * refuses a sign-in only when the provider *said* a single factor was used — `amr: ["pwd"]` —
     * because that contradicts the policy. A provider that says nothing (`amr: []`, which is what
     * Keycloak 26 emits without LoA mapping) is not silently upgraded either: the session records
     * `mfaAsserted: false`, and the PDP refuses the step-up capabilities on that same session, so
     * the gap is visible at the capability instead of locking every administrator out of the door.
     */
    const needsAssurance = identity.roles.some((role) => MFA_REQUIRED_ROLES.includes(role));
    if (needsAssurance && identity.mfaAsserted && !identity.mfaSatisfied) throw mfaRequired();
    return identity;
  }

  async authConfig(): Promise<AuthProviderConfig> {
    const endpoints = await this.discovery.endpoints();
    return {
      provider: 'oidc',
      authorizeUrl: endpoints.authorizationEndpoint,
      endSessionUrl: endpoints.endSessionEndpoint,
      clientId: this.config.AUTH_CLIENT_ID,
      scope: this.config.authScopes.join(' '),
      redirectPath: this.config.authRedirectPath,
    };
  }

  async directory(): Promise<DirectorySnapshot> {
    if (this.directoryReader === undefined) {
      throw providerUnavailable(
        'The identity provider is configured without a directory reader, so the mirror cannot be refreshed.',
      );
    }
    return this.directoryReader();
  }

  /**
   * FR-4.4 at the provider. The realm's `enabled` flag is the authority the mirror is rebuilt from,
   * so a disable has to be written there; a provider without an Admin API path refuses instead of
   * reporting success that the next sync cycle would erase.
   */
  async setUserEnabled(sub: string, enabled: boolean): Promise<void> {
    if (this.admin === undefined) {
      throw providerUnavailable(
        'The identity provider is configured without an admin client, so an account cannot be disabled at the provider.',
      );
    }
    await this.admin.setUserEnabled(sub, enabled);
  }

  /** The base for RP-initiated logout; the SPA adds `client_id` and `post_logout_redirect_uri`. */
  logoutUrl(): string | null {
    return null;
  }

  /** Exposed for the readiness probe: a provider that cannot be reached is reported, not fatal. */
  async reachable(): Promise<boolean> {
    try {
      await this.discovery.endpoints();
      return true;
    } catch {
      return false;
    }
  }

  private async jwksUri(): Promise<string> {
    const endpoints = await this.discovery.endpoints();
    return endpoints.internal.jwksUri;
  }

  private async redeem(
    endpoints: OidcEndpoints,
    input: ExchangeCodeInput,
  ): Promise<{ idToken: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.config.AUTH_CLIENT_ID,
      code_verifier: input.codeVerifier,
    });
    // A public client authenticates with PKCE alone; a secret is only sent when one is configured,
    // because presenting a secret a public client does not have is a configuration error Keycloak
    // reports as `invalid_client` — which reads like a bad credential to everyone who sees it.
    if (this.config.AUTH_CLIENT_SECRET.length > 0)
      body.set('client_secret', this.config.AUTH_CLIENT_SECRET);

    let response: Response;
    try {
      response = await this.doFetch(endpoints.internal.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.config.AUTH_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw providerUnavailable(
        `The identity provider did not answer the token request (${String(
          error instanceof Error ? error.message : error,
        )}).`,
      );
    }

    if (!response.ok) {
      // 4xx is the credentials being wrong (spent code, verifier mismatch, disabled client); 5xx and
      // 429 are the provider being unavailable. Conflating them either blames the user for an
      // outage or hides a broken client behind "try later" forever.
      if (response.status >= 500 || response.status === 429) {
        throw providerUnavailable(
          `The identity provider refused the token request (${response.status}).`,
        );
      }
      throw unauthorized();
    }

    let payload: { id_token?: unknown };
    try {
      payload = (await response.json()) as { id_token?: unknown };
    } catch {
      throw unauthorized();
    }
    if (typeof payload.id_token !== 'string' || payload.id_token.length === 0) throw unauthorized();
    return { idToken: payload.id_token };
  }
}
