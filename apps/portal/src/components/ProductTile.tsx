import { ArrowUpRight, ArrowUpCircle, Info, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router';
import type { LauncherTile } from '@seamnex/domain';
import { formatVersion, GUARANTEE_CLASS_LABELS, PLAIN_STATUS_LABELS } from '@seamnex/domain';
import { Badge, Button, StatusPill, Tooltip } from '@seamnex/ui';
import { cn, formatRelative } from '@seamnex/utils';

/**
 * The footer claim is a claim about what happens on launch, so it follows `ssoState` — the same
 * fact the launch target is computed from. Deriving it from the guarantee class alone printed
 * "Single sign-on" over a card whose launch path asks for a product password.
 */
function signInCopy(tile: LauncherTile): { sso: boolean; short: string; detail: string } {
  const sso = tile.ssoState === null ? tile.guaranteeClass !== 'fa_gate' : tile.ssoState === 'sso';
  if (sso) {
    return {
      sso,
      short: 'Single sign-on',
      detail: 'Opens with your existing portal session. No second password.',
    };
  }
  if (tile.ssoState === 'sso_unverified') {
    // Registered but unproven. "Single sign-on" would promise a redirect that may fail, and
    // "Sign-in required" would describe a product that has no local credential to offer.
    return {
      sso,
      short: 'SSO unverified',
      detail: tile.ssoHealth.checked
        ? `Wired for single sign-on, but the last end-to-end check did not pass: ${tile.ssoHealth.detail}`
        : 'Wired for single sign-on, but no end-to-end check has proven that the sign-in completes.',
    };
  }
  return {
    sso,
    short: tile.guaranteeClass === 'fa_gate' ? 'Credential outside platform' : 'Sign-in required',
    detail:
      tile.guaranteeClass === 'fa_gate'
        ? GUARANTEE_CLASS_LABELS.fa_gate.description
        : 'This deployment asks for a product credential at launch; single sign-on is not wired up for it.',
  };
}

export function ProductTile({
  tile,
  onLaunch,
}: {
  tile: LauncherTile;
  onLaunch: (tile: LauncherTile) => void;
}) {
  const status = PLAIN_STATUS_LABELS[tile.plainStatus];
  const signIn = signInCopy(tile);
  // "Not launchable" is a permission answer and only true when the product itself is fine. Every
  // other disabled state is the product's own status, and printing "Unavailable" over a degraded
  // instance told the user the opposite of what the status pill said.
  const deniedByRole = !tile.launchable && tile.plainStatus === 'available';
  const actionLabel = tile.launchable ? 'Open' : deniedByRole ? 'Not launchable' : status.label;
  const rail =
    tile.plainStatus === 'available'
      ? 'bg-primary'
      : tile.plainStatus === 'degraded'
        ? 'bg-warning'
        : tile.plainStatus === 'maintenance'
          ? 'bg-info'
          : 'bg-danger';

  return (
    <article className="group animate-rise relative flex flex-col overflow-hidden rounded-md border border-line bg-panel shadow-panel transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-primary-hover hover:shadow-lift">
      <span aria-hidden className={cn('h-1 w-full', rail)} />

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {/* The catalog code is one identifier and must never break across lines: on a 390px
                card it used to render as "D01-" above "01". */}
            <span className="shrink-0 whitespace-nowrap rounded-xs border border-line bg-paper-deep px-1.5 py-0.5 font-mono text-micro font-semibold tracking-[0.08em] text-muted">
              {tile.entryKey}
            </span>
            <span className="label-caps">{tile.domain}</span>
          </div>
          <Tooltip
            content={`${status.description} Status observed ${formatRelative(tile.lastVerifiedAt)}.`}
          >
            <span>
              <StatusPill
                tone={status.tone}
                label={status.label}
                size="sm"
                pulse={tile.plainStatus === 'degraded'}
              />
            </span>
          </Tooltip>
        </div>

        <div>
          <h3 className="font-display text-title font-semibold text-text">
            <Link
              to={`/product/${tile.slug}`}
              className="rounded-xs decoration-primary underline-offset-2 hover:underline"
            >
              {tile.product}
            </Link>
          </h3>
          {/*
            One product can be deployed several times (a production instance, an end-to-end test
            one, a second team's). The deployment address and the version are what tell those tiles
            apart; without them three cards read as one entry duplicated three times.
          */}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-micro text-faint">
            <span className="truncate" title={tile.url}>
              {tile.slug}
            </span>
            <span aria-hidden>·</span>
            {/* The prefix is added here and only here: the version can arrive as a raw image tag
                (`v16.53.0`), so interpolating one printed `vv16.53.0`. */}
            <span>{formatVersion(tile.version) ?? 'version unknown'}</span>
            {tile.availableVersion === null ? null : (
              <Tooltip
                content={`The catalog is on ${formatVersion(tile.availableVersion)}; this deployment runs ${formatVersion(tile.version) ?? 'an unknown version'}.`}
              >
                <span className="inline-flex items-center gap-1 rounded-xs border border-warning/25 bg-warning-soft px-1 py-px text-warning-strong label-caps-sans">
                  <ArrowUpCircle className="size-3" aria-hidden />
                  {formatVersion(tile.availableVersion)} available
                </span>
              </Tooltip>
            )}
          </p>
          <p className="mt-1.5 text-body leading-snug text-muted">{tile.description}</p>
        </div>

        {tile.degradedReason ? (
          <p className="rounded-xs border border-warning/25 bg-warning-soft/50 px-2 py-1.5 text-meta leading-snug text-warning-strong">
            {tile.degradedReason}
          </p>
        ) : null}
        {tile.maintenanceTitle ? (
          <p className="rounded-xs border border-info/25 bg-info-soft/50 px-2 py-1.5 text-meta leading-snug text-info">
            Maintenance: {tile.maintenanceTitle}
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {/* The badge and the footer make the same claim, so both follow the same sign-in shape. */}
          <Badge tone={signIn.sso ? 'accent' : 'caution'} size="sm">
            {signIn.sso ? null : <ShieldAlert aria-hidden className="size-3" />}
            {tile.authLabel}
          </Badge>
          <span className="text-micro text-faint">{tile.productRole}</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line bg-panel-soft px-4 py-2.5">
        <Tooltip content={signIn.detail}>
          <span className="inline-flex items-center gap-1 text-faint label-caps-sans">
            <Info className="size-3" aria-hidden />
            {signIn.short}
          </span>
        </Tooltip>

        <div className="flex items-center gap-1">
          <Link
            to={`/product/${tile.slug}`}
            className="rounded-xs px-2 py-1 text-meta font-medium text-muted hover:bg-paper-deep hover:text-link"
          >
            Details
          </Link>
          <Button
            size="sm"
            variant={tile.launchable ? 'primary' : 'secondary'}
            disabled={!tile.launchable}
            onClick={() => onLaunch(tile)}
            trailing={<ArrowUpRight />}
            aria-label={
              tile.launchable
                ? `Open ${tile.product}`
                : deniedByRole
                  ? `Your role cannot launch ${tile.product}`
                  : `${tile.product} is ${status.label.toLowerCase()}: ${status.description}`
            }
            title={
              tile.launchable
                ? `Open ${tile.product}`
                : deniedByRole
                  ? 'Your role cannot launch products'
                  : status.description
            }
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </article>
  );
}
