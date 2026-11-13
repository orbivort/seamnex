import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Users as UsersIcon } from 'lucide-react';
import { HttpResponse, http } from 'msw';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rememberAuthProvider } from '@seamnex/api-client';
import { meFor } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import type * as ApiModeModule from '../../src/api-mode';
import { App } from '../../src/app';
import { RequireAnyCapability, RequireCapability } from '../../src/components/Guard';
import { SessionProvider } from '../../src/session';
import type * as NavigationModule from '../../src/use-navigation';
import { openAs } from '../helpers';

/**
 * Switches the two seams that a single build cannot exercise on its own.
 *
 * `mocksEnabled` is a build-time literal, so one bundle ships either the prototype footer or the
 * live one and the other dialect is dead code in that bundle. `useNavigation` describes a matrix
 * in which no two sections are prefixes of one another, so the most-specific-match rule in the
 * shell never fires. Both are real, shipped behaviour of the other build or the next section; the
 * harness flips them through the module boundary instead of leaving them unexercised.
 */
const flags = vi.hoisted(() => ({ live: false, overlappingSection: false }));

vi.mock('../../src/api-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModeModule>();
  return {
    ...actual,
    get mocksEnabled() {
      return flags.live ? false : actual.mocksEnabled;
    },
    get apiMode() {
      return flags.live ? ('live' as const) : actual.apiMode;
    },
  };
});

vi.mock('../../src/use-navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof NavigationModule>();
  return {
    ...actual,
    useNavigation: () => {
      const real = actual.useNavigation();
      if (!flags.overlappingSection) return real;
      // A shorter href that also prefixes the current path, listed first: only the length sort in
      // `ConsoleLayout` can pick the section the operator is actually on.
      return {
        ...real,
        flat: [
          {
            href: '/admin',
            label: 'Administration at a glance',
            icon: UsersIcon,
            capabilities: [],
          },
          ...real.flat,
        ],
      };
    },
  };
});

afterEach(() => {
  flags.live = false;
  flags.overlappingSection = false;
  vi.unstubAllEnvs();
  rememberAuthProvider('oidc');
});

async function openPalette() {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  return screen.findByRole('dialog');
}

function navigation() {
  const [nav] = screen.getAllByRole('navigation');
  if (nav === undefined) throw new Error('the console rendered no navigation landmark');
  return nav;
}

/**
 * The guard is the only thing under test, so it is mounted against the real session provider
 * instead of the whole app: the two props that matter here (an explicit title, an empty capability
 * list) have no route that passes them today.
 */
function renderGuard(node: ReactNode) {
  return render(
    <MemoryRouter>
      <SessionProvider>{node}</SessionProvider>
    </MemoryRouter>,
  );
}

describe('command palette edges', () => {
  it('opens the section whose row was clicked, not only the one Enter selects', async () => {
    // The mouse path is a second handler on the same row, and it was the only navigation route a
    // pointer user has: without it a click on a result did nothing.
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const dialog = await openPalette();
    const row = within(dialog)
      .getAllByRole('option')
      .find((option) => option.textContent?.includes('Break-glass'));
    if (row === undefined) throw new Error('the palette offers no Break-glass section');
    fireEvent.click(row);

    expect(await screen.findByRole('heading', { name: 'Break-glass sessions' })).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the palette open when the filter matches nothing and a key is pressed', async () => {
    // With no results there is no row to move to or open: the arrows must not select a phantom
    // index, and Enter must not navigate to a section that is not on screen.
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const dialog = await openPalette();
    const input = within(dialog).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'nothing-here' } });
    await within(dialog).findByText(/No section matches/);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('Portfolio overview')).toBeDefined();
    await waitFor(() =>
      expect(within(dialog).getByRole('status').textContent).toContain('No section matches'),
    );
  });
});

describe('console shell chrome', () => {
  it('warns that the numbers on screen are stale in the offline scenario', async () => {
    // The offline scenario answers every request with a 503; the shell has to say so once, above
    // the screen, rather than letting each panel report the same failure separately.
    openAs('R1', '/', 'offline');
    render(<App />);

    expect(await screen.findByText(/Live data unavailable/)).toBeDefined();
  });

  it('marks the most specific section when a shorter href also matches the path', async () => {
    // Sections are matched by prefix, so `/admin` and `/admin/users` both describe
    // `/admin/users`. Only the longest match may own the sidebar highlight and the masthead.
    flags.overlappingSection = true;
    openAs('R1', '/admin/users');
    render(<App />);
    await screen.findByRole('heading', { name: 'Users' });

    const usersLink = within(navigation()).getByRole('link', { name: /Users/ });
    expect(usersLink.getAttribute('aria-current')).toBe('page');
    // Two labels carry "Administration" only when the masthead took the group of the leaf section.
    expect(screen.getAllByText('Administration')).toHaveLength(2);
    expect(screen.queryByText('Administration at a glance')).toBeNull();
  });

  it('dismisses the navigation sheet when a section is chosen', async () => {
    /*
     * The sheet is modal: leaving it open hands the next screen to the operator behind a dimmed
     * overlay with the page scroll-locked, and the section they asked for is the section they can
     * no longer reach. One selection, one dismissal.
     */
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('link', { name: /Catalog/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The sheet's copy is gone with it, so the remaining navigation landmark is the rail's, and it
    // is the one that has to agree the operator arrived.
    const catalog = within(screen.getByRole('navigation')).getByRole('link', { name: /Catalog/ });
    await waitFor(() => expect(catalog.getAttribute('aria-current')).toBe('page'));
  });

  it('keeps the sheet open when a section is opened in another tab', async () => {
    // A modifier-click is not an in-place selection: the operator still has the screen they are
    // reading, and closing the sheet would hide the list they are browsing.
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('link', { name: /Catalog/ }), { ctrlKey: true });

    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('opens the palette from the topbar control, not only from the keyboard', async () => {
    // The shortcut is invisible to a pointer user; the button is the discoverable path to the same
    // dialog, and it is a separate handler from the `Ctrl-K` listener.
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));

    expect(await screen.findByRole('dialog')).toBeDefined();
  });

  it('opens the sign-out confirmation from the topbar as well as from the sidebar', async () => {
    // Two controls, two handlers, one dialog: the footer one is sheet-only, so an operator on a
    // wide screen would otherwise have no way to end the session.
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const triggers = screen.getAllByRole('button', { name: 'Sign out' });
    const topbarTrigger = triggers[triggers.length - 1];
    if (topbarTrigger === undefined) throw new Error('the topbar exposes no sign-out control');
    fireEvent.click(topbarTrigger);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/ends your platform session/i)).toBeDefined();
  });

  it('reports a failed session read as an unavailable platform, not as a signed-out user', async () => {
    // In live mode the footer is the only place that answers "is the API answering?"; an auditor
    // reading a stale table has to be able to see that the last request failed.
    flags.live = true;
    rememberAuthProvider('oidc');
    server.use(http.get('/api/v1/me', () => HttpResponse.error()));

    openAs('R1', '/catalog');
    render(<App />);

    expect(await screen.findByTitle(/failed; the values on screen may be stale/)).toBeDefined();
    expect(screen.getAllByText('unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText('Platform API')).toBeDefined();
  });

  it('says the session is still being verified before the first answer arrives', async () => {
    // The footer must not claim "connected" before `/me` has answered, and it must not claim that
    // MFA was used either: both sentences are read from a query that is still in flight.
    flags.live = true;
    rememberAuthProvider('oidc');
    server.use(http.get('/api/v1/me', () => new Promise<Response>(() => {})));

    openAs('R1', '/catalog');
    render(<App />);

    expect(await screen.findByTitle(/Verifying the session against/)).toBeDefined();
    expect(screen.getByLabelText(/MFA: the session has not been reported yet/)).toBeDefined();
  });

  it('reports the session as connected and does not claim MFA when none was used', async () => {
    // The dot must stay grey for a single-factor session instead of turning green just because a
    // method string exists: `mfaSatisfied`, not `mfaMethod`, is the state.
    flags.live = true;
    rememberAuthProvider('oidc');
    server.use(
      http.get('/api/v1/me', () => HttpResponse.json({ ...meFor('R1'), mfaSatisfied: false })),
    );

    openAs('R1', '/catalog');
    render(<App />);

    expect(await screen.findByTitle(/Requests resolve against/)).toBeDefined();
    expect(screen.getAllByText('connected').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/MFA: not used in this session/)).toBeDefined();
    // Nothing to offer: no prototype controls, and no development picker without the stub provider.
    expect(screen.queryByLabelText(/Development role override/)).toBeNull();
    expect(screen.queryByText(/Role switching re-renders navigation/)).toBeNull();
  });

  it('offers the development role picker against the stub provider only', async () => {
    // Against a real provider the picker cannot change the session, so the footer drops it; against
    // the stub it survives, hidden behind a tooltip that explains what it is.
    flags.live = true;
    rememberAuthProvider('stub');

    openAs('R1', '/catalog');
    render(<App />);

    expect(await screen.findByLabelText(/Development role override/)).toBeDefined();
    expect(screen.getByText('Platform API')).toBeDefined();
    expect(screen.queryByText('simulated data')).toBeNull();
    expect(screen.queryByText(/Role switching re-renders navigation/)).toBeNull();
  });
});

describe('route guards', () => {
  it('falls back to the portal sign-in capability when a guard names no capability', async () => {
    // `RequireAnyCapability` reads `capabilities[0]` for its 403 panel; an empty list has to name
    // something, and the capability every role holds is the honest answer.
    openAs('R5', '/forbidden');
    renderGuard(<RequireAnyCapability capabilities={[]}>{'guarded content'}</RequireAnyCapability>);

    expect(await screen.findByText('capability: portal.sign_in')).toBeDefined();
    expect(screen.queryByText('guarded content')).toBeNull();
  });

  it('lets a route override the title of its own 403 panel', async () => {
    // A generic "not permitted for your role" is wrong for a screen that is refused by a narrower
    // rule; the guard passes a specific title through when the route supplies one.
    openAs('R5', '/forbidden');
    renderGuard(
      <RequireCapability capability="audit.view" title="The audit trail needs an audit grant">
        {'guarded content'}
      </RequireCapability>,
    );

    expect(await screen.findByText('The audit trail needs an audit grant')).toBeDefined();
    expect(screen.getByText('capability: audit.view')).toBeDefined();
  });
});

describe('forbidden footer link', () => {
  it('falls back to the local development portal when no origin is configured', async () => {
    // A deployed console must never hard-code localhost, and a console built without the variable
    // must still link somewhere rather than render an empty href.
    vi.stubEnv('VITE_PORTAL_URL', '');
    openAs('R5', '/forbidden');
    render(<App />);

    const link = await screen.findByRole('link', { name: /Open the portal/ });
    expect(link.getAttribute('href')).toBe('http://localhost:5173/?role=R5');
  });
});
