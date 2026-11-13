import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, ArrowUpRight, Clock, Globe, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useProductTile } from '@seamnex/api-client';
import type { LauncherTile } from '@seamnex/domain';
import {
  formatVersion,
  GUARANTEE_CLASS_LABELS,
  PLAIN_STATUS_LABELS,
  ROLE_LABELS,
} from '@seamnex/domain';
import {
  Badge,
  Button,
  DefinitionList,
  EmptyState,
  Page,
  Panel,
  PanelHeader,
  SkeletonLines,
  SplitLayout,
  StatusPill,
} from '@seamnex/ui';
import { formatDateTime, formatRelative } from '@seamnex/utils';
import { useSession } from '../../session';
import { LaunchDialog } from '../../components/LaunchDialog';
import { QueryError } from '@seamnex/shell';
import { describeSsoHealth } from '../../components/sso-health';

export function ProductPage() {
  const { slug = '' } = useParams();
  const { session } = useSession();
  // A deep link resolves its own tile instead of downloading the whole launcher (FR-2.11).
  const product = useProductTile(slug);
  const [launching, setLaunching] = useState<LauncherTile | null>(null);

  const tile = product.data ?? null;

  if (product.isPending) {
    return (
      <Panel inset className="mt-2">
        <SkeletonLines lines={8} />
      </Panel>
    );
  }

  if (product.isError) {
    return <QueryError error={product.error} onRetry={() => void product.refetch()} />;
  }

  if (!tile) {
    return (
      <EmptyState
        title="This application is not available to your role"
        description="Either the application is not deployed in this environment, or your groups do not grant access. Unentitled applications are absent from the catalog rather than shown disabled."
        action={
          <Link
            to="/"
            className="inline-flex h-9 items-center rounded-sm border border-line-strong bg-panel px-3.5 text-body font-semibold text-text hover:border-primary hover:text-link"
          >
            Back to launcher
          </Link>
        }
      />
    );
  }

  const status = PLAIN_STATUS_LABELS[tile.plainStatus];
  const auth = GUARANTEE_CLASS_LABELS[tile.guaranteeClass];
  // Same derivation as the tile footer: what happens at launch, not what the class promises.
  const singleSignOn =
    tile.ssoState === null ? tile.guaranteeClass !== 'fa_gate' : tile.ssoState === 'sso';
  // Wired for single sign-on, but the platform has no recent proof that it completes. It is not a
  // gate (there is no local credential for most users) and it is not single sign-on either.
  const unverified = tile.ssoState === 'sso_unverified';
  const gate = !singleSignOn && !unverified;
  const address = tile.url.replace(/^https?:\/\//, '');

  return (
    <Page>
      <Link
        to="/"
        className="mb-3 inline-flex items-center gap-1.5 rounded-xs text-meta font-medium text-muted hover:text-link"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> All applications
      </Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="rounded-xs border border-line bg-paper-deep px-1.5 py-0.5 font-mono text-micro font-semibold tracking-[0.08em] text-muted">
              {tile.entryKey}
            </span>
            <span className="font-mono text-faint label-caps">{tile.domain}</span>
            <StatusPill tone={status.tone} label={status.label} size="sm" />
          </div>
          <h1 className="font-display text-display font-semibold tracking-tight text-text">
            {tile.product}
          </h1>
          <p className="mt-1.5 max-w-2xl text-body leading-relaxed text-muted">
            {tile.description}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-3 text-meta text-faint">
            {/* The address comes from the payload, not from `${slug}.seamnex.local`: the ingress domain
                differs per environment, so a constructed host is wrong everywhere but dev. */}
            <span className="inline-flex items-center gap-1">
              <Globe className="size-3.5" aria-hidden />
              <span className="font-mono">{address}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden />
              status observed {formatRelative(tile.lastVerifiedAt)}
            </span>
            <span className="font-mono">{formatVersion(tile.version) ?? 'version unknown'}</span>
          </p>
        </div>
        {/* Full width once the header stacks, so the page's one primary action reads as a
            button row instead of a narrow block with a right-aligned caption under it. */}
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto">
          <Button
            variant="primary"
            size="lg"
            trailing={<ArrowUpRight />}
            disabled={!tile.launchable}
            onClick={() => setLaunching(tile)}
          >
            {tile.launchable ? `Open ${tile.product}` : 'Not launchable'}
          </Button>
          {/*
            The subtitle under the button said "uses your existing portal session" for every
            launchable product, including a proxy gate — where the portal session only opens the
            route and the product then asks for its own password. The page's own "not single
            sign-on" note and step 4 of "On launch" contradicted it, so the promise now follows the
            class in force, like every other sentence on this page.
          */}
          <p className="max-w-56 text-left text-micro leading-snug text-faint sm:text-right">
            {!tile.launchable
              ? gate
                ? 'Sign-in required: it is not launchable for you right now.'
                : 'Your role cannot launch this product.'
              : gate
                ? 'Opens in a new tab after the route check; the sign-in path is shown below.'
                : unverified
                  ? 'Wired for single sign-on; the platform has no recent proof that it completes.'
                  : 'Uses your existing portal session; opens in a new tab.'}
          </p>
        </div>
      </div>

      <SplitLayout ratio="content">
        <div className="space-y-3">
          {tile.degradedReason ? (
            <div className="rounded-md border border-warning-border bg-warning-soft/50 px-3.5 py-3">
              <p className="text-body font-semibold text-warning-strong">
                The application is currently degraded
              </p>
              <p className="mt-1 text-body leading-relaxed text-muted">{tile.degradedReason}</p>
            </div>
          ) : null}

          <Panel>
            <PanelHeader eyebrow="Sign-in path" title={auth.label} description={auth.description} />
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={unverified ? 'caution' : auth.tone}>
                  {/* ADR-BE-22: a relayed gate's credential is held by the platform, so the badge
                      may not claim the user brings their own. It says what the class guarantees. */}
                  {unverified ? 'SSO unverified' : gate ? 'Gate credential' : 'Single sign-on'}
                </Badge>
                <span className="text-meta text-muted">
                  {unverified
                    ? 'The product is wired to the platform identity provider, but the platform has no recent proof that the sign-in completes. The last check is below.'
                    : gate
                      ? // ADR-BE-22: for some gates the platform holds a per-user account it created,
                        // so the class description may not promise that it never stores a password.
                        'The platform protects the route. Whether the product asks for a password depends on the deployment, and it is never called single sign-on.'
                      : 'Your identity-provider session is used directly. No platform-issued product password exists.'}
                </span>
              </div>
              <div className="rounded-sm border border-line bg-panel-soft p-3">
                <p className="text-faint label-caps-sans">On launch</p>
                <ol className="mt-2 space-y-1.5 text-body leading-relaxed text-muted">
                  <li>1. The platform checks your entitlement for this instance.</li>
                  <li>
                    {unverified
                      ? '2. The product redirects to the identity provider. This is the step the platform could not verify.'
                      : '2. Your session is presented to the product through the verified path.'}
                  </li>
                  <li>3. The product opens in a new tab; the portal stays available behind it.</li>
                  {gate ? (
                    <li>
                      4. The product signs you in with an account the platform manages for you, or
                      asks for a credential issued outside the platform.
                    </li>
                  ) : null}
                </ol>
              </div>

              {unverified ? (
                <div className="rounded-sm border border-warning/40 bg-warning/5 p-3">
                  <p className="text-meta font-semibold text-warning-strong">
                    End-to-end sign-in check
                  </p>
                  <p className="mt-1 text-meta leading-relaxed text-muted">
                    {describeSsoHealth(tile.ssoHealth, tile.lastVerifiedAt)}
                  </p>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader eyebrow="Status" title="Availability" />
            <div className="p-4">
              <DefinitionList
                columns={2}
                items={[
                  { label: 'Plain-language status', value: status.label, hint: status.description },
                  { label: 'Last observed', value: formatDateTime(tile.lastVerifiedAt) },
                  {
                    label: 'Version deployed',
                    // Same single prefix as the header: the raw value may already carry one.
                    value: formatVersion(tile.version) ?? 'Not known',
                    mono: tile.version !== null,
                  },
                  {
                    label: 'Catalog pin',
                    value:
                      tile.availableVersion === null
                        ? (formatVersion(tile.version) ?? 'Not known')
                        : `${formatVersion(tile.availableVersion)} available`,
                    hint:
                      tile.availableVersion === null
                        ? undefined
                        : `This deployment runs ${formatVersion(tile.version) ?? 'an unknown version'}.`,
                  },
                  { label: 'Maintenance', value: tile.maintenanceTitle ?? 'None active' },
                  { label: 'Launchable by you', value: tile.launchable ? 'Yes' : 'No' },
                ]}
              />
            </div>
          </Panel>
        </div>

        <div className="space-y-3">
          <Panel>
            <PanelHeader eyebrow="Your access" title={tile.productRole} />
            <div className="space-y-3 p-4">
              <DefinitionList
                columns={1}
                items={[
                  {
                    label: 'Platform role',
                    value: `${session.role} · ${ROLE_LABELS[session.role].name}`,
                  },
                  { label: 'Instance', value: tile.instanceId, mono: true },
                  { label: 'Entitlement source', value: 'Identity-provider group' },
                ]}
              />
              <Link
                to="/entitlements"
                className="inline-flex items-center gap-1 text-meta font-medium text-link underline-offset-2 hover:underline"
              >
                View all entitlements
              </Link>
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              eyebrow="Honesty note"
              title={gate ? 'This is not single sign-on' : 'What SSO means here'}
            />
            <div className="flex items-start gap-2 p-4 text-meta leading-relaxed text-muted">
              {gate ? (
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning-strong" aria-hidden />
              ) : (
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              )}
              {gate
                ? 'Only native, header-injection and delegated sign-in are described as single sign-on. This product is a proxy gate: the tile says "sign-in required" before you open it, not after.'
                : 'The platform issues no product password. Access is revoked within one sync cycle when your group membership changes.'}
            </div>
          </Panel>
        </div>
      </SplitLayout>

      <LaunchDialog
        tile={launching}
        onOpenChange={(open) => (open ? undefined : setLaunching(null))}
      />
    </Page>
  );
}
