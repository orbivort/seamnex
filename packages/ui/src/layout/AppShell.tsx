import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Menu, X } from 'lucide-react';
import { cn } from '@seamnex/utils';

/**
 * The seam where the sheet gives way to the persistent rail, written as the media query Tailwind
 * compiles `@variant lg` to rather than as a pixel count, so a `--breakpoint-lg` override moves one
 * value at a time.
 */
const NAV_SHEET_QUERY = '(min-width: 64rem)';

export function AppShell({
  sidebar,
  topbar,
  children,
  mobileTitle,
  navOpen,
  onNavOpenChange,
}: {
  sidebar: ReactNode;
  topbar: ReactNode;
  children: ReactNode;
  mobileTitle?: string;
  /**
   * Open state of the small-width sheet. Undefined on both leaves the shell in charge; supplying
   * both lets the app drive it, which is how a navigation selection can dismiss the sheet. This
   * follows the same controlled/uncontrolled split as the form primitives: one source of truth per
   * consumer, never two.
   */
  navOpen?: boolean;
  onNavOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = navOpen ?? uncontrolledOpen;

  const changeOpen = useCallback(
    (next: boolean) => {
      if (navOpen === undefined) setUncontrolledOpen(next);
      onNavOpenChange?.(next);
    },
    [navOpen, onNavOpenChange],
  );

  /**
   * A sheet left open across the seam is not cosmetic: Radix keeps its scroll lock, its focus trap
   * and `aria-hidden` on the rest of the document while the content is already `display: none`.
   * The console would be unscrollable and untabbable until Escape — the one state an operator
   * cannot have. The sheet is closed by state, not by CSS, so the dialog stops being a dialog.
   */
  useEffect(() => {
    if (!open) return;
    if (typeof window.matchMedia !== 'function') return;

    const media = window.matchMedia(NAV_SHEET_QUERY);
    const closeAtRail = () => {
      if (media.matches) changeOpen(false);
    };
    closeAtRail();
    media.addEventListener('change', closeAtRail);
    return () => media.removeEventListener('change', closeAtRail);
  }, [open, changeOpen]);

  return (
    <div className="min-h-screen bg-paper">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      {/*
        No `border-r` on the aside: the band across its top is ink on both sides of the seam,
        and a paper hairline painted through it read as a break in the band rather than as the
        seam between navigation and content. The rule is drawn below the band instead, where it
        still separates the two columns.
      */}
      <aside className="fixed inset-y-0 left-0 z-nav hidden w-[var(--shell-sidebar-width)] bg-panel-soft lg:block">
        {sidebar}
        <span
          aria-hidden
          className="pointer-events-none absolute top-[var(--shell-header-height)] right-0 bottom-0 w-px bg-line"
        />
      </aside>

      {/* A real modal sheet: Radix owns the focus trap, Escape handling, aria-modal and scroll lock. */}
      <DialogPrimitive.Root open={open} onOpenChange={changeOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-overlay animate-fade bg-overlay lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-modal flex w-[280px] max-w-[85vw] flex-col border-r border-line-strong bg-panel-soft shadow-lift lg:hidden">
            {/* The sheet replaces the topbar at this width, so it leads with the same ink band
                rather than a paper row: the strip above a screen is chrome, whatever it is
                currently showing. */}
            <div className="ink-flat flex items-center justify-between border-b border-line-ink px-4 py-3">
              <DialogPrimitive.Title className="label-caps text-ink-text">
                {mobileTitle ?? 'Navigation'}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Primary navigation for the operator console at small widths.
              </DialogPrimitive.Description>
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  aria-label="Close navigation"
                  className="tap-target rounded-sm p-1 text-ink-text-muted hover:bg-ink-hover hover:text-ink-text"
                >
                  <X className="size-4" />
                </button>
              </DialogPrimitive.Close>
            </div>
            <div className="scroll-slim flex-1 overflow-y-auto overscroll-contain">{sidebar}</div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <div className="shell-content">
        {/* `shell-header` owns the strip's height, inset, centring and hairline, so this bar
            is dimensionally identical to the sidebar masthead it sits beside. The rule lives
            on the inner row: the sticky element carries no height of its own.

            The surface is the ink chrome band, the same one the sidebar masthead is painted
            with, so the two strips are visibly one bar — the page behind them is paper, and a
            paper header had no figure at all against the content it frames. It stays opaque
            and unblurred: `backdrop-blur-sm` on a sticky bar forces a compositing and blur pass
            on every scroll frame of the whole console, and an ink fill hides the same pixels
            without one. */}
        <header className="ink-flat sticky top-0 z-header">
          <div className="shell-header border-line-ink">
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => changeOpen(true)}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-sm border border-line-ink bg-ink-raised text-ink-text-muted hover:border-primary-on-ink hover:text-ink-text lg:hidden"
            >
              <Menu className="size-4" />
            </button>
            <div className="min-w-0 flex-1">{topbar}</div>
          </div>
        </header>
        <main id="main" className="shell-container py-5">
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * The product identity lockup: mark, wordmark and an optional descriptor line.
 *
 * Every surface that names the product renders this component — the console sidebar, the portal
 * header and the sign-in strip — so the mark geometry (32px, 2px radius, 6px accent), the
 * mark-to-wordmark gap and the wordmark cut are invariants rather than three near-misses.
 *
 * Two things vary by context, and only these:
 *
 * - `tone` adapts the colours to the surface it sits on. On paper the mark is an ink chip with
 *   light type; on the always-dark strip it is the brand chip. Both are built from fixed values —
 *   `text-text` and `primary` are `light-dark()` pairs, and the strip behind the mark never
 *   inverts, so a theme-aware chip changed colour on a surface that did not (and its 6px accent,
 *   the same pale teal, vanished into the fill in dark mode).
 * - `size` scales the wordmark for the room available: `sm` in signed-in chrome, `md` on the
 *   sign-in strip. The mark does not scale with it, so the lockup still reads as the same object.
 */
export function BrandLockup({
  size = 'sm',
  tone = 'paper',
  title = 'Seamnex',
  meta,
  metaClassName,
}: {
  size?: 'sm' | 'md';
  tone?: 'paper' | 'ink';
  title?: ReactNode;
  meta?: ReactNode;
  metaClassName?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className={cn(
          'relative grid size-8 shrink-0 place-items-center rounded-xs border font-mono text-micro font-semibold',
          tone === 'paper'
            ? 'border-primary-border bg-ink text-ink-text'
            : 'border-mark-ink-edge bg-mark-ink-fill text-ink-text shadow-inset-top',
        )}
      >
        SN
        <span className="absolute -right-px -bottom-px size-1.5 bg-primary-on-ink" />
      </span>
      <span className="min-w-0 leading-tight">
        <span
          className={cn(
            'block truncate font-display font-semibold tracking-[0.01em]',
            size === 'sm' ? 'text-body' : 'text-heading',
            tone === 'paper' ? 'text-text' : 'text-ink-text',
          )}
        >
          {title}
        </span>
        {meta === undefined || meta === null ? null : (
          <span
            className={cn(
              'label-caps block truncate',
              tone === 'paper' ? 'text-muted' : 'text-ink-text-muted',
              metaClassName,
            )}
          >
            {meta}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * A strip heading for the console chrome: an optional mark, an area name and a mono meta line.
 * This is not the brand lockup — the topbar names the current area, so it has no mark of its own
 * and its title is not the product name. `BrandLockup` owns the identity surfaces.
 *
 * Both lines are single-line with an ellipsis, so a long route truncates instead of widening the
 * strip. `tone` picks the pair of colours for the surface it is printed on: paper text on a paper
 * strip, ink text on the chrome band.
 */
export function Masthead({
  mark,
  title,
  meta,
  tone = 'paper',
}: {
  mark?: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  tone?: 'paper' | 'ink';
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {mark ? <span className="shrink-0">{mark}</span> : null}
      <span className="min-w-0 leading-tight">
        <span
          className={cn(
            'block truncate font-display text-body font-semibold',
            tone === 'ink' ? 'text-ink-text' : 'text-text',
          )}
        >
          {title}
        </span>
        {/* Two steps, not three: on ink the meta line is the quieter of the pair, which is what
            `ink-text-muted` is for. `label-caps` carries no colour of its own, so naming the
            tone here does not fight the recipe. */}
        <span className={cn('label-caps block truncate', tone === 'ink' && 'text-ink-text-muted')}>
          {meta}
        </span>
      </span>
    </div>
  );
}

export type SideNavLinkProps = {
  href: string;
  className: string;
  ariaCurrent: 'page' | undefined;
  title: string | undefined;
  disabled: boolean;
  onPrefetch: (() => void) | undefined;
  /**
   * Reports that this destination was chosen. The caller's router has to invoke it, because the
   * design system does not own the click on a link it did not render — that is the whole point of
   * `renderLink`. It fires for an in-place activation only: a modifier-click or a middle-click is
   * a request for another tab, not a request to leave this screen.
   */
  onSelect: (() => void) | undefined;
  children: ReactNode;
};

/**
 * One navigation list, rendered with an anchor by default and by the app's router through
 * `renderLink`.
 *
 * The design system must not import the router, but a bare `<a href>` plus `preventDefault`
 * broke modifier-click, middle-click and "open in new tab" — and with no handler at all it did a
 * full document navigation, discarding the SPA and its cache. The app supplies its own `Link`,
 * which also gives it a place to warm the target chunk (`onPrefetch`).
 */
export function SideNav({
  brand,
  groups,
  footer,
  tone = 'paper',
  onNavigate,
  onPrefetch,
  onSelect,
  renderLink,
}: {
  brand: ReactNode;
  /**
   * The masthead's surface. `ink` continues the content header's chrome band across the seam;
   * `paper` stays the default because whether the strip is chrome is the application's call,
   * not the navigation list's.
   */
  tone?: 'paper' | 'ink';
  groups: {
    label: string;
    items: {
      href: string;
      label: string;
      icon?: ReactNode;
      badge?: ReactNode;
      active?: boolean;
      disabled?: boolean;
      hint?: string;
    }[];
  }[];
  footer?: ReactNode;
  onNavigate?: (href: string) => void;
  onPrefetch?: (href: string) => void;
  /**
   * Fires when a destination is activated in place, in both link branches. It exists because the
   * sheet and the rail render the same list: the app closes the sheet here, and the same click on
   * the persistent rail is a no-op rather than a second behaviour.
   */
  onSelect?: (href: string) => void;
  renderLink?: (props: SideNavLinkProps) => ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className={cn('shell-header', tone === 'ink' && 'ink-flat border-line-ink')}>
        {brand}
      </div>
      <nav
        aria-label="Primary"
        className="scroll-slim scroll-pane flex-1 overflow-y-auto overscroll-contain px-2 py-3"
      >
        {groups.map((group) => (
          <div key={group.label} className="mb-4">
            <p className="label-caps mb-1 px-2">{group.label}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const link: SideNavLinkProps = {
                  href: item.href,
                  ariaCurrent: item.active ? 'page' : undefined,
                  title: item.hint,
                  disabled: item.disabled === true,
                  onPrefetch: onPrefetch === undefined ? undefined : () => onPrefetch(item.href),
                  onSelect: onSelect === undefined ? undefined : () => onSelect(item.href),
                  className: cn(
                    'group flex items-center gap-2 rounded-sm px-2 py-[7px] text-body transition-colors',
                    item.active
                      ? 'bg-primary-soft font-semibold text-primary-soft-foreground shadow-nav-active'
                      : 'text-muted hover:bg-paper-deep hover:text-text',
                    item.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent',
                  ),
                  children: (
                    <>
                      {item.icon ? (
                        <span className="shrink-0 text-faint group-hover:text-link [&>svg]:size-4">
                          {item.icon}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badge ? <span className="shrink-0">{item.badge}</span> : null}
                    </>
                  ),
                };
                return (
                  <li key={item.href}>
                    {renderLink ? (
                      renderLink(link)
                    ) : (
                      <a
                        href={link.href}
                        aria-current={link.ariaCurrent}
                        aria-disabled={link.disabled || undefined}
                        title={link.title}
                        onPointerEnter={link.onPrefetch}
                        onFocus={link.onPrefetch}
                        onClick={(event) => {
                          if (link.disabled) {
                            event.preventDefault();
                            return;
                          }
                          link.onSelect?.();
                          if (onNavigate) {
                            event.preventDefault();
                            onNavigate(link.href);
                          }
                        }}
                        className={link.className}
                      >
                        {link.children}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      {/*
        `py-2`, not `py-3`. The sidebar is `inset-y-0` and the list above this block is `flex-1`
        with its own scrollbar, so the footer's 24px of vertical padding was 24px taken from
        navigation the operator cannot reach any other way. What sits here is provenance and a
        build id — not a control stack — so the inset only has to separate it from the list, which
        it still does at 8px. `px-4` stays: nav items indent to the same 16px, so the footer's text
        sits on the same vertical rule as the links.
      */}
      {footer ? <div className="border-t border-line px-4 py-2">{footer}</div> : null}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5 flex flex-wrap items-center gap-2">{eyebrow}</div> : null}
        <h1 className="font-display text-display font-semibold tracking-tight text-text">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 max-w-3xl text-body leading-relaxed text-muted">{description}</p>
        ) : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('mb-5', className)}>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-display text-heading font-semibold text-text">{title}</h2>
          {description ? <p className="mt-0.5 text-meta text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/* `Topbar` lived here and was never rendered: a fourth chrome variant with a hard-coded
   1500px measure (duplicating `--shell-content-max-narrow`) and a `-mx-4 px-4` pair that
   assumed a 16px gutter while `--shell-gutter` is 12px. Both shells build their own strip, so
   it was deleted rather than wired up. */
