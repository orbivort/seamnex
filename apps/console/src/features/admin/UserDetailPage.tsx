import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, ShieldOff, UserX } from 'lucide-react';
import { useDisableUser, useUser, useUserEntitlements } from '@seamnex/api-client';
import { canMutate } from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DefinitionList,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  SplitLayout,
  StatusPill,
} from '@seamnex/ui';
import { formatDateTime } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { useSession } from '../../session';

export function UserDetailPage() {
  const { id = '' } = useParams();
  const { session } = useSession();
  const user = useUser(id);
  const entitlements = useUserEntitlements(id);
  const disable = useDisableUser();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Read access is `identity.view_users`; only a full `identity.manage_users` grant may disable.
  const canDisable = canMutate(session.role, 'identity.manage_users');

  if (user.isPending) {
    return (
      <Panel inset>
        <SkeletonLines lines={8} />
      </Panel>
    );
  }
  if (user.isError) return <QueryError error={user.error} onRetry={() => void user.refetch()} />;

  const data = user.data;

  return (
    <Page>
      <Link
        to="/admin/users"
        className="mb-3 inline-flex items-center gap-1.5 text-meta font-medium text-muted hover:text-link"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Users
      </Link>

      <PageHeader
        eyebrow={
          <>
            <StatusPill
              tone={data.enabled ? 'positive' : 'danger'}
              label={data.enabled ? 'Enabled' : 'Disabled'}
              size="sm"
            />
            <span className="font-mono text-faint label-caps">idp · {data.id}</span>
          </>
        }
        title={data.displayName}
        description={`${data.jobTitle} · ${data.email}`}
        actions={
          canDisable ? (
            <Button
              variant="danger"
              size="sm"
              icon={<UserX />}
              disabled={!data.enabled}
              onClick={() => setConfirmOpen(true)}
            >
              Disable user
            </Button>
          ) : null
        }
      />

      <SplitLayout ratio="content">
        <Panel>
          <PanelHeader eyebrow="Identity" title="Provider record" />
          <div className="p-4">
            <DefinitionList
              columns={1}
              items={[
                { label: 'Username', value: data.username, mono: true },
                { label: 'Groups', value: data.groups.join(', ') || '—', mono: true },
                {
                  label: 'Platform roles',
                  value: data.roles.map((role) => `${role.role} · ${role.scopeLabel}`).join(', '),
                },
                { label: 'MFA', value: data.mfaEnrolled ? 'Enrolled' : 'Not enrolled' },
                {
                  label: 'Last login',
                  value: data.lastLoginAt ? formatDateTime(data.lastLoginAt) : 'Never',
                },
                { label: 'Created', value: formatDateTime(data.createdAt) },
              ]}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            eyebrow="Offboarding evidence"
            title="Product entitlements"
            description="Enumerated before disabling, so nothing is revoked silently."
          />
          {/*
            One async region for the entitlement list. The screen-level gates above stay: a failed
            *user* read leaves nothing to show, so it is a whole-screen return, not a panel branch.
          */}
          <AsyncPanel
            query={entitlements}
            loading={
              <div className="p-4">
                <SkeletonLines lines={4} />
              </div>
            }
            loadingLabel="Loading product entitlements"
            empty={(data) =>
              data.entitlements.length === 0 && (
                <div className="p-4">
                  <EmptyState
                    title="No product entitlements"
                    description="Disabling this account revokes nothing in the products. The directory groups are the only source of product access."
                  />
                </div>
              )
            }
          >
            {(data) => (
              <ul className="divide-y divide-line">
                {data.entitlements.map((item) => (
                  <li
                    key={item.instanceId}
                    className="flex items-center justify-between gap-3 px-4 py-2"
                  >
                    <span className="text-meta text-text">
                      <span className="font-mono text-micro text-faint">{item.entryKey}</span>{' '}
                      {item.product}
                    </span>
                    <Badge tone="neutral" size="sm">
                      {item.productRole}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </AsyncPanel>
        </Panel>
      </SplitLayout>

      {disable.data ? (
        <div className="mt-3">
          <Callout tone="caution" title={`Disabled at ${formatDateTime(disable.data.disabledAt)}`}>
            {disable.data.sessionsTerminated} platform sessions terminated.{' '}
            {disable.data.propagationNote}
          </Callout>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Disable ${data.displayName}?`}
        description="The account is disabled in the identity provider. Platform sessions end immediately; product access is revoked within one sync cycle."
        confirmLabel="Disable user"
        requireText={data.username}
        busy={disable.isPending}
        consequence={
          <p className="text-meta text-muted">
            {data.entitlementCount} product entitlements will be revoked. The audit record includes
            the actor, the enumeration and the outcome.
          </p>
        }
        onConfirm={() => {
          disable.mutate(data.id, {
            onSuccess: () => setConfirmOpen(false),
          });
        }}
      />

      {disable.isError ? <QueryError error={disable.error} compact /> : null}
      <p className="mt-3 flex items-center gap-1.5 text-micro text-faint">
        <ShieldOff className="size-3.5" aria-hidden />
        R2 can read this evidence but cannot disable a user. R3 may request a membership change.
      </p>
    </Page>
  );
}
