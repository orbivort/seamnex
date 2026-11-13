import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { restoreLocation } from './location';

/**
 * Unmount after every test, hand the real clock back, and put jsdom's own `location` back.
 *
 * Testing Library registers its own cleanup on a *global* `afterEach`, and this workspace keeps
 * `globals: false` so tests import the API explicitly. The timer reset is the same kind of hygiene
 * for `vi.useFakeTimers()`: a suite that forgets it hangs every later test in the file. The
 * location reset is the same argument for the stub in `./location` — a suite that navigated would
 * otherwise leave every later file reading another URL.
 */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  restoreLocation();
});
