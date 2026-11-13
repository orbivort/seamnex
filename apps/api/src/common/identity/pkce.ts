import { createHash, timingSafeEqual } from 'node:crypto';
import { unauthorized } from './identity-errors';

/**
 * RFC 7636 S256. The stub and the live provider both recompute it, because the verifier arrives
 * from the browser either way: in the stub it proves the client kept its own secret, and in the
 * live flow it is echoed to the token endpoint where Keycloak checks it against the challenge that
 * was bound to the authorization code.
 */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Compares the recomputed challenge with the one the client sent, in constant time. A length
 * mismatch short-circuits, but a same-length dummy comparison keeps the timing flat.
 */
export function assertPkce(verifier: string, challenge: string): void {
  const expected = Buffer.from(challengeFor(verifier));
  const presented = Buffer.from(challenge);
  if (expected.length !== presented.length) {
    timingSafeEqual(expected, expected);
    throw unauthorized();
  }
  if (!timingSafeEqual(expected, presented)) throw unauthorized();
}
