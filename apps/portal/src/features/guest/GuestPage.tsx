import { useState } from 'react';
import { ArrowUpRight, Clock, Info, ShieldCheck } from 'lucide-react';
import { useLauncher, useMe } from '@seamnex/api-client';
import type { LauncherTile } from '@seamnex/domain';
import { GUARANTEE_CLASS_LABELS, PLAIN_STATUS_LABELS } from '@seamnex/domain';
import { QueryError, SignOutDialog } from '@seamnex/shell';
import {
  Badge,
  Button,
  Countdown,
  EmptyState,
  Grid,
  Page,
  Panel,
  SkeletonLines,
  StatusPill,
} from '@seamnex/ui';
import { formatDateTime, formatRelative } from '@seamnex/utils';
import { LaunchDialog } from '../../components/LaunchDialog';

/** R6: one scoped product surface, no catalog browsing, no entitlement summary. */
export function GuestPage() {
  const me = useMe();
  const launcher = useLauncher();
  const [launching, setLaunching] = useState<LauncherTile | null>(null);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const tile = launcher.data?.tiles[0] ?? null;

  if (launcher.isPending) {
    return (
      <Panel inset className="mt-2">
        <SkeletonLines lines={6} />
      </Panel>
    );
  }

  if (launcher.isError) {
    return <QueryError error={launcher.error} onRetry={() => void launcher.refetch()} />;
  }

  if (!tile) {
    return (
      <EmptyState
        title="This invitation has no product attached"
        description="The link may have expired or been revoked. Ask the person who invited you for a new link."
      />
    );
  }

  const status = PLAIN_STATUS_LABELS[tile.plainStatus];
  const auth = GUARANTEE_CLASS_LABELS[tile.guaranteeClass];

  return (
    <Page className="mx-auto max-w-2xl">
      <div className="mb-4 border-b border-line pb-4">
        <p className="label-caps">Guest access · scoped invitation</p>
        <h1 className="mt-1 font-display text-display font-semibold text-text">
          Hello{me.data ? `, ${me.data.displayName.split(' ')[0]}` : ''}.
        </h1>
        <p className="mt-1.5 text-body leading-relaxed text-muted">
          Your invitation grants access to a single product surface. There is no catalog browsing,
          no portal administration, and no entitlement summary.
        </p>
      </div>

      <Panel className="overflow-hidden">
        <div className="flex items-start justify-between gap-3 p-4">
          <div>
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 whitespace-nowrap rounded-xs border border-line bg-paper-deep px-1.5 py-0.5 font-mono text-micro font-semibold text-muted">
                {tile.entryKey}
              </span>
              <span className="label-caps">{tile.domain}</span>
            </div>
            <h2 className="mt-1.5 font-display text-title font-semibold text-text">
              {tile.product}
            </h2>
            <p className="mt-1 text-body leading-relaxed text-muted">{tile.description}</p>
          </div>
          <StatusPill tone={status.tone} label={status.label} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-panel-soft px-4 py-3">
          <Badge tone={auth.tone}>{auth.label}</Badge>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSignOutOpen(true)}>
              End session
            </Button>
            <Button
              variant="primary"
              size="sm"
              trailing={<ArrowUpRight />}
              disabled={!tile.launchable}
              onClick={() => setLaunching(tile)}
            >
              Open surface
            </Button>
          </div>
        </div>
      </Panel>

      <Grid cols={2} className="mt-3">
        <Panel inset>
          <p className="flex items-center gap-1.5 text-faint label-caps-sans">
            <Clock className="size-3.5" aria-hidden /> Session
          </p>
          <p className="mt-1.5 text-body font-semibold text-text">
            {me.data ? (
              // Announced once a minute, not once a second: the digits are decorative.
              <Countdown
                expiresAt={me.data.sessionExpiresAt}
                expiredClassName="text-danger"
                expiredLabel="Expired — the invitation must be reissued."
              />
            ) : (
              'Loading session…'
            )}
          </p>
          {me.data ? (
            <p className="mt-0.5 text-meta text-faint">
              Expires {formatDateTime(me.data.sessionExpiresAt)} · issued{' '}
              {formatRelative(me.data.identitySyncedAt)}
            </p>
          ) : null}
        </Panel>
        <Panel inset>
          <p className="flex items-center gap-1.5 text-faint label-caps-sans">
            <ShieldCheck className="size-3.5" aria-hidden /> Boundaries
          </p>
          <p className="mt-1.5 text-meta leading-relaxed text-muted">
            No catalog browsing. No administration. Access ends when the invitation expires or is
            revoked.
          </p>
        </Panel>
      </Grid>

      <p className="mt-4 flex items-start gap-2 text-meta leading-relaxed text-faint">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        The invitation, product availability and session lifetime are simulated from the platform
        fixture set.
      </p>

      <LaunchDialog
        tile={launching}
        onOpenChange={(open) => (open ? undefined : setLaunching(null))}
      />
      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </Page>
  );
}
