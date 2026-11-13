import { constants, verify as verifySignature, type KeyObject } from 'node:crypto';
import { unauthorized } from '../identity-errors';

/**
 * Compact JWS verification for the ID token, with `node:crypto`.
 *
 * The workspace ships no JWT library and one call site does not justify one: what a relying party
 * actually needs is `createPublicKey` + `verify` plus the claim checks below. The allow-list is
 * deliberately short — `none` and the HMAC family are refused by construction, so a token cannot
 * choose its own verification strength.
 */
const ALLOWED_ALGORITHMS = ['RS256', 'PS256', 'ES256'] as const;
type AllowedAlgorithm = (typeof ALLOWED_ALGORITHMS)[number];

export type JwtHeader = {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
};

export type VerifyIdTokenOptions = {
  /** The expected `iss`, exactly as the provider advertises it (public, browser-facing). */
  readonly issuer: string;
  /** The client id the token must be addressed to. */
  readonly audience: string;
  readonly clockSkewSeconds: number;
  readonly keyFor: (kid: string | undefined, alg: string) => Promise<KeyObject>;
  /** Injected in tests so an `exp` case does not depend on the wall clock. */
  readonly now?: () => number;
};

/**
 * Returns the verified claims. Every failure is `UNAUTHORIZED`: the caller may not tell "expired"
 * from "wrong audience" from "bad signature", because an attacker who can distinguish them learns
 * how to shape the next attempt.
 */
export async function verifyIdToken(
  token: string,
  options: VerifyIdTokenOptions,
): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  // Three segments is a JWS. Five is a JWE, which the platform never asks for and cannot read; a
  // token that arrives encrypted is not a format this relying party accepts.
  if (parts.length !== 3) throw unauthorized();
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  const header = parseJson<Partial<JwtHeader> & Record<string, unknown>>(rawHeader);
  if (header === null || typeof header.alg !== 'string') throw unauthorized();
  if (!(ALLOWED_ALGORITHMS as readonly string[]).includes(header.alg)) throw unauthorized();
  const alg = header.alg as AllowedAlgorithm;
  // `crit` names a header extension the verifier must understand. This one understands none, so a
  // token that requires an extension is refused rather than verified while ignoring it.
  if (header.crit !== undefined) throw unauthorized();

  const key = await options.keyFor(
    typeof header.kid === 'string' && header.kid.length > 0 ? header.kid : undefined,
    alg,
  );

  const signingInput = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');
  const signature = Buffer.from(rawSignature, 'base64url');
  let valid: boolean;
  try {
    valid = verifySignature('sha256', signingInput, keyOptions(alg, key), signature);
  } catch {
    throw unauthorized();
  }
  if (!valid) throw unauthorized();

  const claims = parseJson<Record<string, unknown>>(rawPayload);
  if (claims === null) throw unauthorized();
  assertClaims(claims, options);
  return claims;
}

function keyOptions(
  alg: AllowedAlgorithm,
  key: KeyObject,
):
  | KeyObject
  | { key: KeyObject; padding: number; saltLength: number }
  | { key: KeyObject; dsaEncoding: 'ieee-p1363' } {
  // Keycloak signs with RS256 by default; PS256 is the modern RSA option and ES256 the compact one.
  if (alg === 'PS256') {
    return {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    };
  }
  if (alg === 'ES256') return { key, dsaEncoding: 'ieee-p1363' };
  return key;
}

function assertClaims(claims: Record<string, unknown>, options: VerifyIdTokenOptions): void {
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1_000);
  const skew = options.clockSkewSeconds;

  if (normaliseIssuer(claims.iss) !== normaliseIssuer(options.issuer)) throw unauthorized();

  // `aud` may be a single string or an array. Both are legal; an array means the token was minted
  // for more than one audience, which must then name this client in `azp`.
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!Array.isArray(audiences) || !audiences.includes(options.audience)) throw unauthorized();
  if (audiences.length > 1 && claims.azp !== options.audience) throw unauthorized();
  if (claims.azp !== undefined && claims.azp !== options.audience) throw unauthorized();

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw unauthorized();

  const exp = numeric(claims.exp);
  if (exp === null || exp + skew <= nowSeconds) throw unauthorized();
  const iat = numeric(claims.iat);
  // A token issued in the future beyond the skew is a clock problem or a forgery; either way it is
  // not a credential this platform can reason about.
  if (iat === null || iat - skew > nowSeconds) throw unauthorized();
  const nbf = numeric(claims.nbf);
  if (claims.nbf !== undefined && (nbf === null || nbf - skew > nowSeconds)) throw unauthorized();
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normaliseIssuer(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : '';
}

function parseJson<T>(segment: string): T | null {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
