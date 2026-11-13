import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/common/problem/app-error';
import { loadConfig } from '../../../../src/config/config';
import { StubIdentityProvider } from '../../../../src/common/identity/stub-identity.provider';

/**
 * The stub's code format is `stub:<username>`, which a browser cannot obtain from Keycloak — but a
 * developer types it by hand, so the lookup is case-insensitive and trims what follows the prefix.
 * The claims must still carry the *directory's* spelling of the username: it is the value the
 * mirror, the audit rows and `sub` are keyed on, and echoing what was typed would create a second
 * identity for the same person.
 *
 * A second factor offered by an account that never enrolled is ignored rather than validated:
 * `mfaEnrolled` comes from the directory entry, not from the request.
 */
const config = loadConfig({
  DATABASE_URL: 'postgres://seamnex:pw@localhost:5432/seamnex',
  REDIS_URL: 'redis://localhost:6379',
  // A path that does not exist, so the built-in development directory is used deterministically.
  AUTH_STUB_DIRECTORY: './temp/integration-test/stub-edge-cases-missing.json',
});
const provider = new StubIdentityProvider(config);

const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function exchange(code: string, mfaCode?: string) {
  return provider.exchangeCode({
    code,
    codeVerifier: VERIFIER,
    codeChallenge: CHALLENGE,
    redirectUri: 'http://localhost:5173/sign-in',
    mfaCode,
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
}

describe('authorization code parsing', () => {
  it('resolves a username regardless of case and answers with the directory spelling', async () => {
    const claims = await exchange('stub:DEV-ADMIN', '123456');

    expect(claims.username).toBe('dev-admin');
    expect(claims.sub).toBe('stub:dev-admin');
  });

  it('trims what follows the prefix, so a pasted code with trailing space still works', async () => {
    const claims = await exchange('stub:dev-user   ');

    expect(claims.username).toBe('dev-user');
  });

  it('refuses an empty subject instead of matching the first directory entry', async () => {
    expect(await codeOf(() => exchange('stub:'))).toBe('UNAUTHORIZED');
    expect(await codeOf(() => exchange('stub:   '))).toBe('UNAUTHORIZED');
  });

  it('refuses a string that only looks like an issued code', async () => {
    expect(await codeOf(() => exchange('stub'))).toBe('UNAUTHORIZED');
    expect(await codeOf(() => exchange(' st:dev-admin'))).toBe('UNAUTHORIZED');
  });
});

describe('second factor evidence', () => {
  it('ignores a second factor offered by an account that never enrolled one', async () => {
    const claims = await exchange('stub:dev-user', '123456');

    expect(claims.mfaSatisfied).toBe(false);
    expect(claims.mfaMethod).toBe('none');
    expect(claims.amr).toEqual(['pwd']);
  });

  it('refuses the right code offered at the wrong position in the six digits', async () => {
    // The comparison is on the whole value: a permutation is not a match.
    expect(await codeOf(() => exchange('stub:dev-admin', '654321'))).toBe('MFA_INVALID');
  });
});
