import { vi } from 'vitest';

/**
 * A stand-in for `window.location`.
 *
 * jsdom defines `location.assign` and `location.replace` as non-configurable, so a spy on the two
 * navigation methods is impossible ("Cannot redefine property: assign"). The `location` property
 * *is* configurable, so the whole object is swapped for this stub: a navigation is recorded instead
 * of performed, and `setLocationUrl` moves the fake to another URL without leaving the test — which
 * is how a `popstate` step or a hand-edited query string is staged.
 *
 * `restoreLocation` runs from the shared `afterEach` in `setup.ts`, so a file cannot leak a
 * navigated-away location into the next one.
 */
export type LocationStub = {
  href: string;
  origin: string;
  protocol: string;
  host: string;
  pathname: string;
  search: string;
  hash: string;
  assign: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  toString: () => string;
};

let active: LocationStub | null = null;
let savedDescriptor: PropertyDescriptor | undefined;

function projectUrl(target: LocationStub, href: string): void {
  // A path is resolved against jsdom's own origin, so `stubLocation('/?role=R1')` reads the way a
  // browser does: `href` becomes absolute, `pathname` and `search` are just the path part.
  const url = new URL(href, 'http://localhost');
  target.href = url.toString();
  target.origin = url.origin;
  target.protocol = url.protocol;
  target.host = url.host;
  target.pathname = url.pathname;
  target.search = url.search;
  target.hash = url.hash;
}

function createStub(href: string): LocationStub {
  const stub: LocationStub = {
    href: '',
    origin: '',
    protocol: '',
    host: '',
    pathname: '',
    search: '',
    hash: '',
    assign: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
    toString: () => stub.href,
  };
  projectUrl(stub, href);
  return stub;
}

/** Installs the stub at `href` and returns it. A second call reuses the installed stub. */
export function stubLocation(href = 'http://localhost/'): LocationStub {
  if (active === null) {
    savedDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
    active = createStub(href);
    Object.defineProperty(window, 'location', { configurable: true, value: active });
  } else {
    projectUrl(active, href);
  }
  return active;
}

/** Moves the installed stub to `href` without navigating, as a back/forward step would. */
export function setLocationUrl(href: string): void {
  projectUrl(stubLocation(href), href);
}

/** Puts jsdom's own `location` back. Safe to call when no stub was ever installed. */
export function restoreLocation(): void {
  if (active === null) return;
  if (savedDescriptor !== undefined) Object.defineProperty(window, 'location', savedDescriptor);
  active = null;
  savedDescriptor = undefined;
}
