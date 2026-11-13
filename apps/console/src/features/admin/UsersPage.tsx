import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useUsers } from '@seamnex/api-client';
import type { IdpUser } from '@seamnex/domain';
import {
  Avatar,
  Badge,
  DataTable,
  EmptyState,
  FilterBar,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  StatusPill,
  defineColumns,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, useDebouncedValue } from '@seamnex/shell';

/**
 * Row identity at module scope.
 *
 * `DataTable` no longer compares props (ARCH-04 dropped the `memo` that never fired), so the cost of
 * a render is decided here: a `rowKey` created during render would defeat nothing on its own, but it
 * would re-create the identity function on every keystroke of the filter below.
 */
const rowKey = (row: IdpUser): string => row.id;

/**
 * The user's detail screen is the row's destination, so the identity cell *is* the row's link.
 *
 * The cell used to wrap only the display name in its own `<Link>`; that makes the rest of the cell
 * inert, and putting a second anchor around it (which is what a row link would be) is invalid HTML
 * and is skipped by the primitive's pointer handler. One anchor now owns the row: it is the single
 * keyboard stop, it opens in a new tab on a modifier click, and the primitive's row `onClick` is
 * gone with it.
 */
function renderUserLink(row: IdpUser, className: string, children: ReactNode): ReactNode {
  return (
    <Link to={`/admin/users/${row.id}`} className={className}>
      {children}
    </Link>
  );
}

/**
 * Every cell reads only its row, so the array is a module constant: no allocation, and the same
 * array identity for the life of the module.
 */
const columns = defineColumns<IdpUser>([
  {
    id: 'user',
    header: 'User',
    primary: true,
    cell: (row) => (
      <div className="flex items-center gap-2">
        <Avatar initials={row.initials} size="sm" tone="paper" />
        <div className="min-w-0">
          {/* No link and no type styles: `renderRowLink` owns the anchor, and its classes
              (`font-medium text-text hover:text-link`) are what make this read as one. */}
          <span className="block">{row.displayName}</span>
          <span className="block text-micro text-faint">{row.email}</span>
        </div>
      </div>
    ),
  },
  {
    id: 'roles',
    header: 'Platform roles',
    hideBelow: 'md',
    cell: (row) => (
      <div className="flex flex-wrap gap-1">
        {row.roles.map((role) => (
          <Badge key={`${role.role}-${role.scopeLabel}`} tone="neutral" size="sm">
            {role.role} · {role.scopeLabel}
          </Badge>
        ))}
      </div>
    ),
  },
  {
    id: 'groups',
    header: 'Groups',
    hideBelow: 'lg',
    cell: (row) => (
      <span className="font-mono text-micro text-muted">
        {row.groups.length > 0 ? row.groups.join(', ') : '—'}
      </span>
    ),
  },
  {
    id: 'entitlements',
    header: 'Entitlements',
    align: 'right',
    hideBelow: 'sm',
    mono: true,
    cell: (row) => <span className="text-micro text-muted">{row.entitlementCount}</span>,
  },
  {
    id: 'mfa',
    header: 'MFA',
    hideBelow: 'lg',
    cell: (row) =>
      row.mfaEnrolled ? (
        <Badge tone="positive" size="sm">
          enrolled
        </Badge>
      ) : (
        <Badge tone="caution" size="sm">
          not enrolled
        </Badge>
      ),
  },
  {
    id: 'enabled',
    header: 'State',
    cell: (row) => (
      <StatusPill
        tone={row.enabled ? 'positive' : 'danger'}
        label={row.enabled ? 'Enabled' : 'Disabled'}
        size="sm"
      />
    ),
  },
  {
    id: 'login',
    header: 'Last login',
    hideBelow: 'xl',
    cell: (row) => (
      <span className="text-micro text-muted">
        {row.lastLoginAt ? formatRelative(row.lastLoginAt) : 'never'}
      </span>
    ),
  },
]);

export function UsersPage() {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query);
  const users = useUsers(debouncedQuery.trim());
  const rows = users.data ?? [];

  return (
    <Page>
      {/* FR-4.4 — requirement id, developer-only; it used to be the page eyebrow and is not part
          of the rendered interface. */}
      <PageHeader
        title="Users"
        description="Identity-provider users mirrored into the platform. Disabling a user terminates sessions and revokes product access within one sync cycle."
        meta={
          <>
            <Badge tone="accent" size="sm">
              {rows.length} {rows.length === 1 ? 'user' : 'users'}
            </Badge>
            <Badge tone="danger" size="sm">
              {rows.filter((row) => !row.enabled).length} disabled
            </Badge>
            <Badge tone="caution" size="sm">
              {rows.filter((row) => !row.mfaEnrolled).length} without MFA
            </Badge>
          </>
        }
      />

      <Panel>
        <PanelHeader
          eyebrow="Directory mirror"
          title="User inventory"
          description="Membership is managed in the identity provider; the platform never keeps a second password store."
        />
        <FilterBar
          search={query}
          onSearch={setQuery}
          searchLabel="Search users"
          placeholder="Search name or e-mail"
          trailing={`${rows.length} shown`}
        />
        {/*
          The triple that used to live here (`isPending` → skeleton, `isError` → QueryError,
          `isSuccess` → table) is `AsyncPanel`'s contract now. The differences that mattered: a
          failed *refetch* keeps the rows on screen behind a caution banner, and the loading region
          announces itself instead of being silent (ERR-03, ERR-04).
        */}
        <AsyncPanel
          query={users}
          loading={
            <div className="p-4">
              <SkeletonLines lines={7} />
            </div>
          }
          loadingLabel="Loading the user inventory"
        >
          {(data) => (
            <DataTable
              columns={columns}
              rows={data}
              rowKey={rowKey}
              dense
              renderRowLink={renderUserLink}
              empty={
                <EmptyState
                  title="No directory users match"
                  description="Users are mirrored from the identity provider; the platform never creates accounts. Clear the search, or run a sync cycle to refresh the directory."
                />
              }
            />
          )}
        </AsyncPanel>
      </Panel>
    </Page>
  );
}
