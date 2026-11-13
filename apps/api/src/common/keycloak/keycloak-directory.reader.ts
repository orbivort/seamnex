import { Inject, Injectable } from '@nestjs/common';
import type { DirectorySnapshot, DirectoryUser } from '../identity/identity-provider.contract';
import { KeycloakAdminClient } from './keycloak-admin.client';

/**
 * The directory mirror's source (deliverable 3.6) — a paged read of the realm over the Admin API.
 *
 * Three conventions are load-bearing, and none of them is visible from the Keycloak payload:
 *
 *   - **The subject is the Keycloak `id`**, not the username. A username can be renamed and a
 *     re-created account can reuse one; the UUID cannot, which is what makes `role_binding` and
 *     `entitlement` rows survive a rename instead of silently following the new holder of a name.
 *   - **A group's platform id is its path with `/` folded to `-`** (`/seamnex-domains/core` →
 *     `seamnex-domains-core`), which is the convention the development seed already writes. The sync
 *     upserts on `idp_id` while `idp_group.path` is uniquely indexed, so a second spelling of the
 *     same path does not merge — it aborts the cycle with a unique violation.
 *   - **A group's members are subjects**, because `role_binding` is derived by joining the mirrored
 *     membership against `group_mapping`, which is keyed by group id and written by an admin.
 */
export type AdminUser = {
  readonly id: string;
  readonly username?: string;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly enabled?: boolean;
  readonly groups?: readonly string[];
};

type AdminGroup = {
  readonly id: string;
  readonly name: string;
  readonly path?: string;
  readonly subGroups?: readonly AdminGroup[];
};

type AdminCredential = { readonly type?: string };

const PAGE_SIZE = 100;
/** Bounded parallelism for the per-user credential read; a big realm must not flood Keycloak. */
const CREDENTIAL_CONCURRENCY = 8;

@Injectable()
export class KeycloakDirectoryReader {
  constructor(@Inject(KeycloakAdminClient) private readonly admin: KeycloakAdminClient) {}

  async snapshot(): Promise<DirectorySnapshot> {
    const [users, groups] = await Promise.all([this.users(), this.groups()]);

    // Reverse the membership so each user carries the paths it belongs to; `groups` on a user
    // representation is optional and often absent, while membership is authoritative.
    const memberships = new Map<string, string[]>();
    for (const group of groups) {
      for (const member of group.members) {
        const paths = memberships.get(member) ?? [];
        paths.push(group.path);
        memberships.set(member, paths);
      }
    }

    const enforced = await this.mfaFlags(users);
    return {
      users: users
        .map((user) =>
          this.toDirectoryUser(
            user,
            memberships.get(user.id) ?? [],
            enforced.get(user.id) === true,
          ),
        )
        .sort((left, right) => left.username.localeCompare(right.username)),
      groups: groups
        .map((group) => ({
          id: group.id,
          path: group.path,
          members: [...new Set(group.members)].sort(),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  private toDirectoryUser(
    user: AdminUser,
    paths: readonly string[],
    mfaEnrolled: boolean,
  ): DirectoryUser {
    const username = user.username ?? user.id;
    const displayName =
      [user.firstName, user.lastName]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' ') || username;
    return {
      sub: user.id,
      username,
      displayName,
      email: user.email ?? '',
      groups: [...new Set(paths)].sort(),
      // Keycloak omits `enabled` when it is true on some representations; absent means enabled.
      enabled: user.enabled !== false,
      mfaEnrolled,
    };
  }

  private async users(): Promise<AdminUser[]> {
    const collected: AdminUser[] = [];
    for (let first = 0; ; first += PAGE_SIZE) {
      const page = await this.admin.adminJson<AdminUser[]>(
        `/users?first=${first}&max=${PAGE_SIZE}&briefRepresentation=true`,
      );
      collected.push(...page);
      // A short page is the last page: Keycloak does not return a total for this endpoint.
      if (page.length < PAGE_SIZE) break;
    }
    return collected;
  }

  private async groups(): Promise<{ id: string; path: string; members: string[] }[]> {
    const collected: { id: string; path: string; members: string[] }[] = [];
    for (let first = 0; ; first += PAGE_SIZE) {
      const page = await this.admin.adminJson<AdminGroup[]>(
        `/groups?first=${first}&max=${PAGE_SIZE}&briefRepresentation=false`,
      );
      // Sub-groups arrive nested under their parent; flattening keeps one row per path, which is
      // what `idp_group` (a unique path) can represent.
      for (const group of page) await collect(group, null, collected, (id) => this.members(id));
      if (page.length < PAGE_SIZE) break;
    }
    return collected;
  }

  private async members(groupId: string): Promise<string[]> {
    const collected: string[] = [];
    for (let first = 0; ; first += PAGE_SIZE) {
      const page = await this.admin.adminJson<{ id: string }[]>(
        `/groups/${encodeURIComponent(groupId)}/members?first=${first}&max=${PAGE_SIZE}&briefRepresentation=true`,
      );
      collected.push(...page.map((member) => member.id));
      if (page.length < PAGE_SIZE) break;
    }
    return collected;
  }

  /**
   * `mfaEnrolled` is read from the user's credentials rather than guessed from a pending required
   * action: an account can have both an enrolled OTP credential and a stale `CONFIGURE_TOTP`
   * action, and the mirror is what the console shows an administrator before they disable an
   * account. The read is per user and bounded; a failure fails the cycle loudly instead of
   * mirroring "no second factor" for everyone.
   */
  private async mfaFlags(users: readonly AdminUser[]): Promise<Map<string, boolean>> {
    const flags = new Map<string, boolean>();
    const queue = [...users];
    const workers = Array.from(
      { length: Math.min(CREDENTIAL_CONCURRENCY, queue.length) },
      async () => {
        for (;;) {
          const user = queue.shift();
          if (user === undefined) return;
          const credentials = await this.admin.adminJson<AdminCredential[]>(
            `/users/${encodeURIComponent(user.id)}/credentials`,
          );
          flags.set(
            user.id,
            credentials.some((credential) => credential.type === 'otp'),
          );
        }
      },
    );
    await Promise.all(workers);
    return flags;
  }
}

/** Flattens the nested group tree, recording each node's full path and its members. */
async function collect(
  group: AdminGroup,
  parentPath: string | null,
  into: { id: string; path: string; members: string[] }[],
  members: (groupId: string) => Promise<string[]>,
): Promise<void> {
  const path = group.path ?? `${parentPath ?? ''}/${group.name}`;
  into.push({ id: groupIdOf(path), path, members: await members(group.id) });
  for (const child of group.subGroups ?? []) await collect(child, path, into, members);
}

/** `/seamnex-domains/core` → `seamnex-domains-core`, matching what the development seed writes. */
export function groupIdOf(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '-');
}
