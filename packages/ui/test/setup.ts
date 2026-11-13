import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmount after every test.
 *
 * Testing Library registers its own cleanup on a *global* `afterEach`, and this workspace keeps
 * `globals: false` so tests import the API explicitly. Without this hook one test's tree would stay
 * mounted under the next one, which is how "duplicate element" failures appear far from their cause.
 */
afterEach(() => {
  cleanup();
});

/**
 * `ResizeObserver` is a browser API jsdom does not implement, and Radix's popper measures its
 * content with one. A no-op observer is enough: the tooltip still renders and portals, it simply
 * does not get a measured size, and no production code path depends on that measurement.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}
