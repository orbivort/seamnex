import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/common/problem/app-error';
import { loadConfig } from '../../../../src/config/config';
import { StubIdentityProvider } from '../../../../src/common/identity/stub-identity.provider';

const config = loadConfig({
  DATABASE_URL: 'postgres://seamnex:pw@localhost:5432/seamnex',
  REDIS_URL: 'redis://localhost:6379',
  // A path that does not exist, so the built-in development directory is used deterministically.
  AUTH_STUB_DIRECTORY: './temp/integration-test/stub-provider-missing.json',
});
const provider = new StubIdentityProvider(config);

const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function exchange(code: string, mfaCode?: string, challenge = CHALLENGE) {
  return provider.exchangeCode({
    code,
    codeVerifier: VERIFIER,
    codeChallenge: challenge,
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

describe('stub identity provider', () => {
  it('refuses a password-only assertion for R1 with MFA_REQUIRED (AC-46)', async () => {
    expect(await codeOf(() => exchange('stub:dev-admin'))).toBe('MFA_REQUIRED');
  });

  it('refuses a wrong second factor without creating a claim set', async () => {
    expect(await codeOf(() => exchange('stub:dev-admin', '000000'))).toBe('MFA_INVALID');
  });

  it('returns MFA state for an accepted second factor', async () => {
    const claims = await exchange('stub:dev-admin', '123456');
    expect(claims.roles).toEqual(['R1']);
    expect(claims.mfaSatisfied).toBe(true);
    expect(claims.mfaMethod).toBe('totp');
    expect(claims.amr).toContain('otp');
    expect(claims.sub).toBe('stub:dev-admin');
  });

  it('allows a member without a second factor and reports it honestly', async () => {
    const claims = await exchange('stub:dev-user');
    expect(claims.roles).toEqual(['R5']);
    expect(claims.mfaSatisfied).toBe(false);
    expect(claims.mfaMethod).toBe('none');
  });

  it('rejects a PKCE verifier that does not match the challenge', async () => {
    const wrong = createHash('sha256').update('another-verifier').digest('base64url');
    expect(await codeOf(() => exchange('stub:dev-user', undefined, wrong))).toBe('UNAUTHORIZED');
  });

  it('rejects an unregistered redirect URI', async () => {
    expect(
      await codeOf(() =>
        provider.exchangeCode({
          code: 'stub:dev-user',
          codeVerifier: VERIFIER,
          codeChallenge: CHALLENGE,
          redirectUri: 'https://evil.test/sign-in',
          mfaCode: undefined,
        }),
      ),
    ).toBe('UNAUTHORIZED');
  });

  it('rejects a registered origin with an unregistered callback path or a query string', async () => {
    // An origin allowlists a host, not a redirect: every path under it used to be accepted, which
    // is an open redirect the moment a real provider is wired (ADR-BE-13).
    for (const redirectUri of [
      'http://localhost:5173/anything',
      'http://localhost:5173/sign-in/../admin',
      'http://localhost:5173/sign-in?next=https://evil.test',
    ]) {
      expect(
        await codeOf(() =>
          provider.exchangeCode({
            code: 'stub:dev-user',
            codeVerifier: VERIFIER,
            codeChallenge: CHALLENGE,
            redirectUri,
            mfaCode: undefined,
          }),
        ),
        redirectUri,
      ).toBe('UNAUTHORIZED');
    }
  });

  it('refuses an MFA account whose recorded code is missing, instead of defaulting one', () => {
    // `user.mfaCode ?? '123456'` used to publish a second factor for every enrolled account.
    const directory = JSON.stringify({ users: [{ username: 'dev-admin', role: 'R1', mfa: true }] });
    const path = './temp/integration-test/stub-provider-no-code.json';
    mkdirSync('./temp/integration-test', { recursive: true });
    writeFileSync(path, directory, 'utf8');

    const faulty = loadConfig({
      DATABASE_URL: 'postgres://seamnex:pw@localhost:5432/seamnex',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_STUB_DIRECTORY: path,
    });
    expect(() => new StubIdentityProvider(faulty)).toThrow(/mfaCode/);
  });

  it('rejects a code that this provider did not issue', async () => {
    expect(await codeOf(() => exchange('keycloak-code'))).toBe('UNAUTHORIZED');
  });

  it('exposes a directory the sync worker can mirror', async () => {
    const directory = await provider.directory();
    expect(directory.users.length).toBeGreaterThanOrEqual(6);
    expect(directory.users.find((user) => user.username === 'dev-admin')?.mfaEnrolled).toBe(true);
    expect(directory.groups.some((group) => group.id === 'seamnex-admins')).toBe(true);
    expect(directory.groups.find((group) => group.id === 'seamnex-admins')?.members).toContain(
      'stub:dev-admin',
    );
  });

  it('disables an account where the mirror is rebuilt from, not only in the platform', async () => {
    // FR-4.4: the mirror is rewritten from the provider every cycle, so a local-only disable was
    // undone by the next sync. `setUserEnabled` is the directory write that makes it stick.
    await provider.setUserEnabled('stub:dev-user', false);
    expect(
      (await provider.directory()).users.find((user) => user.username === 'dev-user')?.enabled,
    ).toBe(false);
    expect(await codeOf(() => exchange('stub:dev-user'))).toBe('UNAUTHORIZED');

    await provider.setUserEnabled('stub:dev-user', true);
    expect(
      (await provider.directory()).users.find((user) => user.username === 'dev-user')?.enabled,
    ).toBe(true);
    // Enabling a subject that was never disabled is not an error: the directory is a set.
    await expect(provider.setUserEnabled('stub:never-disabled', true)).resolves.toBeUndefined();
  });
});

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withDirectory(content: unknown): StubIdentityProvider {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-stub-'));
  dirs.push(dir);
  const path = join(dir, 'users.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return new StubIdentityProvider(
    loadConfig({
      DATABASE_URL: 'postgres://seamnex:pw@localhost:5432/seamnex',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_STUB_DIRECTORY: path,
    }),
  );
}

describe('the stub is honest about what it cannot offer', () => {
  it('advertises no browser round trip', async () => {
    // The SPA posts the code itself, so there is no authorize or logout URL to navigate to.
    await expect(provider.authConfig()).resolves.toEqual({
      provider: 'stub',
      authorizeUrl: null,
      endSessionUrl: null,
      clientId: null,
      scope: null,
      redirectPath: '/sign-in',
    });
    expect(provider.logoutUrl()).toBeNull();
  });
});

describe('a directory file', () => {
  const DIRECTORY = {
    users: [
      {
        username: 'ops-owner',
        displayName: 'Ops Owner',
        email: 'ops@example.test',
        role: 'R3',
        groups: ['seamnex-owners', 'seamnex-oncall'],
      },
      { username: 'kiosk-guest', role: 'R6', groups: ['seamnex-guests'], instanceId: 'inst-1' },
      { username: 'unscoped-guest', role: 'R6' },
      { username: 'quiet-admin', role: 'R1', mfa: true, mfaCode: '654321' },
    ],
  };

  it('replaces the built-in users and keeps the fields it was given', async () => {
    const loaded = withDirectory(DIRECTORY);

    const claims = await loaded.exchangeCode({
      code: 'stub:ops-owner',
      codeVerifier: VERIFIER,
      codeChallenge: CHALLENGE,
      redirectUri: 'http://localhost:5173/sign-in',
      mfaCode: undefined,
    });

    expect(claims).toMatchObject({
      sub: 'stub:ops-owner',
      displayName: 'Ops Owner',
      email: 'ops@example.test',
      groups: ['seamnex-owners', 'seamnex-oncall'],
      roles: ['R3'],
      instanceId: null,
    });
  });

  it('derives a display name and address for an entry that names neither', async () => {
    const loaded = withDirectory({ users: [{ username: 'spare.operator', role: 'R5' }] });

    const claims = await loaded.exchangeCode({
      code: 'stub:spare.operator',
      codeVerifier: VERIFIER,
      codeChallenge: CHALLENGE,
      redirectUri: 'http://localhost:5173/sign-in',
      mfaCode: undefined,
    });

    expect(claims.displayName).toBe('Spare Operator');
    expect(claims.email).toBe('spare.operator@seamnex.local');
    // A member with no declared groups is a member of nothing, not of a default group.
    expect(claims.groups).toEqual([]);
  });

  it('binds a guest session to its instance, and only to a guest', async () => {
    const loaded = withDirectory(DIRECTORY);

    const bound = await loaded.exchangeCode({
      code: 'stub:kiosk-guest',
      codeVerifier: VERIFIER,
      codeChallenge: CHALLENGE,
      redirectUri: 'http://localhost:5173/sign-in',
      mfaCode: undefined,
    });
    expect(bound.instanceId).toBe('inst-1');

    const unscoped = await loaded.exchangeCode({
      code: 'stub:unscoped-guest',
      codeVerifier: VERIFIER,
      codeChallenge: CHALLENGE,
      redirectUri: 'http://localhost:5173/sign-in',
      mfaCode: undefined,
    });
    expect(unscoped.instanceId).toBeNull();
  });

  it('refuses a second factor of the wrong length without leaking which side was short', async () => {
    const loaded = withDirectory(DIRECTORY);

    // The refusal is the same shape as a wrong value of the right length: a shorter input must not
    // be distinguishable, or the check becomes a length oracle.
    expect(
      await codeOf(async () =>
        loaded.exchangeCode({
          code: 'stub:quiet-admin',
          codeVerifier: VERIFIER,
          codeChallenge: CHALLENGE,
          redirectUri: 'http://localhost:5173/sign-in',
          mfaCode: '12345',
        }),
      ),
    ).toBe('MFA_INVALID');
  });

  it('mirrors the file: sorted users, derived groups and the enabled flag', async () => {
    const loaded = withDirectory(DIRECTORY);

    const directory = await loaded.directory();

    // A directory file augments the built-in development users rather than replacing them, so a
    // demo can add an operator without losing the seeded ones.
    expect(directory.users.map((user) => user.username)).toEqual([
      'dev-admin',
      'dev-auditor',
      'dev-guest',
      'dev-owner',
      'dev-product',
      'dev-user',
      'kiosk-guest',
      'ops-owner',
      'quiet-admin',
      'unscoped-guest',
    ]);
    expect(directory.groups.map((group) => group.id)).toContain('seamnex-oncall');
    expect(directory.groups.find((group) => group.id === 'seamnex-oncall')).toEqual({
      id: 'seamnex-oncall',
      path: '/seamnex-oncall',
      members: ['stub:ops-owner'],
    });
    expect(directory.users.find((user) => user.username === 'quiet-admin')?.mfaEnrolled).toBe(true);
  });

  it.each([
    ['invalid JSON', '{ not json'],
    ['no users array', { users: { 'ops-owner': {} } }],
    ['an entry with no role', { users: [{ username: 'nameless' }] }],
    ['a role outside R1–R6', { users: [{ username: 'ops-owner', role: 'R9' }] }],
  ])('fails boot on %s rather than half-loading', (_case, content) => {
    // A directory that half-loaded would authenticate the wrong role, so a malformed file is fatal.
    expect(() => withDirectory(content)).toThrow(/AUTH_STUB_DIRECTORY/);
  });
});
