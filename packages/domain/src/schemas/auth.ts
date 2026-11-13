import { z } from 'zod';
import { PLATFORM_ROLES } from '../enums';
import { TimestampSchema } from './common';

export const MfaMethodSchema = z.enum(['totp', 'webauthn', 'none']);
export type MfaMethod = z.infer<typeof MfaMethodSchema>;

export const SessionSubjectSchema = z.object({
  idpId: z.string().min(1),
  username: z.string().min(1),
  displayName: z.string().min(1),
});

/**
 * How the browser signs in, described by the server (ADR-BE-14).
 *
 * The SPA must not embed an identity-provider hostname: the console, the portal and every
 * deployment reach the same relying party through the API's configuration, and a URL baked into a
 * bundle is a second source of truth nobody rotates. `redirectPath` is a path, not a URL, because
 * the two applications are distinct origins — the client composes `origin + redirectPath` and the
 * server still validates the result against its registered origins.
 */
export const AuthProviderConfigSchema = z.object({
  provider: z.enum(['stub', 'oidc']),
  /** Browser-facing authorization endpoint; `null` for the stub, which needs no round trip. */
  authorizeUrl: z.string().url().nullable(),
  /** Browser-facing RP-initiated logout endpoint, when the provider publishes one. */
  endSessionUrl: z.string().url().nullable(),
  clientId: z.string().min(1).nullable(),
  /** The scope the client must request, already space-separated. */
  scope: z.string().min(1).nullable(),
  redirectPath: z.string().startsWith('/'),
});

/**
 * `GET /auth/session` answers 200 even when no session exists, with `authenticated: false`.
 * A cold start therefore probes the session without tripping the client's `seamnex:unauthorized`
 * handler; a real data call that lapses still raises it exactly once.
 *
 * The opaque session id is deliberately **not** part of this payload (ADR-BE-13). It travels only
 * in the `HttpOnly` cookie: putting it in a JSON body would hand any cross-site script a replayable
 * credential and undo the reason the cookie is unreadable in the first place.
 */
export const AuthSessionSchema = z.object({
  authenticated: z.boolean(),
  subject: SessionSubjectSchema.nullable(),
  roles: z.array(z.enum(PLATFORM_ROLES)),
  groups: z.array(z.string()),
  mfaSatisfied: z.boolean(),
  mfaMethod: MfaMethodSchema,
  /** Mirrored into the readable `seamnex_csrf` cookie; the client echoes it as `x-seamnex-csrf`. */
  csrfToken: z.string().nullable(),
  createdAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  idleExpiresAt: TimestampSchema.nullable(),
  /** Present even when unauthenticated: the sign-in screen needs it before a session exists. */
  auth: AuthProviderConfigSchema,
});

/**
 * Authorization-code exchange, identical for both providers.
 *
 * The browser performs the front channel and the API performs the back channel, so the request
 * carries what the token endpoint needs: the code, the verifier that proves the client that
 * started the flow, and the redirect URI the code was issued for. `mfaCode` exists for the
 * development stub, which has no login page; a live provider collects the second factor itself and
 * asserts it in the ID token's `amr`, so the field is ignored rather than sent on.
 */
export const SignInRequestSchema = z.object({
  /** Authorization code issued by the provider. The stub issues `stub:<username>`. */
  code: z.string().min(1).max(512),
  /** RFC 7636 verifier: 43–128 characters from the unreserved set. */
  codeVerifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9\-._~]+$/, 'codeVerifier must use the RFC 7636 unreserved character set'),
  /** Base64url(SHA-256(verifier)); the provider recomputes it and refuses a mismatch. */
  codeChallenge: z
    .string()
    .regex(/^[A-Za-z0-9\-_]{43}$/, 'codeChallenge must be a base64url S256 digest'),
  redirectUri: z.string().min(1).max(512),
  /** Six-digit TOTP for the development stub only; a live provider collects it on its own page. */
  mfaCode: z
    .string()
    .regex(/^\d{6}$/, 'mfaCode must be six digits')
    .optional(),
});

export type AuthSession = z.infer<typeof AuthSessionSchema>;
export type AuthProviderConfig = z.infer<typeof AuthProviderConfigSchema>;
export type SignInRequest = z.infer<typeof SignInRequestSchema>;
