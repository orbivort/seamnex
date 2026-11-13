import type { PlatformRole } from '@seamnex/domain';

export const IDENTITY_PROVIDER = Symbol('seamnex.identity.provider');

/**
 * The seam Phase 4D replaces with Keycloak. Phase 3 ships `StubIdentityProvider`: it validates the
 * same PKCE exchange the real client will perform and returns the same claims shape, so swapping
 * the implementation changes one provider binding, not the session surface.
 */
export type IdentityClaims = {
  readonly sub: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly groups: readonly string[];
  readonly roles: readonly PlatformRole[];
  /** Authentication methods the provider asserts: `pwd`, `otp`, `webauthn`. */
  readonly amr: readonly string[];
  readonly mfaSatisfied: boolean;
  readonly mfaMethod: 'totp' | 'webauthn' | 'none';
  /**
   * Whether the provider actually said *how* the user authenticated.
   *
   * It matters because absence of evidence is not evidence of absence: an ID token with no `amr`
   * claim says nothing about a second factor, while `amr: ["pwd"]` says one was not used. Only the
   * second case may refuse a step-up capability (ADR-BE-14). The stub always asserts, so its
   * behaviour is unchanged.
   */
  readonly mfaAsserted: boolean;
  /** R6 single-surface scope when the identity is a guest invitation; null otherwise. */
  readonly instanceId: string | null;
};

export type ExchangeCodeInput = {
  readonly code: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly mfaCode: string | undefined;
};

/** One directory entry the sync worker mirrors (deliverable 3.6). */
export type DirectoryUser = {
  readonly sub: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly groups: readonly string[];
  readonly enabled: boolean;
  readonly mfaEnrolled: boolean;
};

export type DirectoryGroup = {
  readonly id: string;
  readonly path: string;
  readonly members: readonly string[];
};

export type DirectorySnapshot = {
  readonly users: readonly DirectoryUser[];
  readonly groups: readonly DirectoryGroup[];
};

/**
 * What the browser needs to start a sign-in, described by the server.
 *
 * The SPA must not embed a provider hostname: the console, the portal and a deployment all reach
 * the same relying party through the API's configuration, and a URL baked into a bundle is a
 * second source of truth that nobody rotates. The redirect URI is composed by the client
 * (`origin + redirectPath`) because the two applications are distinct origins; the server still
 * validates whatever the client sends against `APP_ORIGINS` and `AUTH_REDIRECT_PATHS`.
 */
export type AuthProviderConfig = {
  readonly provider: 'stub' | 'oidc';
  /** The authorization endpoint, browser-facing. `null` for the stub. */
  readonly authorizeUrl: string | null;
  /** The RP-initiated logout endpoint, browser-facing. `null` when the provider has none. */
  readonly endSessionUrl: string | null;
  readonly clientId: string | null;
  /** Space-separated scope the client must request, as one string (the wire form). */
  readonly scope: string | null;
  /** The registered callback path an SPA appends to its own origin. */
  readonly redirectPath: string;
};

export interface IdentityProvider {
  readonly name: 'stub' | 'oidc';
  /** Resolves the authorization code to claims, or throws `MFA_REQUIRED` / `UNAUTHORIZED`. */
  exchangeCode(input: ExchangeCodeInput): Promise<IdentityClaims>;
  /** The source the sync worker mirrors; a real provider pages its Admin API here in Phase 4D. */
  directory(): Promise<DirectorySnapshot>;
  /**
   * FR-4.4: disables (or re-enables) the account *at the provider*.
   *
   * The mirror is rewritten from the provider on every cycle, so a platform-side
   * `enabled = false` alone is undone by the next sync — an offboarding that silently reverses
   * itself. The authority has to change where it lives; this call is that change.
   */
  setUserEnabled(sub: string, enabled: boolean): Promise<void>;
  /** Provider-side logout URL, or null when the provider has no browser logout endpoint. */
  logoutUrl(): string | null;
  /** The browser-facing sign-in parameters, resolved once per session read. */
  authConfig(): Promise<AuthProviderConfig>;
}
