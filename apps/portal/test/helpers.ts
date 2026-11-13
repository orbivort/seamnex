import { readSession } from '../src/session';
import { applySessionTransport } from '../src/api-mode';
import { createOpenAs } from '@seamnex/config/vitest/helpers';
import { DEFAULT_SCENARIO } from '@seamnex/mocks';

const openInSharedOrder = createOpenAs({
  readSession,
  applySessionTransport,
  defaultScenario: DEFAULT_SCENARIO,
});

/**
 * Installs the URL-derived session and points the request pipeline at the mock adapter.
 * Mirrors `main.tsx`, which is not part of the test tree.
 *
 * The behaviour is shared with the console (`createOpenAs`); only these two app imports stay
 * here, because they resolve the portal's flags, default role and transport factory.
 *
 * The portal's tests call `openAs(role, scenario, path)` while the shared factory takes
 * `(role, path, scenario)` — the console's order. Both orders are in use today, so this wrapper
 * keeps the portal's, which means no portal test file has to change.
 */
export function openAs(role: string, scenario = DEFAULT_SCENARIO, path = '/'): void {
  openInSharedOrder(role, path, scenario);
}
