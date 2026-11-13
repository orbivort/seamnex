import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { server } from './server';
import { DEFAULT_SCENARIO, resetState } from './store';

/**
 * The single vitest setup file both frontends load; each app's `test/setup.ts` re-exports it.
 *
 * Why it lives here: the harness is the mock platform's lifecycle — start the MSW server, reset its
 * handlers and scenario, close it — so it belongs to the package that owns that server. Keeping it
 * here also keeps `@seamnex/config` a leaf (tooling only): a config package that imported the mock
 * platform would put `@seamnex/config -> @seamnex/mocks -> @seamnex/domain -> @seamnex/config` in the package graph and
 * make every `turbo run` fail with a cyclic dependency.
 *
 * Why it imports no app code: this package has no dependency on either app (and must not gain
 * one), so anything app-specific — the session reader, the transport wiring — is injected by the
 * app instead (see `@seamnex/config/vitest/helpers`).
 */

// Routes are lazy and failed queries retry once, so the default 1 s wait is too tight when several
// jsdom workers compete for the same machine — and they do compete twice over: within a package,
// and across the nine packages turbo (or a root `vitest run`) schedules at once. A `findBy*` that
// answers in 300 ms is unaffected by this ceiling; only the slowest loaded run is.
configure({ asyncUtilTimeout: 15_000 });

/**
 * jsdom implements no layout engine, so it ships no `ResizeObserver`. Radix and the chart
 * primitives only need the object to exist; the callbacks never fire in a test.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverStub,
    writable: true,
  });
}

/**
 * Same reason: `matchMedia` backs every `motion-safe:`/reduced-motion decision in the design
 * system, and a component that reads it must find a callable rather than `undefined`.
 */
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

beforeAll(() => {
  // An unhandled frame is a request the code under test made and the mock platform does not
  // know about: failing loudly is the only way that surfaces as a test failure instead of a
  // silently mocked 200.
  server.listen({ onUnhandledFrame: 'error' });
});

afterEach(() => {
  // Unmount before resetting the platform, so no in-flight query writes into a tree that the
  // next test has already replaced.
  cleanup();
  server.resetHandlers();
  // Every test starts from the same scenario, so a test that switches scenario cannot leak it.
  // This is the only reset the frontend suites need: per-file `beforeEach` copies of it were
  // removed, because a reset that happens twice is a reset whose second copy can be wrong.
  resetState(DEFAULT_SCENARIO);
});

afterAll(() => {
  server.close();
});
