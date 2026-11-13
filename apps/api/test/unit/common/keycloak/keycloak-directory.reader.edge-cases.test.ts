import { describe, expect, it, vi } from 'vitest';
import type { KeycloakAdminClient } from '../../../../src/common/keycloak/keycloak-admin.client';
import { KeycloakDirectoryReader } from '../../../../src/common/keycloak/keycloak-directory.reader';

/**
 * `GET /groups` has no total, so "a short page is the last page" is the only stop condition. A realm
 * whose group count is an exact multiple of the page size therefore cannot stop on the page it just
 * read: it must ask once more and receive an empty page, or the last page is silently dropped and
 * every membership in it disappears from the mirror on the next sync.
 */
type Pages = Record<string, readonly unknown[]>;

function reader(pages: Pages): { reader: KeycloakDirectoryReader; paths: string[] } {
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

function groups(count: number): Array<{ id: string; name: string; path: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `g${String(index).padStart(3, '0')}`,
    name: `group-${String(index).padStart(3, '0')}`,
    path: `/group-${String(index).padStart(3, '0')}`,
  }));
}

describe('group paging', () => {
  it('reads the second page when the first one is full', async () => {
    const { reader: subject, paths } = reader({
      '/users?': [],
      '/groups?': groups(120),
      '/members': [],
      '/credentials': [],
    });

    const snapshot = await subject.snapshot();

    expect(snapshot.groups).toHaveLength(120);
    const pageCalls = paths.filter((path) => path.startsWith('/groups?'));
    expect(pageCalls).toHaveLength(2);
    expect(pageCalls[1]).toContain('first=100');
    // Every group on the second page still had its membership read.
    expect(paths.filter((path) => path.includes('/members?'))).toHaveLength(120);
  });

  it('asks once more when the last page is exactly full, so nothing is dropped', async () => {
    const { reader: subject, paths } = reader({
      '/users?': [],
      '/groups?': groups(100),
      '/members': [],
      '/credentials': [],
    });

    const snapshot = await subject.snapshot();

    expect(snapshot.groups).toHaveLength(100);
    expect(snapshot.groups.at(-1)).toEqual({
      id: 'group-099',
      path: '/group-099',
      members: [],
    });
    expect(paths.filter((path) => path.startsWith('/groups?'))).toHaveLength(2);
  });

  it('pages members of a group as well as the groups themselves', async () => {
    const { reader: subject, paths } = reader({
      '/users?': [],
      '/groups?': groups(150),
      '/members': [{ id: 'u1' }],
      '/credentials': [],
    });

    const snapshot = await subject.snapshot();

    expect(snapshot.groups).toHaveLength(150);
    // Two group pages, and one member page per group: the two loops must not share a cursor.
    expect(
      paths.filter((path) => path.startsWith('/groups?') && path.includes('first=0')),
    ).toHaveLength(1);
    expect(
      paths.filter((path) => path.startsWith('/groups?') && path.includes('first=100')),
    ).toHaveLength(1);
    expect(
      paths.filter((path) => path.includes('/members?') && path.includes('first=0')),
    ).toHaveLength(150);
  });
});
