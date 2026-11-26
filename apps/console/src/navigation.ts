import type { LucideIcon } from 'lucide-react';
import type { Capability, PlatformRole } from '@seamnex/domain';
import {
  CONSOLE_ROUTES,
  GROUP_ORDER,
  admitsRoute,
  hrefOf,
  routeById,
  scopeLimitedRoute,
  type Admission,
  type ConsoleGroup,
  type ConsoleRoute,
} from './routes';

export type NavEntry = {
  href: string;
  label: string;
  icon: LucideIcon;
  capabilities: readonly Capability[];
  admits: Admission;
  /**
   * The role holds the entry's capabilities only within a narrower scope. The entry stays visible —
   * the capability is genuinely held and the screen can state the scope — but the sidebar says so
   * instead of letting the screen be the first place the operator learns it (ADR-FE-01).
   */
  scopeLimited: boolean;
};

export type NavGroup = { label: ConsoleGroup; items: NavEntry[] };

/**
 * ADR-FE-01 — the sidebar is a *rendering* of the registry, not a second declaration of policy.
 *
 * Before this, every entry carried its own capability list, hand-copied from the route guard in
 * `app.tsx`. One list is now derived from the other by construction, and `test/unit/routes.test.ts`
 * pins the property that matters: what the sidebar offers, the router admits.
 *
 * The filter is three-valued. `can()` collapsed `none` and `scoped`, which is how a domain owner's
 * sidebar came to offer Instances and answer with a 403 panel.
 */
export function navigationFor(role: PlatformRole): NavGroup[] {
  return GROUP_ORDER.map((label) => ({
    label,
    items: CONSOLE_ROUTES.filter((route) => route.nav?.group === label)
      .map((route) => entryFor(role, route))
      .filter((entry): entry is NavEntry => entry !== null),
  })).filter((group) => group.items.length > 0);
}

function entryFor(role: PlatformRole, route: ConsoleRoute): NavEntry | null {
  const nav = route.nav;
  if (nav === undefined) return null;
  // Admission and the marker are the registry's answers, not this file's: the router asks the same
  // function, so an entry the sidebar offers is an entry the route admits.
  if (!admitsRoute(role, route)) return null;
  return {
    href: hrefOf(route),
    label: nav.label,
    icon: nav.icon,
    capabilities: route.capabilities,
    admits: route.admits,
    scopeLimited: scopeLimitedRoute(role, route),
  };
}

/**
 * Where a role lands after signing in.
 *
 * A curated order rather than "the first entry it may read": the landing route must be a *home*
 * surface. Catalog is readable by an end user and is not where a console session should start, so
 * the three screens that answer "what is running" are named here and the rest fall through to the
 * forbidden page.
 */
const LANDING_ORDER = ['overview', 'instances', 'workflows'];

export function defaultRouteFor(role: PlatformRole): string {
  for (const id of LANDING_ORDER) {
    const route = routeById(id);
    if (route === undefined) continue;
    if (entryFor(role, route) !== null) return hrefOf(route);
  }
  return '/forbidden';
}

export function flatNav(role: PlatformRole): NavEntry[] {
  return navigationFor(role).flatMap((group) => group.items);
}
