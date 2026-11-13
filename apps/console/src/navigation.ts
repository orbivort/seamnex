import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ArchiveRestore,
  BadgeCheck,
  BookLock,
  Boxes,
  FileClock,
  FileLock2,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  PackageCheck,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { Capability, PlatformRole } from '@seamnex/domain';
import { can, canMutate } from '@seamnex/domain';

export type NavEntry = {
  href: string;
  label: string;
  icon: LucideIcon;
  capabilities: Capability[];
  badge?: string;
  /** Admin surfaces require an unscoped grant, not a request/approval scope. */
  requireFull?: boolean;
};

export type NavGroup = { label: string; items: NavEntry[] };

const GROUPS: NavGroup[] = [
  {
    label: 'Operations',
    items: [
      { href: '/', label: 'Overview', icon: LayoutDashboard, capabilities: ['capacity.view'] },
      { href: '/catalog', label: 'Catalog', icon: Boxes, capabilities: ['catalog.browse'] },
      {
        href: '/instances',
        label: 'Instances',
        icon: PackageCheck,
        capabilities: ['instance.view_logs'],
      },
      { href: '/jobs', label: 'Jobs', icon: ListChecks, capabilities: ['instance.view_logs'] },
      {
        href: '/registry',
        label: 'Integration registry',
        icon: BadgeCheck,
        capabilities: ['registry.view'],
      },
      { href: '/capacity', label: 'Capacity', icon: Gauge, capabilities: ['capacity.view'] },
    ],
  },
  {
    label: 'Automation',
    items: [
      {
        href: '/workflows',
        label: 'Workflows',
        icon: Workflow,
        capabilities: ['workflow.view_runs', 'workflow.author'],
      },
    ],
  },
  {
    label: 'Governance',
    items: [
      {
        href: '/governance/audit',
        label: 'Audit trail',
        icon: ScrollText,
        capabilities: ['audit.view'],
      },
      {
        href: '/governance/licenses',
        label: 'License register',
        icon: BookLock,
        capabilities: ['license.view'],
      },
      {
        href: '/governance/patches',
        label: 'Patch register',
        icon: Wrench,
        capabilities: ['patch.view'],
      },
      {
        href: '/governance/posture',
        label: 'Security posture',
        icon: ShieldCheck,
        capabilities: ['posture.view'],
      },
      {
        href: '/governance/recovery',
        label: 'Recovery',
        icon: ArchiveRestore,
        capabilities: ['recovery.view'],
      },
      {
        href: '/governance/privacy',
        label: 'Privacy requests',
        icon: FileLock2,
        capabilities: ['privacy.view'],
      },
      {
        href: '/governance/break-glass',
        label: 'Break-glass',
        icon: KeyRound,
        capabilities: ['breakglass.request', 'breakglass.approve'],
      },
      {
        href: '/governance/access-requests',
        label: 'Access requests',
        icon: LifeBuoy,
        capabilities: ['entitlement.grant'],
      },
      {
        href: '/governance/maintenance',
        label: 'Maintenance & exceptions',
        icon: FileClock,
        /*
         * One entry, two panels, and the two do not share an authority: windows are read with
         * `settings.view` and written with `maintenance.configure`, exceptions with
         * `exception.decide`. Listing `metadata.manage` admitted a role that can do neither and
         * then asked for a list it was refused; each panel now checks its own capability.
         */
        capabilities: ['maintenance.configure', 'settings.view', 'exception.decide'],
      },
    ],
  },
  {
    label: 'Administration',
    items: [
      // Read-only directory evidence: R1 and R2 may open it, only R1 may disable a user.
      { href: '/admin/users', label: 'Users', icon: Users, capabilities: ['identity.view_users'] },
      {
        href: '/admin/groups',
        label: 'Groups & mappings',
        icon: UsersRound,
        capabilities: ['identity.manage_groups'],
        requireFull: true,
      },
      {
        href: '/admin/identity-sync',
        label: 'Identity sync',
        icon: Activity,
        capabilities: ['identity.manage_users'],
        requireFull: true,
      },
      {
        href: '/admin/settings',
        label: 'Platform settings',
        icon: Settings,
        capabilities: ['settings.view'],
        requireFull: true,
      },
    ],
  },
];

/**
 * Filtering deliberately stays role-based instead of taking a pre-derived `RoleCapabilities` set.
 *
 * An optional second argument would be a code path no caller exercises: both entry points are
 * already inside a `useMemo` keyed on the role (`useNavigation`) or are a one-shot redirect
 * (`defaultRouteFor` from `ConsoleHome`), so this walks the matrix once per consumer per role
 * change rather than once per render. Handing it a set would only pay off if those callers were
 * changed to pass one — and then two shapes of the same filter would exist, which is how a guard
 * and the sidebar start disagreeing about a role.
 */
export function navigationFor(role: PlatformRole): NavGroup[] {
  return GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      item.requireFull
        ? item.capabilities.some((capability) => canMutate(role, capability))
        : item.capabilities.some((capability) => can(role, capability)),
    ),
  })).filter((group) => group.items.length > 0);
}

export function defaultRouteFor(role: PlatformRole): string {
  if (can(role, 'capacity.view')) return '/';
  if (can(role, 'instance.view_logs')) return '/instances';
  if (can(role, 'workflow.view_runs')) return '/workflows';
  return '/forbidden';
}

export function flatNav(role: PlatformRole): NavEntry[] {
  return navigationFor(role).flatMap((group) => group.items);
}
