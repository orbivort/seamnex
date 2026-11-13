import { readSession } from '../src/session';
import { applySessionTransport } from '../src/api-mode';
import { createOpenAs } from '@seamnex/config/vitest/helpers';
import { DEFAULT_SCENARIO } from '@seamnex/mocks';

/**
 * Installs the URL-derived session and points the request pipeline at the mock adapter.
 * Mirrors `main.tsx`, which is not part of the test tree.
 *
 * The behaviour is shared with the portal (`createOpenAs`); only these app imports stay here,
 * because they resolve the console's flags, default role and transport factory. The scenario
 * default comes from `@seamnex/mocks` rather than a literal, so the harness reset and `openAs` cannot
 * drift apart.
 */
export const openAs = createOpenAs({
  readSession,
  applySessionTransport,
  defaultScenario: DEFAULT_SCENARIO,
});

/**
 * A query result that must not stay `undefined` for the rest of the test.
 *
 * `noUncheckedIndexedAccess` types every `getAllByRole(...)[0]`, every `find(...)` and every store
 * lookup as possibly missing — correctly, because a missing row usually means the screen under
 * test did not render it. Resolving that here names what was expected; a non-null assertion would
 * only move the failure to `undefined.foo`, where the message says nothing about the cause.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`Expected ${what}, but nothing matched`);
  return value;
}
