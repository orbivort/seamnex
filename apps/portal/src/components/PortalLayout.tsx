import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { LayoutGrid, LogOut, ShieldCheck } from 'lucide-react';
import { lastKnownStatusAt, useMe } from '@seamnex/api-client';
import { can, ROLE_LABELS } from '@seamnex/domain';
import { Avatar, BrandLockup, Button, Mono, StaleNotice, ThemeToggle, Tooltip } from '@seamnex/ui';
import { ProductVersion, SignOutDialog, UnauthorizedNotice } from '@seamnex/shell';
import { cn } from '@seamnex/utils';
import { StatusBanner } from './StatusBanner';
import { LatencySwitcher, RoleSwitcher, ScenarioSwitcher, useSession } from '../session';
import { mocksEnabled } from '../api-mode';

function NavItem({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'inline-flex items-center gap-1.5 whitespace-nowrap rounded-xs px-2.5 py-1.5 text-body font-medium transition-colors',
          isActive
            ? 'bg-ink-active text-ink-text'
            : 'text-ink-text-muted hover:bg-ink-hover hover:text-ink-text',
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function PortalLayout() {
  const { session } = useSession();
  const me = useMe();
  const navigate = useNavigate();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const guest = !can(session.role, 'portal.view_entitlements');

  return (
    // A column at viewport height, so a short screen (an empty state, a 404) still puts the
    // footer at the bottom edge instead of leaving a bare paper field underneath it.
    <div className="flex min-h-screen flex-col bg-paper">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      {/*
        Sticky, not fixed: the strip grows a second row below `lg` (the role, scenario and
        latency switches), so its height is not a constant. `fixed` forced the content to start
        at a hard-coded `pt-[108px]`, which the mobile strip already overran — the status banner
        rendered underneath the header. In flow, the strip reserves exactly its own height.
      */}
      {/*
        `min-h` from the shared token, not a height: the strip's own content measures 55.2px
        today, and letting two shells agree by coincidence is how they ended up 9px apart in the
        first place. A floor lets the demo controls row grow it below `lg` without ever pulling
        it under the console's 56px.
      */}
      <header className="ink-grid sticky top-0 z-nav flex min-h-[var(--shell-header-height)] flex-col justify-center border-b border-line-ink">
        <div className="shell-container shell-container--narrow flex flex-col gap-2 py-2.5">
          <div className="flex items-center gap-3">
            <Link to="/" className="shrink-0 rounded-sm">
              <BrandLockup
                tone="ink"
                meta="Unified access · self-hosted"
                /* The tagline is the widest thing in the strip — 228px on the label ramp against a
                   62px wordmark — so it is what gives way. Below 480px the account chip, the
                   appearance control and the 12px gutter no longer leave room for it: the row needs
                   its 418px of content plus the gutter, and at 440px the strip overflowed by 2px.
                   Dropping the descriptor is also what stops the wordmark collapsing to an
                   ellipsis beside a full-width tagline, which it did at 360px. */
                metaClassName="max-[479px]:hidden"
              />
            </Link>

            <div className="hidden flex-1 items-center gap-1 md:flex">
              <NavItem to="/">
                <LayoutGrid className="size-3.5" aria-hidden /> Launcher
              </NavItem>
              {guest ? null : <NavItem to="/entitlements">My access</NavItem>}
            </div>
            <div className="flex-1 md:hidden" />

            <div className="flex items-center gap-2">
              <Tooltip content="Mock and development builds only: re-renders the portal as another platform role.">
                {/* The compact row below the brand owns the switches under `lg`; showing this
                    copy at `md` too put two role pickers in the same header. */}
                <span className="hidden lg:inline-flex">
                  <RoleSwitcher compact />
                </span>
              </Tooltip>
              <Tooltip content="Switching scenario reloads a fresh simulated platform state.">
                <span className="hidden lg:inline-flex">
                  <ScenarioSwitcher />
                </span>
              </Tooltip>
              {/*
                Ahead of the session evidence, and the leftmost thing in the strip that is not a
                demo control — the console puts it in the same relative position, before the
                palette trigger. It is a preference about the screen, so it sits with the read-only
                chips and not with the account action beside it. It is not hidden at small widths:
                a preference the browser cannot otherwise express is not secondary chrome, and the
                evidence chips are what give way first.
              */}
              <ThemeToggle />
              {/* Secondary session evidence, so it waits for the width that can hold it: at
                  `md` the strip already carries the brand, both nav items, the account chip and
                  sign-out, and "Single factor" wrapped onto two lines between them. */}
              <span
                className="hidden items-center gap-1.5 whitespace-nowrap rounded-xs border border-line-ink bg-ink-raised px-2 py-1 lg:inline-flex"
                title={
                  me.data?.mfaSatisfied
                    ? 'The identity provider asserted a second factor for this session.'
                    : 'The identity provider did not assert a second factor for this session.'
                }
              >
                <ShieldCheck className="size-3 text-primary-on-ink" aria-hidden />
                <Mono className="text-micro text-ink-text-muted">
                  {/*
                   * "Scoped invite" describes a guest, not a session with one factor. Labelling a
                   * domain owner's session an invitation because the realm does not publish `amr`
                   * was a lie the chip told on every page (ADR-BE-14 §6).
                   */}
                  {me.data?.mfaSatisfied
                    ? 'MFA satisfied'
                    : me.data?.primaryRole === 'R6'
                      ? 'Scoped invite'
                      : 'Single factor'}
                </Mono>
              </span>
              <button
                type="button"
                onClick={() => navigate('/entitlements')}
                className="tap-target flex items-center gap-2 rounded-sm border border-line-ink bg-ink-raised py-0.5 pr-2 pl-0.5 hover:border-primary-hover"
                aria-label="Open account and entitlements"
              >
                <Avatar initials={me.data?.initials ?? '—'} size="sm" tone="teal" />
                {/* Name and role are read on "My access"; in the strip the avatar carries the
                    account until there is room for two more lines of text. */}
                <span className="hidden text-left leading-tight lg:block">
                  <span className="block whitespace-nowrap text-meta font-semibold text-ink-text">
                    {me.data?.displayName ?? 'Loading'}
                  </span>
                  <span className="label-caps block text-ink-text-muted">
                    {ROLE_LABELS[session.role].short}
                  </span>
                </span>
              </button>
              <Button
                variant="inverse"
                size="sm"
                icon={<LogOut />}
                onClick={() => setSignOutOpen(true)}
                className="hidden sm:inline-flex"
              >
                Sign out
              </Button>
            </div>
          </div>

          {/* Demo controls only. `empty:hidden` drops the row entirely on a live build, where
              none of the three renders, so the strip does not keep 8px of phantom gap. */}
          <div className="flex flex-wrap items-center gap-2 empty:hidden lg:hidden">
            <RoleSwitcher compact />
            <ScenarioSwitcher />
            <LatencySwitcher />
          </div>
        </div>
      </header>

      {/* `flex-1` pushes the footer to the bottom edge on a short screen; `scroll-mt-20` keeps the
          skip link from parking the first line under the sticky strip; `pt-5` gives the page its
          own top space instead of butting against that strip. */}
      <main
        id="main"
        className="shell-container shell-container--narrow scroll-mt-20 flex-1 pt-5 pb-14"
      >
        <StatusBanner />
        {session.scenario === 'offline' ? (
          <StaleNotice lastKnownAt={lastKnownStatusAt()} className="mb-3" />
        ) : null}
        <UnauthorizedNotice />
        <Outlet />
      </main>

      <footer className="border-t border-line bg-panel-soft">
        <div className="shell-container shell-container--narrow flex flex-wrap items-center justify-between gap-2 py-4 text-micro text-faint">
          <span>
            Seamnex · <Mono className="text-micro">{window.location.host}</Mono> ·{' '}
            {/*
              The footer described the demo fixtures even when the build talks to the real API, which
              made a live listing read as simulated data — the one place a reviewer looks to decide
              whether the numbers on screen are real.
            */}
            {mocksEnabled ? 'simulated platform data' : 'connected to the platform API'} ·{' '}
            {/* The build's identity, from the root `package.json` through the build flag. The
                console sidebar prints the same component, so the two shells cannot disagree. */}
            <ProductVersion version={__SEAMNEX_VERSION__} />
          </span>
          <button
            type="button"
            onClick={() => setSignOutOpen(true)}
            className="tap-target rounded-xs font-medium text-muted underline-offset-2 hover:text-link hover:underline sm:hidden"
          >
            Sign out
          </button>
          {/*
            FR-3.1 · FR-3.3 · FR-3.5 · FR-3.7 · FR-3.8 — the requirements this shell satisfies.
            Developer-only: the footer used to print this line in mono so a reviewer could see the
            traceability, which put requirement ids in front of end users.
          */}
        </div>
      </footer>

      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </div>
  );
}
