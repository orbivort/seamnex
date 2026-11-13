import type { LauncherTile } from '@seamnex/domain';

/**
 * One completely populated tile, so a test states only the field it is about.
 *
 * Kept in `test` (excluded from coverage) rather than exported from a screen: the components
 * under test take a tile as a prop, and a fixture that drifted with a page's own defaults would
 * hide exactly the branch the test exists to exercise.
 */
export const BASE_TILE: LauncherTile = {
  instanceId: 'inst-crm',
  entryKey: 'D01-01',
  domain: 'CRM & Sales Pipeline',
  product: 'EspoCRM',
  description: 'Clean, fast CRM for a 5–100 person sales team.',
  slug: 'crm',
  url: 'https://crm.seamnex.local/',
  version: '10.0.11',
  availableVersion: null,
  plainStatus: 'available',
  guaranteeClass: 'native',
  ssoState: 'sso',
  ssoHealth: {
    checked: true,
    ok: true,
    checkedAt: '2026-11-02T08:00:00.000Z',
    detail: 'stages 1–2 passed',
    reason: 'ok',
  },
  authLabel: 'Native SSO',
  productRole: 'User',
  launchable: true,
  degradedReason: null,
  maintenanceTitle: null,
  lastVerifiedAt: '2026-11-02T08:00:00.000Z',
  badge: null,
};

export function tile(overrides: Partial<LauncherTile> = {}): LauncherTile {
  return { ...BASE_TILE, ...overrides };
}
