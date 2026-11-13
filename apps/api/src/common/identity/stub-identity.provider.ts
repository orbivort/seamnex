import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import type { PlatformRole } from '@seamnex/domain';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { mfaInvalid, mfaRequired, unauthorized } from './identity-errors';
import type {
  AuthProviderConfig,
  DirectoryGroup,
  DirectorySnapshot,
  ExchangeCodeInput,
  IdentityClaims,
  IdentityProvider,
} from './identity-provider.contract';
import { assertPkce } from './pkce';
import { assertRedirectUri } from './redirect-uri';

type StubUser = {
  username: string;
  displayName?: string;
  email?: string;
  role: PlatformRole;
  groups?: string[];
  mfa?: boolean;
  mfaCode?: string;
  instanceId?: string | null;
};

/**
 * Phase 3 identity provider (agreed scope: no live OIDC call yet).
 *
 * It is deliberately shaped like the real exchange: an authorization code, an RFC 7636 S256
 * verifier, a registered callback and a second factor are validated before any claim is returned.
 * The code format is `stub:<username>`, which a browser cannot obtain from Keycloak — so this
 * provider authenticates nobody. It is a development affordance and the config schema refuses it
 * outright in production (ADR-BE-13); the seam, not this class, is what Phase 4D swaps.
 *
 * The directory is a JSON file (`AUTH_STUB_DIRECTORY`) so a demo can add a user without a rebuild;
 * when the file is absent the built-in users below apply. A malformed file fails boot rather than
 * silently falling back — a directory that half-loaded would authenticate the wrong role.
 */
@Injectable()
export class StubIdentityProvider implements IdentityProvider {
  readonly name = 'stub' as const;
  private readonly logger = new Logger('identity.stub');
  private readonly users: ReadonlyMap<string, StubUser>;
  /**
   * Subjects disabled through the console. The stub has no Admin API to write to, so this set is the
   * directory's own `enabled` flag; it lives beside the map rather than inside it so the directory
   * read reports the change and the next sign-in is refused.
   */
  private readonly disabled = new Set<string>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.users = loadDirectory(config.AUTH_STUB_DIRECTORY);
    this.logger.warn(
      `identity provider is the Phase 3 stub (${this.users.size} directory entries); Keycloak arrives in Phase 4D`,
    );
  }

  exchangeCode(input: ExchangeCodeInput): Promise<IdentityClaims> {
    if (!input.code.startsWith('stub:')) {
      throw unauthorized();
    }

    const username = input.code.slice('stub:'.length).trim();
    const user = this.users.get(username.toLowerCase());
    // One refusal shape for "no such user" and "not a code this provider issued": a distinct
    // message is a directory-enumeration oracle for whoever is probing the sign-in endpoint.
    if (user === undefined || this.disabled.has(`stub:${user.username}`)) {
      throw unauthorized();
    }

    assertRedirectUri(input.redirectUri, this.config.allowedOrigins, this.config.authRedirectPaths);
    assertPkce(input.codeVerifier, input.codeChallenge);

    const mfaEnrolled = user.mfa === true;
    if (mfaEnrolled && input.mfaCode === undefined) {
      // AC-46: a password-only assertion for R1/R2 is refused before a session exists.
      throw mfaRequired();
    }
    if (mfaEnrolled && !matchesSecondFactor(input.mfaCode, user.mfaCode)) {
      throw mfaInvalid();
    }

    const groups = user.groups ?? [];
    return Promise.resolve({
      sub: `stub:${user.username}`,
      username: user.username,
      displayName: user.displayName ?? titleCase(user.username),
      email: user.email ?? `${user.username}@seamnex.local`,
      groups,
      roles: [user.role],
      amr: mfaEnrolled ? ['pwd', 'otp'] : ['pwd'],
      mfaSatisfied: mfaEnrolled,
      mfaMethod: mfaEnrolled ? 'totp' : 'none',
      // The stub validated the factor itself, so it can always say what was used.
      mfaAsserted: true,
      instanceId: user.role === 'R6' ? (user.instanceId ?? null) : null,
    });
  }

  /**
   * The stub has no browser round trip: the SPA posts the code itself, so there is no authorization
   * or logout endpoint to advertise and nothing for the sign-in screen to navigate to.
   */
  authConfig(): Promise<AuthProviderConfig> {
    return Promise.resolve({
      provider: 'stub',
      authorizeUrl: null,
      endSessionUrl: null,
      clientId: null,
      scope: null,
      redirectPath: this.config.authRedirectPath,
    });
  }

  /**
   * The mirror source. In Phase 4D this becomes a paged Keycloak Admin API read; the shape is what
   * the sync worker depends on, so the swap does not touch M08.
   */
  directory(): Promise<DirectorySnapshot> {
    const groups = new Map<string, Set<string>>();
    for (const user of this.users.values()) {
      for (const group of user.groups ?? []) {
        const members = groups.get(group) ?? new Set<string>();
        members.add(`stub:${user.username}`);
        groups.set(group, members);
      }
    }

    const directoryGroups: DirectoryGroup[] = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, members]) => ({ id, path: `/${id}`, members: [...members].sort() }));

    return Promise.resolve({
      users: [...this.users.values()]
        .sort((left, right) => left.username.localeCompare(right.username))
        .map((user) => ({
          sub: `stub:${user.username}`,
          username: user.username,
          displayName: user.displayName ?? titleCase(user.username),
          email: user.email ?? `${user.username}@seamnex.local`,
          groups: user.groups ?? [],
          enabled: !this.disabled.has(`stub:${user.username}`),
          mfaEnrolled: user.mfa === true,
        })),
      groups: directoryGroups,
    });
  }

  /**
   * The stub's own Admin API: only the directory's `enabled` flag, so a disable survives the next
   * `directory()` read. Persisting it would need a store the stub deliberately does not have.
   */
  setUserEnabled(sub: string, enabled: boolean): Promise<void> {
    if (enabled) this.disabled.delete(sub);
    else this.disabled.add(sub);
    return Promise.resolve();
  }

  logoutUrl(): string | null {
    return null;
  }
}

/**
 * A second factor is compared in constant time and against the value on record only: there is no
 * built-in default, so a directory entry that requires MFA and carries no code cannot be satisfied
 * by guessing `123456` (ADR-BE-13).
 */
function matchesSecondFactor(presented: string | undefined, recorded: string | undefined): boolean {
  if (presented === undefined || recorded === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(recorded, 'utf8');
  if (a.length !== b.length) {
    // Compare a same-length pair so the timing does not reveal which side was shorter.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

const DEFAULT_USERS: readonly StubUser[] = [
  { username: 'dev-admin', role: 'R1', groups: ['seamnex-admins'], mfa: true, mfaCode: '123456' },
  {
    username: 'dev-auditor',
    role: 'R2',
    groups: ['seamnex-auditors'],
    mfa: true,
    mfaCode: '123456',
  },
  { username: 'dev-owner', role: 'R3', groups: ['seamnex-domain-owners'] },
  { username: 'dev-product', role: 'R4', groups: ['seamnex-product-admins'] },
  { username: 'dev-user', role: 'R5', groups: ['seamnex-users'] },
  { username: 'dev-guest', role: 'R6', groups: ['seamnex-guests'] },
];

function loadDirectory(path: string): ReadonlyMap<string, StubUser> {
  const users = new Map<string, StubUser>();
  for (const user of DEFAULT_USERS) users.set(user.username.toLowerCase(), user);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No file is the normal development case: the built-in users are enough to sign in.
    return users;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`AUTH_STUB_DIRECTORY is not valid JSON (${path}): ${String(error)}`, {
      cause: error,
    });
  }
  const entries = (parsed as { users?: unknown }).users;
  if (!Array.isArray(entries))
    throw new Error(`AUTH_STUB_DIRECTORY must contain a "users" array (${path})`);

  for (const entry of entries) {
    const user = entry as Partial<StubUser>;
    if (typeof user.username !== 'string' || typeof user.role !== 'string') {
      throw new Error(`AUTH_STUB_DIRECTORY entry is missing username or role (${path})`);
    }
    if (!/^R[1-6]$/.test(user.role)) {
      throw new Error(`AUTH_STUB_DIRECTORY role must be R1–R6 (${user.username})`);
    }
    // Fail at boot, not at sign-in: an MFA-enrolled entry with no recorded code is unfulfillable,
    // and a silent default would be a published second factor for every such account.
    if (user.mfa === true && (typeof user.mfaCode !== 'string' || !/^\d{6}$/.test(user.mfaCode))) {
      throw new Error(
        `AUTH_STUB_DIRECTORY entry ${user.username} requires MFA but carries no six-digit mfaCode (${path})`,
      );
    }
    users.set(user.username.toLowerCase(), {
      ...user,
      username: user.username,
      role: user.role as PlatformRole,
    });
  }
  return users;
}

function titleCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
