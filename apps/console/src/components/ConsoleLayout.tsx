import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { Command, LogOut, Search } from 'lucide-react';
import { devSignInAvailable, lastKnownStatusAt, useMe } from '@seamnex/api-client';
import { ROLE_LABELS } from '@seamnex/domain';
import {
  AppShell,
  Avatar,
  Badge,
  BrandLockup,
  Button,
  Kbd,
  Masthead,
  SideNav,
  StaleNotice,
  ThemeToggle,
  Tooltip,
} from '@seamnex/ui';
import { ProductVersion, SignOutDialog, UnauthorizedNotice } from '@seamnex/shell';
import { cn } from '@seamnex/utils';
import { preloadRoute } from '../lazy-routes';
import { useNavigation } from '../use-navigation';
import { apiBaseUrl, mocksEnabled } from '../api-mode';
import {
  ConsoleLatencySwitcher,
  ConsoleRoleSwitcher,
  ConsoleScenarioSwitcher,
  useSession,
} from '../session';
import { CommandPalette } from './CommandPalette';
import { CrumbProvider, type Crumb } from '../page-crumb';

export function ConsoleLayout() {
  const { session } = useSession();
  const me = useMe();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [crumb, setCrumb] = useState<Crumb | null>(null);
  /*
   * The shell's small-width sheet is controlled from here because the selection that dismisses it
   * happens inside `renderLink`, and a menu is not a place an operator should have to leave twice:
   * choosing a section is the whole reason the sheet was opened.
   */
  const [navOpen, setNavOpen] = useState(false);

  const { groups, flat } = useNavigation();

  const active =
    flat
      .filter((item) =>
        item.href === '/' ? location.pathname === '/' : location.pathname.startsWith(item.href),
      )
      .sort((a, b) => b.href.length - a.href.length)[0] ?? null;

  /**
   * The header's masthead names the *area* (the navigation group), not the leaf section: the
   * leaf already appears twice — highlighted in the sidebar and as the page's own `<h1>` — so
   * repeating it in the same 13.5px display type directly above that heading read as a
   * duplicate.
   *
   * The second line identifies the exact screen. It is the path, except on the routes whose id
   * is a UUID: those announce the record's own label (`usePageCrumb`), because `/INSTANCES/9C25…`
   * is a string nobody reads and it is the only thing the strip says on a phone.
   */
  const activeGroup =
    groups.find((group) => group.items.some((item) => item.href === active?.href)) ?? null;
  const locationLabel = crumb?.path === location.pathname ? crumb.label : location.pathname;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  /**
   * What the footer is allowed to say is decided here, once, instead of by four components
   * guessing independently.
   *
   * The footer has to hold two things and nothing else: where the data comes from, and how to
   * leave. Below `lg` it is the only session surface — the sidebar is a modal sheet there, and
   * the topbar's name and role are hidden at `sm`-and-down. At `lg` it is development chrome,
   * because the topbar already carries identity, role, MFA and sign-out.
   *
   * The live-mode role picker exists only against the development stub provider. It is gated on
   * the `/me` query settling so it cannot pop into the footer after first paint, and it is
   * accompanied by a tooltip rather than a paragraph: prose below a control is only justified
   * when there are three of them (mock mode). A sentence that explains an unrendered control is
   * worse than no sentence at all.
   */
  const devRolePicker = !mocksEnabled && devSignInAvailable() && me.isFetched;
  const apiState = me.isError ? 'unavailable' : me.data === undefined ? 'checking' : 'connected';
  const apiLine = {
    connected: { dot: 'bg-success', text: 'text-muted', label: 'connected' },
    checking: { dot: 'bg-line-strong', text: 'text-faint', label: 'checking' },
    unavailable: { dot: 'bg-danger', text: 'text-danger-strong', label: 'unavailable' },
  }[apiState];
  const mfaHint =
    me.data === undefined
      ? 'MFA: the session has not been reported yet. Administrative roles are enforced by policy.'
      : me.data.mfaSatisfied
        ? `MFA: satisfied (${me.data.mfaMethod}). Administrative roles are enforced by policy.`
        : 'MFA: not used in this session. Administrative roles are enforced by policy.';
  const apiTarget =
    apiBaseUrl() ?? (typeof window === 'undefined' ? 'this origin' : window.location.origin);
  const apiHint =
    apiState === 'unavailable'
      ? `The last request to ${apiTarget} failed; the values on screen may be stale.`
      : apiState === 'checking'
        ? `Verifying the session against ${apiTarget}.`
        : `Requests resolve against ${apiTarget}.`;

  const sidebar = (
    <SideNav
      /*
       * `tone="ink"` paints the masthead with the chrome band the topbar uses, so the two
       * strips read as one bar across the seam instead of a light box beside a light box.
       */
      tone="ink"
      brand={
        /*
         * The descriptor, not the host. The strip is 248px wide; "OPERATIONS CONSOLE · LOCALHOST"
         * overflowed it and truncated mid-word, and the host belongs to the address bar anyway —
         * a brand lockup is not the place to print an internal hostname into demos and screenshots.
         */
        <BrandLockup tone="ink" title="Seamnex" meta="Operations console" />
      }
      groups={groups.map((group) => ({
        label: group.label,
        items: group.items.map((item) => ({
          href: item.href,
          label: item.label,
          icon: <item.icon />,
          active: active?.href === item.href,
        })),
      }))}
      // A real router link, so modifier-click and "open in new tab" behave as links should, and
      // hovering or focusing it warms the target chunk before the click.
      onPrefetch={preloadRoute}
      onSelect={() => setNavOpen(false)}
      renderLink={({ href, className, ariaCurrent, title, onPrefetch, onSelect, children }) => (
        <Link
          to={href}
          className={className}
          aria-current={ariaCurrent}
          title={title}
          onPointerEnter={onPrefetch}
          onFocus={onPrefetch}
          /*
           * The click has to be classified before it is acted on, and the classification is the
           * router's own `shouldProcessLinkClick` predicate: a modifier-click or a middle click
           * asks for another tab, so the screen behind the sheet is still the one the operator is
           * reading and the sheet must stay. Anything else is an in-place selection — including a
           * click on the section already open, which is a no-op navigation but still means "I am
           * done with this menu".
           */
          onClick={(event) => {
            const inPlace =
              event.button === 0 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey &&
              !event.defaultPrevented;
            if (inPlace) onSelect?.();
          }}
        >
          {children}
        </Link>
      )}
      footer={
        /*
         * `gap-2`, not `space-y-2`. The account block is `display: none` at `lg`, but a hidden
         * element is still the last child, so `space-y-*` left the version row's 8px margin behind
         * as a phantom band under a footer that had nothing to space — 8px of the desktop sidebar
         * spent on a gap to nothing. A flex column drops hidden children from the gap.
         */
        <div className="flex flex-col gap-2">
          {/* Provenance. In mock mode this is a warning and earns the loudest chrome in the
              footer, because it is the one place a reviewer looks to decide whether the numbers
              are real. In live mode "live API" was a tautology printed in the same dark chip on
              every screen; the useful fact there is whether the API answers, not whether it is
              the API.

              Live mode is one row, not two. The build id answers the same question as the
              status ("what am I looking at?") and used to spend a 14px band of its own on it;
              the rail has 216px of usable width, so the id rides the provenance row. The label
              pays for it: at the recipe's 0.14em tracking "PLATFORM API" alone measured 98px and
              left the row 3px short, which clipped the last glyph of an ordinary `v0.0.0`.
              `0.08em` — the tracking the sans variant already uses — costs the label no words
              and measures 90px, so the row uses 208px normally and 214px at the longest state
              (`unavailable`). The id is still the item that gives way when the value is the long
              `version unavailable` fallback — `truncate` keeps the row on one line rather than
              pushing the status off the edge. Mock mode keeps its own row below, because the
              badge is the loudest thing here and the picker controls already hold the footer to
              three bands. */}
          <div className="flex items-center justify-between gap-2">
            {/* `text-muted` is the colour the `connected` state prints at, so the label and its
                value read as one line instead of a heading over a value: at 11px mono caps the
                label was the darkest thing in the row, and the state — the thing that can change
                — was the quiet half. It stays `text-text` in mock mode, where "Prototype" is the
                warning and the badge beside it carries the colour. */}
            <span
              className={cn(
                'label-caps shrink-0 [--label-caps-tracking:0.08em]',
                !mocksEnabled && 'text-muted',
              )}
            >
              {mocksEnabled ? 'Prototype' : 'Platform API'}
            </span>
            {mocksEnabled ? (
              <Badge tone="caution" size="sm">
                simulated data
              </Badge>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span className="inline-flex shrink-0 items-center gap-1.5" title={apiHint}>
                  <span aria-hidden className={cn('size-1.5 rounded-full', apiLine.dot)} />
                  <span className={cn('text-meta', apiLine.text)}>{apiLine.label}</span>
                </span>
                <span className="min-w-0 truncate text-micro leading-tight">
                  <ProductVersion version={__SEAMNEX_VERSION__} />
                </span>
              </span>
            )}
          </div>

          {/* Which build this is, from the root `package.json` through the build flag — not a
              literal here, and the same component as the portal footer, so the two cannot
              disagree. Only the mock-mode footer spends a band on it now; live mode prints it on
              the provenance row above. The block wrapper is what earns the footer's `gap-2`; the
              component itself is inline, so the portal footer can print it mid-sentence.

              `text-micro leading-tight` on the wrapper is not decoration: a bare block inherits the
              14px/1.5 strut, so this row measured 21px for one 11px line — 4.5px of leading taller
              than the text it spaced, on every screen, for the whole life of the build. */}
          {mocksEnabled ? (
            <div className="text-micro leading-tight">
              <ProductVersion version={__SEAMNEX_VERSION__} />
            </div>
          ) : null}

          {/* Rendered only when at least one control will actually render. The wrapper used to
              stay behind as an empty 28px row in live mode, which read as "something failed to
              load". */}
          {/*
            Two rows, not three. The selects used to wrap individually inside a flex row, so at the
            sidebar's 248px the role picker took a row, the scenario a second and the latency a
            third — three full-width controls and ~90px of the navigation's height spent on demo
            chrome. The role label needs the whole width ("R1 · Platform admin" clips in a
            half-width `<select>`, and a clipped option is worse than a wrapped row), so it spans
            both columns and the two short controls share the row beneath it.
          */}
          {mocksEnabled || devRolePicker ? (
            <div
              className="grid grid-cols-2 gap-1.5"
              title="Role and scenario switch the simulated platform. A role change re-renders navigation and capability gates; a scenario change reloads the mock data."
            >
              {mocksEnabled ? (
                <ConsoleRoleSwitcher className="col-span-2 min-w-0" />
              ) : (
                /*
                  Rule: a tooltip trigger must be focusable, or its text must be exposed as text.
                  The span itself is not focusable, but it wraps the switcher's `<select>`, which is
                  — and Radix opens on `focus`, which React delegates from the bubbling `focusin`, so
                  tabbing into the select opens the tooltip. That is the whole justification: if the
                  wrapped control ever stops being focusable, this tooltip becomes unreachable and
                  the sentence has to move into visible or `sr-only` text.
                */
                <Tooltip content="Development stub sign-in. A real provider asserts the role for the session.">
                  <span className="col-span-2 inline-flex min-w-0">
                    <ConsoleRoleSwitcher />
                  </span>
                </Tooltip>
              )}
              <ConsoleScenarioSwitcher className="min-w-0" />
              <ConsoleLatencySwitcher className="min-w-0" />
            </div>
          ) : null}

          {/* Three controls need explaining; one dev picker does not. */}
          {mocksEnabled ? (
            <p className="text-meta leading-snug text-faint">
              Role switching re-renders navigation and capability gates. Scenario switching reloads
              the mock platform.
            </p>
          ) : null}

          {/* The control the portal exposes (FR-3.8): `/sign-in` bounces an authenticated session,
              so without it an operator has no way to end an administrative login. The whole block
              is hidden at `lg`, where the persistent sidebar and the topbar button are both on
              screen; below it this is the only reachable control, because the sheet is the
              navigation. Because it is sheet-only, the account line above it cannot duplicate the
              topbar: at `sm`-and-down the topbar collapses to an avatar. A hairline keeps the
              destructive action off the selects it used to sit flush against.

              One row, not two: the identity and the button are the same announcement, and stacked
              they cost 73px — 48% of the whole footer — inside a 280px sheet whose navigation is
              what the operator opened it for. Side by side it is one 28px band. The label stays
              written out rather than collapsing to the icon alone: this is the destructive action,
              and at `sm`-and-down it is the only copy on screen. The identity column is `min-w-0`
              so a long display name truncates instead of pushing the button off the edge. */}
          <div className="flex items-center justify-between gap-2 border-t border-line pt-2 lg:hidden">
            <div className="min-w-0 leading-tight">
              {me.data?.displayName ? (
                <p className="truncate text-meta font-semibold text-text">{me.data.displayName}</p>
              ) : null}
              <p className="label-caps truncate">{ROLE_LABELS[session.role].short}</p>
            </div>
            <Button
              variant="quiet"
              size="sm"
              icon={<LogOut />}
              onClick={() => setSignOutOpen(true)}
              className="shrink-0"
            >
              Sign out
            </Button>
          </div>
        </div>
      }
    />
  );

  const topbar = (
    // No wrapping: the strip is a fixed `--shell-header-height`, so a second row would overflow
    // it. The location lockup truncates instead, which keeps the strip's height honest at 320px.
    <div className="flex min-w-0 items-center justify-between gap-2">
      <Masthead
        tone="ink"
        title={activeGroup?.label ?? active?.label ?? 'Console'}
        meta={locationLabel}
      />

      <div className="flex shrink-0 items-center gap-2">
        {/*
          Left of the palette trigger, and before the session evidence: appearance is a preference
          about the screen, not about the operator or the data, so it sits with the other "how I
          read this" control rather than with identity. 80px wide, icon-only, named on each
          segment — the strip truncates its masthead rather than grow a second row.
        */}
        <ThemeToggle />
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          /*
           * Named, because the label below `sm` is `display: none` — which removes it from the
           * accessible-name computation, so the button announced itself as "button" on every phone.
           * The name carries the visible words so voice control still matches them.
           */
          aria-label="Jump to a console section"
          className="tap-target inline-flex h-7 items-center gap-2 rounded-xs border border-line-ink bg-ink-raised px-2 text-meta text-ink-text-muted hover:border-primary-on-ink hover:text-ink-text"
        >
          <Search className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">Jump to…</span>
          {/* Recessed keycaps, not the paper ones: on the band a `#fffefb` key is the brightest
              thing on screen at 11px. The ink pair is one step below the button, so the shortcut
              still reads as a key rather than as a highlight. */}
          <span className="hidden items-center gap-0.5 sm:inline-flex">
            <Kbd className="border-line-ink bg-ink text-ink-text-muted shadow-none">
              <Command className="size-2.5" aria-hidden />
            </Kbd>
            <Kbd className="border-line-ink bg-ink text-ink-text-muted shadow-none">K</Kbd>
          </span>
        </button>

        {/* `mfaMethod` is an enum whose "off" value is the literal `'none'`, so truthiness lit the
            dot green for every single-factor session. The session's boolean is the only thing that
            says whether a second factor was used; the method is a label, not a state. */}
        <Tooltip content={mfaHint}>
          {/*
            Focusable on purpose: a tooltip is shown on focus, so a non-focusable trigger hides
            its content from every keyboard user. The same sentence is its accessible name, which
            is what a screen reader announces.
          */}
          {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the trigger must take focus:
              a tooltip is shown on focus, so a non-focusable one hides its content from the keyboard.
              `role` is not the answer here — this reports a value, it does not act. */}
          {/*
            The state dot is `primary-on-ink` rather than `success`: `--color-success` is a
            `light-dark()` pair, and on a strip that never inverts its light value (#1e7a4b) sits
            at 2.4:1 on ink — a green dot nobody can see. The fixed on-ink accent is the same
            language the portal's MFA chip speaks.
          */}
          <span
            tabIndex={0}
            aria-label={mfaHint}
            className="hidden items-center gap-1.5 rounded-xs border border-line-ink bg-ink-raised px-2 py-1 sm:inline-flex"
          >
            <span
              className={`size-1.5 rounded-full ${me.data?.mfaSatisfied ? 'bg-primary-on-ink' : 'bg-ink-text-faint'}`}
              aria-hidden
            />
            <span className="font-mono text-micro text-ink-text-muted">MFA</span>
          </span>
          {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
        </Tooltip>

        {/* `border-line-ink`, and the avatar in the portal's teal: an `ink` avatar is `bg-ink`
            on a `bg-ink` band, which is a chip with no edge. */}
        <div className="flex items-center gap-2 border-l border-line-ink pl-2">
          <Avatar initials={me.data?.initials ?? '—'} size="sm" tone="teal" />
          <span className="hidden leading-tight sm:block">
            <span className="block text-meta font-semibold text-ink-text">
              {me.data?.displayName ?? '…'}
            </span>
            <span className="label-caps block text-ink-text-muted">
              {ROLE_LABELS[session.role].short}
            </span>
          </span>
        </div>

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
  );

  return (
    <>
      <AppShell
        sidebar={sidebar}
        topbar={topbar}
        mobileTitle="Console sections"
        navOpen={navOpen}
        onNavOpenChange={setNavOpen}
      >
        {session.scenario === 'offline' ? (
          <StaleNotice lastKnownAt={lastKnownStatusAt()} className="mb-3" />
        ) : null}
        <UnauthorizedNotice />
        <CrumbProvider value={setCrumb}>
          <Outlet />
        </CrumbProvider>
      </AppShell>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </>
  );
}
