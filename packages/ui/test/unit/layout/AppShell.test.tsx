import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  AppShell,
  BrandLockup,
  Masthead,
  PageHeader,
  Section,
  SideNav,
  type SideNavLinkProps,
} from '../../../src/layout/AppShell';

/**
 * The shell is the frame every screen sits in, so it owns three things a page must not re-decide:
 * the skip link, one navigation list rendered as real anchors (modifier-click and "open in new
 * tab" depend on it), and a mobile sheet that is a real modal rather than a slide-over div.
 */
describe('AppShell', () => {
  it('provides a skip link, a permanent sidebar and a main landmark', () => {
    render(
      <AppShell sidebar={<p>Sidebar nav</p>} topbar={<p>Topbar</p>}>
        <p>Page body</p>
      </AppShell>,
    );
    expect(screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href')).toBe(
      '#main',
    );
    expect(screen.getByRole('main').textContent).toContain('Page body');
    expect(screen.getByRole('main').id).toBe('main');
    expect(screen.getByText('Sidebar nav')).toBeDefined();
    expect(screen.getByText('Topbar')).toBeDefined();
  });

  it('opens the navigation sheet with the default title and closes it again', () => {
    render(
      <AppShell sidebar={<p>Sidebar nav</p>} topbar={<p>Topbar</p>}>
        <p>Page body</p>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText('Navigation')).toBeDefined();
    // The sheet renders a second copy of the same navigation list.
    expect(within(sheet).getByText('Sidebar nav')).toBeDefined();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('paints the content header as the ink chrome band, and starts the seam below it', () => {
    const { container } = render(
      <AppShell sidebar={<p>Sidebar nav</p>} topbar={<p>Topbar</p>}>
        <p>Page body</p>
      </AppShell>,
    );

    const header = container.querySelector('header');
    expect(header?.className).toContain('ink-flat');
    expect(header?.querySelector('.shell-header')?.className).toContain('border-line-ink');
    // A paper hairline through the band would break it in two, so the aside has no right border.
    expect(container.querySelector('aside')?.className).not.toContain('border-r');
  });

  it('names the sheet after the product when told to', () => {
    render(
      <AppShell sidebar={<p>Sidebar nav</p>} topbar={<p>Topbar</p>} mobileTitle="Console">
        <p>Page body</p>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(within(screen.getByRole('dialog')).getByText('Console')).toBeDefined();
  });

  it('lets its owner dismiss the sheet from inside it', () => {
    /*
     * The sheet exists to be left: an owner that can see the open state can close it when the
     * operator picks a destination, which is the one dismissal the shell cannot infer on its own
     * because the link belongs to the app's router.
     */
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <AppShell
          navOpen={open}
          onNavOpenChange={setOpen}
          sidebar={
            <button type="button" onClick={() => setOpen(false)}>
              Choose section
            </button>
          }
          topbar={<p>Topbar</p>}
        >
          <p>Page body</p>
        </AppShell>
      );
    }

    render(<Controlled />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    const sheet = screen.getByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Choose section' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the sheet when the viewport reaches the persistent rail', () => {
    /*
     * A sheet left open across the seam is invisible but still modal: Radix holds the scroll lock,
     * the focus trap and `aria-hidden` on the page while the panel itself is `display: none`. The
     * close has to come from state, so the query is watched rather than the class hidden.
     */
    const original = window.matchMedia;
    const listeners = new Set<() => void>();
    const media = {
      matches: false,
      media: '(min-width: 64rem)',
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'change') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'change') listeners.delete(listener);
      },
      dispatchEvent: () => false,
    };
    window.matchMedia = (() => media) as unknown as typeof window.matchMedia;

    try {
      render(
        <AppShell sidebar={<p>Sidebar nav</p>} topbar={<p>Topbar</p>}>
          <p>Page body</p>
        </AppShell>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
      expect(screen.getByRole('dialog')).toBeDefined();
      expect(listeners.size).toBe(1);

      act(() => {
        media.matches = true;
        for (const listener of listeners) listener();
      });

      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('Masthead', () => {
  it('renders a mark, a title and a meta line', () => {
    render(
      <Masthead mark={<span data-testid="mark" />} title="Operator console" meta="eu-west-1" />,
    );
    expect(screen.getByTestId('mark').parentElement?.className).toContain('shrink-0');
    expect(screen.getByText('Operator console').className).toContain('truncate');
    expect(screen.getByText('eu-west-1').className).toContain('label-caps');
  });

  it('omits the mark when there is none', () => {
    const { container } = render(<Masthead title="Operator console" meta="eu-west-1" />);
    expect(container.querySelector('.shrink-0')).toBeNull();
  });

  it('prints in ink on the chrome band', () => {
    render(<Masthead title="Operator console" meta="eu-west-1" tone="ink" />);

    expect(screen.getByText('Operator console').className).toContain('text-ink-text');
    expect(screen.getByText('eu-west-1').className).toContain('text-ink-text-muted');
    // The recipe carries no colour, so it and the tone coexist rather than override each other.
    expect(screen.getByText('eu-west-1').className).toContain('label-caps');
  });
});

describe('BrandLockup', () => {
  it('always renders the mark, the wordmark and the descriptor', () => {
    render(<BrandLockup meta="Operations console" />);

    expect(screen.getByText('Seamnex')).toBeDefined();
    expect(screen.getByText('SN')).toBeDefined();
    expect(screen.getByText('Operations console').className).toContain('label-caps');
    expect(screen.getByText('Seamnex').className).toContain('tracking-[0.01em]');
  });

  it('adapts the mark to an ink surface without changing its geometry', () => {
    render(<BrandLockup tone="ink" meta="Unified access · self-hosted" />);

    const mark = screen.getByText('SN');
    expect(mark.className).toContain('size-8');
    expect(mark.className).toContain('bg-mark-ink-fill');
    expect(mark.className).toContain('border-mark-ink-edge');
    // `primary` is a light-dark() pair; on the never-inverting strip it turned the chip mint in
    // dark mode and swallowed the accent, so the ink colourway may not reach for it.
    expect(mark.className).not.toContain('bg-primary');
    expect(mark.className).not.toContain('bg-ink');
    expect(screen.getByText('Seamnex').className).toContain('text-ink-text');
    expect(screen.getByText('Unified access · self-hosted').className).toContain(
      'text-ink-text-muted',
    );
  });

  it('keeps the 32px mark when the wordmark scales up', () => {
    render(<BrandLockup size="md" />);

    expect(screen.getByText('SN').className).toContain('size-8');
    expect(screen.getByText('Seamnex').className).toContain('text-heading');
  });

  it('omits the descriptor when none is given', () => {
    const { container } = render(<BrandLockup />);
    expect(container.querySelector('.label-caps')).toBeNull();
  });
});

describe('SideNav', () => {
  function renderNav(overrides: Partial<Parameters<typeof SideNav>[0]> = {}) {
    return render(
      <SideNav
        brand={<p>Seamnex</p>}
        groups={[
          {
            label: 'Overview',
            items: [
              {
                href: '#dash',
                label: 'Dashboard',
                active: true,
                hint: 'Everything at a glance',
                badge: <span>3</span>,
              },
              { href: '#jobs', label: 'Jobs', icon: <span data-testid="jobs-icon" /> },
              { href: '#billing', label: 'Billing', disabled: true },
            ],
          },
        ]}
        footer={<p>Support</p>}
        {...overrides}
      />,
    );
  }

  it('renders real anchors grouped under their labels, with badges, hints and icons', () => {
    renderNav();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeDefined();
    expect(screen.getByText('Overview').className).toContain('label-caps');
    expect(screen.getByText('Seamnex')).toBeDefined();
    expect(screen.getByText('Support')).toBeDefined();

    const dashboard = screen.getByRole('link', { name: /Dashboard/ });
    expect(dashboard.tagName).toBe('A');
    expect(dashboard.getAttribute('href')).toBe('#dash');
    expect(dashboard.getAttribute('aria-current')).toBe('page');
    expect(dashboard.getAttribute('title')).toBe('Everything at a glance');
    expect(dashboard.className).toContain('bg-primary-soft');
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByTestId('jobs-icon')).toBeDefined();
    expect(screen.getByRole('link', { name: /Jobs/ }).getAttribute('aria-current')).toBeNull();
  });

  it('disables an unavailable destination without removing it', () => {
    const onNavigate = vi.fn();
    renderNav({ onNavigate });
    const billing = screen.getByRole('link', { name: /Billing/ });
    expect(billing.getAttribute('aria-disabled')).toBe('true');
    expect(billing.className).toContain('cursor-not-allowed');

    fireEvent.click(billing);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('leaves navigation to the browser when the caller does not route', () => {
    renderNav();
    const jobs = screen.getByRole('link', { name: /Jobs/ });
    expect(jobs.getAttribute('aria-disabled')).toBeNull();
    expect(jobs.getAttribute('title')).toBeNull();
    // No handler: the anchor keeps its default behaviour, which is the point of using one.
    fireEvent.click(jobs);
  });

  it('routes a click through the caller', () => {
    const onNavigate = vi.fn();
    renderNav({ onNavigate });
    fireEvent.click(screen.getByRole('link', { name: /Dashboard/ }));
    expect(onNavigate).toHaveBeenCalledWith('#dash');
  });

  it('reports a selection in the branch it renders itself', () => {
    // The console's sheet and its rail share one handler, so "a menu item was chosen" has to be
    // observable without the design system knowing what the app does about it.
    const onSelect = vi.fn();
    renderNav({ onSelect });
    fireEvent.click(screen.getByRole('link', { name: /Jobs/ }));
    expect(onSelect).toHaveBeenCalledWith('#jobs');
  });

  it('reports a selection through the caller router', () => {
    // With `renderLink` the click belongs to the app, so the contract hands it the same callback
    // rather than firing one the app cannot bind to its own event.
    const onSelect = vi.fn();
    const seen: SideNavLinkProps[] = [];
    renderNav({
      onSelect,
      renderLink: (props) => {
        seen.push(props);
        return (
          <a href={props.href} onClick={props.onSelect}>
            {props.children}
          </a>
        );
      },
    });

    fireEvent.click(screen.getByRole('link', { name: /Dashboard/ }));
    expect(seen[0]?.onSelect).toBeTypeOf('function');
    expect(onSelect).toHaveBeenCalledWith('#dash');
  });

  it('reports no selection for an unavailable destination', () => {
    const onSelect = vi.fn();
    renderNav({ onSelect });
    fireEvent.click(screen.getByRole('link', { name: /Billing/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('warms the target on hover and on focus', () => {
    const onPrefetch = vi.fn();
    renderNav({ onPrefetch });
    const jobs = screen.getByRole('link', { name: /Jobs/ });

    fireEvent.pointerEnter(jobs);
    expect(onPrefetch).toHaveBeenLastCalledWith('#jobs');
    fireEvent.focus(jobs);
    expect(onPrefetch).toHaveBeenLastCalledWith('#jobs');
    expect(onPrefetch).toHaveBeenCalledTimes(2);
  });

  it('hands the whole link contract to a caller router', () => {
    const seen: SideNavLinkProps[] = [];
    renderNav({
      renderLink: (props) => {
        seen.push(props);
        return (
          <button type="button" className={props.className} title={props.title}>
            {props.children}
          </button>
        );
      },
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]?.href).toBe('#dash');
    expect(seen[0]?.ariaCurrent).toBe('page');
    expect(seen[1]?.ariaCurrent).toBeUndefined();
    expect(seen[2]?.disabled).toBe(true);
    expect(seen[0]?.onPrefetch).toBeUndefined();
    expect(screen.getByRole('button', { name: /Dashboard/ })).toBeDefined();
  });

  it('offers the prefetch callback to a caller router', () => {
    const onPrefetch = vi.fn();
    const seen: SideNavLinkProps[] = [];
    renderNav({
      onPrefetch,
      renderLink: (props) => {
        seen.push(props);
        return <a href={props.href}>{props.children}</a>;
      },
    });
    seen[0]?.onPrefetch?.();
    expect(onPrefetch).toHaveBeenCalledWith('#dash');
  });

  it('joins the chrome band with its masthead when asked', () => {
    renderNav({ tone: 'ink' });

    // The strip, not the brand node, owns the surface: the caller passes content, not chrome.
    const strip = screen.getByText('Seamnex').parentElement;
    expect(strip?.className).toContain('shell-header');
    expect(strip?.className).toContain('ink-flat');
    expect(strip?.className).toContain('border-line-ink');
  });

  it('keeps a paper masthead by default', () => {
    renderNav();

    const strip = screen.getByText('Seamnex').parentElement;
    expect(strip?.className).toBe('shell-header');
  });

  it('drops the footer when there is none', () => {
    const { container } = render(
      <SideNav brand={<p>Seamnex</p>} groups={[{ label: 'Overview', items: [] }]} />,
    );
    // Two children: the brand strip and the scrolling navigation. No footer block.
    expect((container.firstElementChild as HTMLElement).children).toHaveLength(2);
  });
});

describe('PageHeader', () => {
  it('renders every slot it is given', () => {
    render(
      <PageHeader
        eyebrow={<span>Catalog</span>}
        title="Instances"
        description="Every deployment"
        meta={<span>12 total</span>}
        actions={<button type="button">Deploy</button>}
        className="extra-marker"
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Instances');
    expect(screen.getByText('Catalog')).toBeDefined();
    expect(screen.getByText('Every deployment')).toBeDefined();
    expect(screen.getByText('12 total')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDefined();
  });

  it('leaves the optional slots out', () => {
    render(<PageHeader title="Instances" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Instances');
  });
});

describe('Section', () => {
  it('renders a heading, a description, actions and its children', () => {
    const { container } = render(
      <Section
        title="Recent deployments"
        description="Newest first"
        actions={<button type="button">View all</button>}
        className="extra-marker"
      >
        <p>rows</p>
      </Section>,
    );
    expect(container.querySelector('section')?.className).toContain('extra-marker');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Recent deployments');
    expect(screen.getByText('Newest first')).toBeDefined();
    expect(screen.getByRole('button', { name: 'View all' })).toBeDefined();
    expect(screen.getByText('rows')).toBeDefined();
  });

  it('leaves the optional slots out', () => {
    const { container } = render(<Section title="Recent deployments">rows</Section>);
    expect(container.querySelectorAll('p')).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
