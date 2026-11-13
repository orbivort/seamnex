import { AppError } from '../problem/app-error';

/**
 * The refusals a sign-in exchange can produce, in one place so the stub and the live provider
 * answer identically. A provider that invented its own wording would leak which layer refused —
 * "no such user" from the stub, "invalid_grant" from Keycloak — and that difference is a
 * directory-enumeration oracle (ADR-BE-13).
 */

/** Any credential failure: unknown subject, wrong code, wrong verifier, unverifiable token. */
export function unauthorized(): AppError {
  return new AppError({
    code: 'UNAUTHORIZED',
    detail: 'The sign-in exchange was not accepted.',
    remediation:
      'Check the account with a platform administrator, then start again from the sign-in page.',
  });
}

/** AC-46: the account is authenticated, but not to the assurance its role requires. */
export function mfaRequired(): AppError {
  return new AppError({
    code: 'MFA_REQUIRED',
    detail: 'This account requires a second factor before a session can be created.',
    remediation: 'Complete the second factor at the identity provider and sign in again.',
  });
}

export function mfaInvalid(): AppError {
  return new AppError({
    code: 'MFA_INVALID',
    detail: 'The second factor was not accepted.',
    remediation: 'Wait for the next code and retry.',
  });
}

/**
 * Authentication succeeded and authorization did not: the provider knows the identity, but it
 * asserted no platform role. `403` rather than `401` is deliberate — asking the user to sign in
 * again would only repeat a successful sign-in.
 */
export function noPlatformRole(username: string): AppError {
  return new AppError({
    code: 'FORBIDDEN',
    status: 403,
    detail: `The identity provider asserted no platform role for "${username}".`,
    remediation:
      'Ask the platform owner to assign a role in the identity provider, then sign in again.',
  });
}

/**
 * The provider could not be reached. A `503` names the dependency instead of pretending the
 * credentials were wrong — a Keycloak outage must not read as "your account is invalid".
 */
export function providerUnavailable(detail: string): AppError {
  return new AppError({
    code: 'UNAVAILABLE',
    detail,
    remediation:
      'Retry shortly. Readiness reports the identity provider when it is reachable again.',
  });
}
