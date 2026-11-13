import { describe, expect, it, vi } from 'vitest';
import type { KeycloakAdminClient } from '../../../../src/common/keycloak/keycloak-admin.client';
import {
  groupIdOf,
  KeycloakDirectoryReader,
} from '../../../../src/common/keycloak/keycloak-directory.reader';

/**
 * The directory mirror's three conventions are load-bearing and none is visible in the Keycloak
 * payload: the subject is the realm UUID (not the username), a group's platform id is its path with
 * `/` folded to `-`, and a group's members are subjects. They are asserted here because a change to
 * any of them silently detaches existing `role_binding` and `entitlement` rows instead of failing.
 */
type Pages = Record<string, readonly unknown[]>;

function reader(pages: Pages): {
  reader: KeycloakDirectoryReader;
  paths: string[];
} {
  const paths: string[] = [];
  const admin = {
    adminJson: vi.fn(async (path: string) => {
      paths.push(path);
      for (const [fragment, rows] of Object.entries(pages)) {
        if (path.includes(fragment)) {
          const first = Number(/first=(\d+)/.exec(path)?.[1] ?? '0');
          return rows.slice(first, first + 100);
        }
      }
      return [];
    }),
  } as unknown as KeycloakAdminClient;
  return { reader: new KeycloakDirectoryReader(admin), paths };
}

describe('snapshot', () => {
  it('mirrors users with their subject, groups and MFA state', async () => {
    const { reader: subject } = reader({
      '/users?': [
        {
          id: 'uuid-1',
          username: 'alice',
          email: 'alice@example.test',
          firstName: 'Alice',
          lastName: 'Anderson',
          enabled: true,
        },
        { id: 'uuid-2', username: 'bob', enabled: false },
      ],
      '/groups?': [
        {
          id: 'group-1',
          name: 'core',
          path: '/seamnex-domains/core',
          subGroups: [{ id: 'group-2', name: 'ops' }],
        },
      ],
      '/members': [{ id: 'uuid-1' }, { id: 'uuid-1' }],
      '/credentials': [{ type: 'password' }, { type: 'otp' }],
    });

    const snapshot = await subject.snapshot();

    expect(snapshot.users).toEqual([
      {
        sub: 'uuid-1',
        username: 'alice',
        displayName: 'Alice Anderson',
        email: 'alice@example.test',
        groups: ['/seamnex-domains/core', '/seamnex-domains/core/ops'],
        enabled: true,
        mfaEnrolled: true,
      },
      {
        sub: 'uuid-2',
        username: 'bob',
        displayName: 'bob',
        email: '',
        groups: [],
        enabled: false,
        mfaEnrolled: true,
      },
    ]);
    expect(snapshot.groups).toEqual([
      { id: 'seamnex-domains-core', path: '/seamnex-domains/core', members: ['uuid-1'] },
      { id: 'seamnex-domains-core-ops', path: '/seamnex-domains/core/ops', members: ['uuid-1'] },
    ]);
  });

  it('derives the path of a sub-group that does not declare one', async () => {
    const { reader: subject } = reader({
      '/users?': [{ id: 'u1', username: 'u1' }],
      '/groups?': [
        { id: 'g1', name: 'parent', path: '/parent', subGroups: [{ id: 'g2', name: 'child' }] },
        { id: 'g3', name: 'orphan' },
      ],
      '/members': [],
      '/credentials': [],
    });

    const snapshot = await subject.snapshot();

    expect(snapshot.groups.map((group) => group.path)).toEqual([
      '/orphan',
      '/parent',
      '/parent/child',
    ]);
  });

  it('reads every page until one comes back short', async () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      id: `u${String(index).padStart(3, '0')}`,
      username: `user-${String(index).padStart(3, '0')}`,
    }));
    const { reader: subject, paths } = reader({
      '/users?': many,
      '/groups?': [],
      '/members': [],
      '/credentials': [],
    });

    const snapshot = await subject.snapshot();

    expect(snapshot.users).toHaveLength(250);
    expect(paths.filter((path) => path.startsWith('/users?'))).toHaveLength(3);
    expect(paths.filter((path) => path.startsWith('/users?'))[2]).toContain('first=200');
  });

  it('pages group members as well', async () => {
    const members = Array.from({ length: 120 }, (_, index) => ({ id: `m${index}` }));
    const { reader: subject, paths } = reader({
      '/users?': [],
      '/groups?': [{ id: 'g1', name: 'core', path: '/core' }],
      '/members': members,
      '/credentials': [],
    });

    const snapshot = await subject.snapshot();

    expect(snapshot.groups[0]?.members).toHaveLength(120);
    expect(paths.filter((path) => path.includes('/members?'))).toHaveLength(2);
  });

  it('reports a user with no username and no email from the id alone', async () => {
    const { reader: subject } = reader({
      '/users?': [{ id: 'only-id' }],
      '/groups?': [],
      '/members': [],
      '/credentials': [],
    });

    const [user] = (await subject.snapshot()).users;
    expect(user).toMatchObject({
      sub: 'only-id',
      username: 'only-id',
      displayName: 'only-id',
      email: '',
    });
  });

  it('reports MFA from the credentials, not from a required action', async () => {
    const { reader: subject } = reader({
      '/users?': [
        { id: 'with-otp', username: 'a' },
        { id: 'without-otp', username: 'b' },
      ],
      '/groups?': [],
      '/members': [],
      '/users/with-otp/credentials': [{ type: 'otp' }],
      '/users/without-otp/credentials': [{ type: 'password' }],
    });

    const snapshot = await subject.snapshot();

    expect(snapshot.users.map((user) => [user.sub, user.mfaEnrolled])).toEqual([
      ['with-otp', true],
      ['without-otp', false],
    ]);
  });

  it('sorts users by username and groups by path', async () => {
    const { reader: subject } = reader({
      '/users?': [
        { id: 'u3', username: 'carol' },
        { id: 'u1', username: 'alice' },
        { id: 'u2', username: 'bob' },
      ],
      '/groups?': [
        { id: 'g2', name: 'z', path: '/z' },
        { id: 'g1', name: 'a', path: '/a' },
      ],
      '/members': [],
      '/credentials': [],
    });

    const snapshot = await subject.snapshot();

    expect(snapshot.users.map((user) => user.username)).toEqual(['alice', 'bob', 'carol']);
    expect(snapshot.groups.map((group) => group.path)).toEqual(['/a', '/z']);
  });

  it('sorts a user into every group they belong to, once each', async () => {
    const { reader: subject } = reader({
      '/users?': [{ id: 'u1', username: 'alice' }],
      '/groups?': [
        { id: 'g1', name: 'one', path: '/one' },
        { id: 'g2', name: 'two', path: '/two' },
      ],
      '/members': [{ id: 'u1' }, { id: 'u1' }],
      '/credentials': [{ type: 'otp' }],
    });

    const [user] = (await subject.snapshot()).users;
    expect(user?.groups).toEqual(['/one', '/two']);
  });

  it('fails the cycle when a credential read fails instead of mirroring "no MFA"', async () => {
    const admin = {
      adminJson: vi.fn(async (path: string) => {
        if (path.startsWith('/users?')) return [{ id: 'u1', username: 'a' }];
        if (path.startsWith('/groups?')) return [{ id: 'g1', name: 'core', path: '/core' }];
        if (path.includes('/members')) return [];
        throw new Error('credentials unreadable');
      }),
    } as unknown as KeycloakAdminClient;

    await expect(new KeycloakDirectoryReader(admin).snapshot()).rejects.toThrow(
      'credentials unreadable',
    );
  });
});

describe('groupIdOf', () => {
  it('folds a path into the platform convention', () => {
    expect(groupIdOf('/seamnex-domains/core')).toBe('seamnex-domains-core');
    expect(groupIdOf('core')).toBe('core');
    expect(groupIdOf('/a/b/c')).toBe('a-b-c');
    expect(groupIdOf('/')).toBe('');
  });
});
