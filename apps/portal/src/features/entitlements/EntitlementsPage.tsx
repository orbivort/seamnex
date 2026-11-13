import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { KeyRound, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { useEntitlements, useMe } from '@seamnex/api-client';
import { can, SYNC_STATE_LABELS } from '@seamnex/domain';
import {
  Avatar,
  Button,
  DataTable,
  DefinitionList,
  EmptyState,
  Grid,
  Page,
  Panel,
  PanelHeader,
  SkeletonLines,
  SplitLayout,
  Stat,
  StatusPill,
  defineColumns,
} from '@seamnex/ui';
import { AsyncPanel, SignOutDialog } from '@seamnex/shell';
import { formatDateTime, formatRelative } from '@seamnex/utils';
import { useSession } from '../../session';
import { RequestAccessButton } from '../access/RequestAccessDialog';

type Row = NonNullable<ReturnType<typeof useEntitlements>['data']>['entitlements'][number];

const rowKey = (row: Row): string => row.instanceId;

/**
 * The product's own page is what the portal exists to open, so the application cell is the row's
 * link. The cell used to carry its own `<Link>` around the product name — one anchor per row is
 * enough, and the primitive's row `onClick` is deliberately absent here (A11Y-04).
 */
function renderProductLink(row: Row, className: string, children: ReactNode): ReactNode {
  return (
    <Link to={`/product/${row.slug}`} className={className}>
      {children}
    </Link>
  );
}

/**
 * Every cell reads only its row, so the array is a module constant: the portal re-renders this
 * table on every keystroke in nothing at all, and there is no reason to rebuild sixty closures for
 * it (ARCH-04, CONS-04).
 */
const columns = defineColumns<Row>([
  {
    id: 'entry',
    header: 'Key',
    // 64px left 32px of text box once the cell's 16px inline padding is taken, so "D01-01"
    // wrapped after the hyphen. The width clears the identifier with the padding included.
    width: '5.25rem',
    cell: (row) => (
      <span className="whitespace-nowrap font-mono text-micro font-semibold text-muted">
        {row.entryKey}
      </span>
    ),
  },
  {
    id: 'product',
    header: 'Application',
    primary: true,
    cell: (row) => (
      <div className="min-w-0">
        <span className="block">{row.product}</span>
        <p className="mt-0.5 text-micro text-faint">{row.domain}</p>
      </div>
    ),
  },
  {
    id: 'role',
    header: 'Product role',
    hideBelow: 'md',
    cell: (row) => <span className="text-body text-muted">{row.productRole}</span>,
  },
  {
    id: 'auth',
    header: 'Sign-in path',
    hideBelow: 'lg',
    cell: (row) => (
      <span
        className={
          row.authLabel === 'Sign-in required'
            ? 'text-meta text-warning-strong'
            : 'text-meta text-muted'
        }
      >
        {row.authLabel}
      </span>
    ),
  },
  {
    id: 'sync',
    header: 'Sync',
    hideBelow: 'sm',
    cell: (row) => {
      const spec = SYNC_STATE_LABELS[row.syncState];
      return <StatusPill tone={spec.tone} label={spec.label} size="sm" />;
    },
  },
  {
    id: 'source',
    header: 'Granted by',
    hideBelow: 'xl',
    cell: (row) => <span className="font-mono text-micro text-faint">{row.groupPath}</span>,
  },
]);

export function EntitlementsPage() {
  const { session } = useSession();
  const me = useMe();
  const entitlements = useEntitlements(session.role !== 'R6');
  const [signOutOpen, setSignOutOpen] = useState(false);

  const summary = entitlements.data?.summary;

  return (
    <Page>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
        <div>
          <p className="label-caps">Account</p>
          <h1 className="mt-1 font-display text-display font-semibold tracking-tight text-text">
            My access
          </h1>
          <p className="mt-1.5 max-w-2xl text-body text-muted">
            Every product you can open, the role you hold inside it, and when the platform last
            synchronised that grant from the identity provider.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RequestAccessButton />
          <Button variant="secondary" icon={<KeyRound />} onClick={() => setSignOutOpen(true)}>
            Sign out…
          </Button>
        </div>
      </div>

      {!can(session.role, 'portal.view_entitlements') ? (
        <EmptyState
          title="Guest access is scoped to one product"
          description="Your invitation links directly to the shared surface. Catalog browsing and entitlement summaries are not available to guests."
          action={
            <Button variant="primary" onClick={() => setSignOutOpen(true)}>
              End guest session
            </Button>
          }
        />
      ) : null}

      {can(session.role, 'portal.view_entitlements') ? (
        <>
          <SplitLayout ratio="content" className="mb-4">
            <Panel>
              <PanelHeader
                eyebrow="Identity"
                title={
                  <span className="flex items-center gap-2">
                    <Avatar initials={me.data?.initials ?? '—'} tone="teal" />
                    {me.data?.displayName ?? 'Loading identity'}
                  </span>
                }
                description={me.data ? `${me.data.email} · ${me.data.username}` : undefined}
                actions={
                  me.data ? (
                    <StatusPill
                      tone={me.data.mfaSatisfied ? 'positive' : 'caution'}
                      label={
                        me.data.mfaSatisfied
                          ? `MFA satisfied · ${me.data.mfaMethod}`
                          : 'MFA not satisfied'
                      }
                    />
                  ) : null
                }
              />
              <div className="p-4">
                {me.isPending ? <SkeletonLines lines={4} /> : null}
                {me.data ? (
                  <DefinitionList
                    columns={2}
                    items={[
                      {
                        label: 'Platform roles',
                        value: me.data.roles
                          .map((role) => `${role.role} · ${role.scopeLabel}`)
                          .join(', '),
                      },
                      { label: 'Directory groups', value: me.data.groups.join(', '), mono: true },
                      {
                        label: 'Identity synced',
                        value: formatRelative(me.data.identitySyncedAt),
                        hint: formatDateTime(me.data.identitySyncedAt),
                      },
                      { label: 'Session expires', value: formatDateTime(me.data.sessionExpiresAt) },
                    ]}
                  />
                ) : null}
              </div>
            </Panel>

            <Panel>
              <PanelHeader eyebrow="Coverage" title="Entitlement summary" />
              <Grid cols={2} className="gap-4 p-4">
                <Stat
                  label="Applications"
                  value={summary?.total ?? '—'}
                  tone="accent"
                  hint="Granted to your groups"
                />
                <Stat
                  label="Domains"
                  value={summary?.domains ?? '—'}
                  hint="Business domains covered"
                />
                <Stat
                  label="Pending sync"
                  value={summary?.pending ?? 0}
                  tone={summary?.pending ? 'caution' : 'neutral'}
                  hint="Propagates within 5 min p95"
                />
                <Stat
                  label="Own credential"
                  value={summary?.signInRequired ?? 0}
                  tone={summary?.signInRequired ? 'caution' : 'neutral'}
                  hint="Never single sign-on"
                />
              </Grid>
              <div className="flex items-start gap-2 border-t border-line px-4 py-2.5 text-meta leading-relaxed text-faint">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Roles come from identity-provider groups. Disabling your account revokes product
                access within one sync cycle.
              </div>
            </Panel>
          </SplitLayout>

          <Panel>
            <PanelHeader
              eyebrow={`${summary?.total ?? 0} grants`}
              title="Entitled applications"
              description="Entitlement is the intersection of role and instance scope. Only entitled applications appear."
              actions={
                <Button
                  size="sm"
                  variant="quiet"
                  icon={<RefreshCw />}
                  onClick={() => void entitlements.refetch()}
                  disabled={entitlements.isFetching}
                >
                  {entitlements.isFetching ? 'Refreshing' : 'Refresh'}
                </Button>
              }
            />
            {/*
              A failed *refetch* keeps the grants an employee is reading; only a first failure
              replaces the table with the problem panel (ERR-04). The refresh button above stays
              usable in both cases.
            */}
            <AsyncPanel
              query={entitlements}
              loading={
                <div className="p-4">
                  <SkeletonLines lines={6} />
                </div>
              }
              loadingLabel="Loading your entitled applications"
            >
              {(data) => (
                <DataTable
                  columns={columns}
                  rows={data.entitlements}
                  rowKey={rowKey}
                  caption="Granted by directory group; synced from the identity provider."
                  renderRowLink={renderProductLink}
                  empty={
                    <EmptyState
                      compact
                      icon={<Users className="size-5" />}
                      title="No entitlements"
                      description="Your groups do not grant any product access yet."
                    />
                  }
                />
              )}
            </AsyncPanel>
          </Panel>
        </>
      ) : null}

      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </Page>
  );
}
