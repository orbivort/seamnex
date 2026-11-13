import { PLATFORM_ROLES, type PlatformRole } from '@seamnex/domain';
import { noPlatformRole, unauthorized } from '../identity-errors';
import type { IdentityClaims } from '../identity-provider.contract';

/**
 * ID token → platform identity.
 *
 * Kept pure so the whole mapping is testable without a provider: every decision about what the
 * platform believes (which role, which groups, whether a second factor was used) is visible in one
 * function rather than spread across the token exchange.
 *
 * The role set is filtered, not trusted: a Keycloak realm carries built-in roles
 * (`default-roles-seamnex`, `offline_access`, `uma_authorization`) and a misconfigured mapper can add
 * anything. Only `R1`–`R6` reach the capability matrix, so a stray role is inert rather than
 * unknown-and-therefore-undefined.
 */
const PLATFORM_ROLE_SET: ReadonlySet<string> = new Set(PLATFORM_ROLES);

/** `amr` values that constitute a second factor. Keycloak uses `otp`; WebAuthn uses `hwk`. */
const SECOND_FACTOR_METHODS = new Set(['otp', 'totp', 'hwk', 'webauthn', 'fido', 'sms', 'mfa']);

export function mapIdTokenClaims(claims: Record<string, unknown>): IdentityClaims {
  const sub = stringClaim(claims.sub);
  if (sub === null) throw unauthorized();

  const username =
    stringClaim(claims.preferred_username) ?? stringClaim(claims.email)?.split('@')[0] ?? sub;
  const roles = platformRoles(claims);
  // Authenticated but not authorized. Refused here, before a session exists, so no screen ever
  // renders for an identity the capability matrix cannot name.
  if (roles.length === 0) throw noPlatformRole(username);

  const amr = stringArray(claims.amr).map((method) => method.toLowerCase());
  const mfaMethod = secondFactorMethod(amr);
  /**
   * An empty `amr` is *not* "password only": Keycloak publishes the claim with no entries unless
   * the realm maps authentication methods (verified against the shipped realm — a password login
   * yields `amr: []`). The session therefore records `mfaAsserted: false`, and the step-up gate
   * stays silent rather than inferring an absence the provider never stated (ADR-BE-14).
   */
  const mfaAsserted = amr.length > 0;

  return {
    sub,
    username,
    displayName: displayName(claims) ?? username,
    email: stringClaim(claims.email) ?? '',
    groups: groupPaths(claims),
    roles,
    amr,
    mfaSatisfied: mfaMethod !== 'none',
    mfaMethod,
    mfaAsserted,
    /**
     * Guest scoping is *not* derived from a group name. A Keycloak group carries a slug
     * (`/seamnex-instances/finance-suite`), while the session field is an instance UUID; translating one
     * into the other by name would let a group rename move a guest to another product. The real
     * scope comes from `entitlement` and `group_mapping`, which the PDP already consults.
     */
    instanceId: null,
  };
}

function platformRoles(claims: Record<string, unknown>): readonly PlatformRole[] {
  const realmAccess = claims.realm_access;
  const raw =
    typeof realmAccess === 'object' && realmAccess !== null
      ? stringArray((realmAccess as { roles?: unknown }).roles)
      : [];
  // Ascending, so `roles[0]` — the role the navigation renders — is the most privileged asserted
  // one (R1 before R5) instead of whichever order the provider happened to emit.
  return [...new Set(raw.filter((role) => PLATFORM_ROLE_SET.has(role)))].sort() as PlatformRole[];
}

/**
 * Keycloak's group mapper emits full paths (`/seamnex-domains/revenue-customer`) when `full.path` is on,
 * which is what the seed and `group_mapping` use. A provider configured without it would emit bare
 * names, so the slash is added rather than trusted: two spellings of one group must not become two
 * groups in the mirror.
 */
function groupPaths(claims: Record<string, unknown>): readonly string[] {
  const paths = stringArray(claims.groups).map((group) =>
    group.startsWith('/') ? group : `/${group}`,
  );
  return [...new Set(paths)].sort();
}

function secondFactorMethod(amr: readonly string[]): 'totp' | 'webauthn' | 'none' {
  const presented = amr.filter((method) => SECOND_FACTOR_METHODS.has(method));
  if (presented.length === 0) return 'none';
  return presented.some((method) => method === 'webauthn' || method === 'hwk' || method === 'fido')
    ? 'webauthn'
    : 'totp';
}

function displayName(claims: Record<string, unknown>): string | null {
  const name = stringClaim(claims.name);
  if (name !== null) return name;
  const given = stringClaim(claims.given_name);
  const family = stringClaim(claims.family_name);
  const combined = [given, family]
    .filter((part): part is string => part !== null)
    .join(' ')
    .trim();
  return combined.length > 0 ? combined : null;
}

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
