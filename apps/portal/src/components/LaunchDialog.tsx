import { ArrowUpRight, ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useLaunchTarget, useLaunchTicket, useRecordLaunch } from '@seamnex/api-client';
import type { LauncherTile } from '@seamnex/domain';
import { GUARANTEE_CLASS_LABELS } from '@seamnex/domain';
import { Badge, Button, CopyButton, Dialog, InlineNote, Mono, SkeletonLines } from '@seamnex/ui';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { mocksEnabled } from '../api-mode';
import { describeSsoHealth } from './sso-health';

export function LaunchDialog({
  tile,
  onOpenChange,
}: {
  tile: LauncherTile | null;
  onOpenChange: (open: boolean) => void;
}) {
  const target = useLaunchTarget(tile?.instanceId ?? '', tile !== null);
  const ticket = useLaunchTicket();
  const launch = useRecordLaunch();

  /*
   * A forward-auth product needs the platform session planted on its own host first. The tab is
   * claimed *before* awaiting the ticket: a popup opened after an await is blocked, and the user
   * would see nothing happen at all. `opener` is cut before navigating so the product tab cannot
   * reach back into the portal.
   */
  const open = async (): Promise<void> => {
    if (!target.data) return;
    // Recorded before the tab opens: the click is the last moment the platform is part of this.
    void launch.mutateAsync(target.data.instanceId).catch(() => undefined);
    if (!target.data.bootstrapRequired) {
      window.open(target.data.url, '_blank', 'noopener,noreferrer');
      return;
    }
    const tab = window.open('about:blank', '_blank');
    try {
      const { url } = await ticket.mutateAsync(target.data.instanceId);
      if (tab === null) {
        window.location.assign(url);
      } else {
        tab.opener = null;
        tab.location.replace(url);
      }
      onOpenChange(false);
    } catch {
      // Not swallowed: the refusal is rendered in the dialog from `ticket.isError` below. This
      // only closes the blank tab claimed up front, so a failed launch leaves no dead window.
      tab?.close();
    }
  };

  return (
    <Dialog
      open={tile !== null}
      onOpenChange={onOpenChange}
      title={tile ? `Open ${tile.product}` : 'Open product'}
      description={
        target.data
          ? target.data.ssoState === 'sso'
            ? // "You will arrive signed in" was a promise the platform cannot keep: the product
              // redirects to the identity provider, and only a live session there removes the prompt.
              'The product takes your platform sign-in through the identity provider. The exact path is below.'
            : target.data.ssoState === 'sso_unverified'
              ? 'This product is wired for single sign-on, but the platform has no recent proof that the sign-in completes. What that means is below.'
              : // Who holds the credential is per deployment (ADR-BE-22): a gate whose account the
                // platform manages is not the same as one asking for a password issued elsewhere.
                // The per-entry sentence below is the one that knows which.
                'This product sits behind the platform gate. The sign-in path this deployment uses is below.'
          : 'Checking the published route and authentication class.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<ArrowUpRight />}
            disabled={!target.data || ticket.isPending}
            onClick={() => void open()}
          >
            {ticket.isPending ? 'Preparing sign-in…' : 'Open in new tab'}
          </Button>
        </>
      }
    >
      {/*
        The dialog body is one async region: while the target is read the panel says so, and a
        failed read shows the compact problem *in place of* the body rather than next to a body
        built from data that does not exist (ARCH-03).
      */}
      <AsyncPanel
        query={target}
        loading={<SkeletonLines lines={4} />}
        loadingLabel="Checking the launch target"
        renderError={(error, retry) => <QueryError error={error} onRetry={retry} compact />}
      >
        {(data) => {
          const guarantee = GUARANTEE_CLASS_LABELS[data.authClass];
          return (
            <div className="space-y-4">
              <div className="rounded-sm border border-line bg-panel-soft p-3">
                <p className="text-faint label-caps-sans">Launch target</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <Mono className="truncate text-meta text-text">{data.url}</Mono>
                  <CopyButton value={data.url} label="Copy launch URL" />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={guarantee.tone}>{guarantee.label}</Badge>
                  {data.ssoState === 'sso' ? (
                    <span className="inline-flex items-center gap-1 text-meta text-success">
                      <ShieldCheck className="size-3.5" aria-hidden /> Single sign-on
                    </span>
                  ) : data.ssoState === 'sso_unverified' ? (
                    <span className="inline-flex items-center gap-1 text-meta text-warning-strong">
                      <ShieldAlert className="size-3.5" aria-hidden /> Sign-in path unverified
                    </span>
                  ) : (
                    <span className="text-meta text-warning-strong">Sign-in required</span>
                  )}
                </div>
                <p className="text-body leading-relaxed text-muted">{guarantee.description}</p>
                <p className="text-body leading-relaxed text-muted">{data.note}</p>
              </div>

              {/*
                The warning the user never got: the product's own error page blamed the site URL,
                and the portal said nothing at all while the sign-in could not complete. The
                platform holds the evidence, so it says it here — before the click, not after.
              */}
              {data.ssoState === 'sso_unverified' ? (
                <div className="rounded-sm border border-warning/40 bg-warning/5 p-3">
                  <p className="text-meta font-semibold text-warning-strong">
                    The platform has no recent proof that this sign-in completes.
                  </p>
                  <p className="mt-1 text-meta leading-relaxed text-muted">
                    {describeSsoHealth(
                      data.ssoHealth,
                      tile?.lastVerifiedAt ?? new Date().toISOString(),
                    )}
                  </p>
                  <p className="mt-1 text-meta leading-relaxed text-muted">
                    You can still open it. If the product asks for a password the platform does not
                    hold, report this to the platform owner with the message above.
                  </p>
                </div>
              ) : null}

              {/*
                ADR-BE-22: the mapping the relay signs in as is created after the deployment, so for
                a few seconds a launch legitimately has nothing to plant. Saying so is the difference
                between "auto sign-in is broken" and "this is still being prepared" — the product's
                own form is what the user would otherwise conclude from, and did.
              */}
              {data.relayState === 'preparing' ? (
                <p className="text-meta leading-relaxed text-muted">
                  Your account for this product is still being prepared. Opening it now may show the
                  product’s own sign-in form once; try again in a few seconds and it opens signed
                  in.
                </p>
              ) : null}

              {ticket.isError ? (
                <p className="text-meta leading-relaxed text-danger-strong">
                  The launch ticket could not be minted, so the product would answer “sign in”
                  instead of your session. Try again, or reload the launcher.
                </p>
              ) : null}

              <InlineNote className="flex items-start gap-1.5">
                <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden />
                {data.bootstrapRequired
                  ? 'Opening mints a one-time launch ticket, so the product’s edge receives your existing platform session. The ticket is single-use and expires in a minute.'
                  : data.ssoState === 'sso' || data.ssoState === 'sso_unverified'
                    ? 'Opens through the platform identity provider: if you are signed in there, the product takes your session without a second prompt.'
                    : 'The product signs you in itself. Your platform account is used for authorisation; the product keeps its own session cookie afterwards.'}
              </InlineNote>

              {/*
                The mock platform serves the portal, not the products: this address is the one the API
                would publish, but nothing answers behind it here. Saying so before the click keeps
                a reviewer from reading the browser's "site cannot be reached" as a broken demo —
                the launch record and the ticket are still produced by the mock platform.
              */}
              {mocksEnabled ? (
                <p className="text-micro leading-relaxed text-faint">
                  No product container runs behind this address, so the new tab will not load. The
                  launch record and the one-time ticket are still served by the mock platform.
                </p>
              ) : null}
            </div>
          );
        }}
      </AsyncPanel>
    </Dialog>
  );
}
