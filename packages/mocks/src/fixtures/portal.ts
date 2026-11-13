import type {
  Entitlement,
  EntitlementResponse,
  Instance,
  InstanceStatus,
  LauncherResponse,
  LauncherTile,
  LaunchTarget,
  LogoutResponse,
  Me,
  PlainStatus,
  PlatformRole,
  StatusBanner,
} from '@seamnex/domain';
import {
  authLabelFor,
  can,
  canonicalVersion,
  guaranteeShort,
  GUARANTEE_CLASS_LABELS,
  plainStatusFor,
  updateAvailable,
} from '@seamnex/domain';
import { CATALOG_BY_KEY } from './catalog';
import { at, ENVIRONMENT_NAME } from './context';
import { INSTANCES, INSTANCE_STATUSES } from './instances';

const SESSION_EXPIRES = at(600);
const SYNCED_AT = at(-24);

const IDENTITIES: Record<PlatformRole, Omit<Me, 'roles' | 'primaryRole'>> = {
  R1: {
    id: 'usr-sofia',
    username: 'sofia.almeida',
    displayName: 'Sofia Almeida',
    email: 'sofia.almeida@seamnex.local',
    initials: 'SA',
    mfaSatisfied: true,
    mfaMethod: 'WebAuthn security key',
    sessionExpiresAt: SESSION_EXPIRES,
    identitySyncedAt: SYNCED_AT,
    groups: ['platform-admins', 'it-operations'],
  },
  R2: {
    id: 'usr-ruth-adler',
    username: 'ruth.adler',
    displayName: 'Ruth Adler',
    email: 'ruth.adler@seamnex.local',
    initials: 'RA',
    mfaSatisfied: true,
    mfaMethod: 'TOTP authenticator',
    sessionExpiresAt: SESSION_EXPIRES,
    identitySyncedAt: SYNCED_AT,
    groups: ['platform-auditors', 'finance-owners'],
  },
  R3: {
    id: 'usr-mara-vogel',
    username: 'mara.vogel',
    displayName: 'Mara Vogel',
    email: 'mara.vogel@seamnex.local',
    initials: 'MV',
    mfaSatisfied: true,
    mfaMethod: 'WebAuthn security key',
    sessionExpiresAt: SESSION_EXPIRES,
    identitySyncedAt: SYNCED_AT,
    groups: ['domain-revenue-owners'],
  },
  R4: {
    id: 'usr-tomas-reiter',
    username: 'tomas.reiter',
    displayName: 'Tomas Reiter',
    email: 'tomas.reiter@seamnex.local',
    initials: 'TR',
    mfaSatisfied: true,
    mfaMethod: 'TOTP authenticator',
    sessionExpiresAt: SESSION_EXPIRES,
    identitySyncedAt: SYNCED_AT,
    groups: ['helpdesk-admins'],
  },
  R5: {
    id: 'usr-lena-hoff',
    username: 'lena.hoff',
    displayName: 'Lena Hoff',
    email: 'lena.hoff@seamnex.local',
    initials: 'LH',
    mfaSatisfied: true,
    mfaMethod: 'TOTP authenticator',
    sessionExpiresAt: SESSION_EXPIRES,
    identitySyncedAt: SYNCED_AT,
    groups: ['all-staff', 'helpdesk-agents', 'finance-readers'],
  },
  R6: {
    id: 'usr-jonas-weber',
    username: 'jonas.weber',
    displayName: 'Jonas Weber',
    email: 'jonas.weber@northwind.example',
    initials: 'JW',
    mfaSatisfied: false,
    mfaMethod: 'Scoped invite link',
    sessionExpiresAt: at(90),
    identitySyncedAt: at(-45),
    groups: ['external-clients'],
  },
};

const ROLE_SCOPES: Record<PlatformRole, Me['roles']> = {
  R1: [
    {
      role: 'R1',
      scopeType: 'platform',
      scopeId: null,
      scopeLabel: 'Platform',
      source: 'group /platform-admins',
      expiresAt: null,
    },
  ],
  R2: [
    {
      role: 'R2',
      scopeType: 'platform',
      scopeId: null,
      scopeLabel: 'Platform',
      source: 'group /platform-auditors',
      expiresAt: null,
    },
  ],
  R3: [
    {
      role: 'R3',
      scopeType: 'domain',
      scopeId: 'Revenue & Customer',
      scopeLabel: 'Revenue & Customer',
      source: 'group /domain/revenue-owners',
      expiresAt: null,
    },
    {
      role: 'R5',
      scopeType: 'instance',
      scopeId: 'inst-documents',
      scopeLabel: 'D08-01 Paperless-ngx',
      source: 'group /all-staff',
      expiresAt: null,
    },
  ],
  R4: [
    {
      role: 'R4',
      scopeType: 'instance',
      scopeId: 'inst-helpdesk',
      scopeLabel: 'D03-01 Zammad',
      source: 'group /products/helpdesk-admins',
      expiresAt: null,
    },
    {
      role: 'R5',
      scopeType: 'instance',
      scopeId: 'inst-collab',
      scopeLabel: 'D10-01 Nextcloud Hub',
      source: 'group /all-staff',
      expiresAt: null,
    },
  ],
  R5: [
    {
      role: 'R5',
      scopeType: 'platform',
      scopeId: null,
      scopeLabel: 'End user',
      source: 'group /all-staff',
      expiresAt: null,
    },
  ],
  R6: [
    {
      role: 'R6',
      scopeType: 'instance',
      scopeId: 'inst-helpdesk',
      scopeLabel: 'D03-01 Zammad — client portal',
      source: 'scoped invite link',
      expiresAt: at(90),
    },
  ],
};

export const ME_BY_ROLE: Record<PlatformRole, Me> = Object.fromEntries(
  (Object.keys(IDENTITIES) as PlatformRole[]).map((role) => [
    role,
    { ...IDENTITIES[role], primaryRole: role, roles: ROLE_SCOPES[role] },
  ]),
) as Record<PlatformRole, Me>;

const ENTITLED: Record<PlatformRole, string[]> = {
  R1: INSTANCES.map((instance) => instance.id),
  R2: INSTANCES.map((instance) => instance.id),
  R3: ['inst-crm', 'inst-marketing', 'inst-helpdesk', 'inst-shop', 'inst-documents'],
  R4: ['inst-helpdesk', 'inst-collab'],
  R5: [
    'inst-crm',
    'inst-helpdesk',
    'inst-documents',
    'inst-projects',
    'inst-collab',
    'inst-insights',
  ],
  R6: ['inst-helpdesk'],
};

const PRODUCT_ROLE: Record<PlatformRole, string> = {
  R1: 'Platform administrator',
  R2: 'Auditor (read-only)',
  R3: 'Domain owner',
  R4: 'Product administrator',
  R5: 'User',
  R6: 'Guest',
};

const BADGE: Record<PlatformRole, string | null> = {
  R1: 'Platform admin',
  R2: 'Read-only',
  R3: 'Domain owner',
  R4: 'Product admin',
  R5: null,
  R6: 'Guest',
};

function portalReason(status: PlainStatus): string | null {
  if (status === 'degraded')
    return 'Some features are temporarily unavailable while a fix is applied.';
  if (status === 'unavailable') return 'This service is offline right now. Your data is safe.';
  return null;
}

/**
 * FR-3.7: the launcher renders the derived status projection, not the instance state, so a
 * maintenance window reaches the badge, the filter and the counts.
 */
function statusFor(instance: Instance, statuses: Record<string, InstanceStatus>): PlainStatus {
  const projected = statuses[instance.id]?.plainStatus;
  if (projected) return projected;
  return instance.state === 'stopped'
    ? 'unavailable'
    : plainStatusFor(instance.state, instance.ready);
}

function tileFor(role: PlatformRole, instance: Instance, status: PlainStatus): LauncherTile {
  const entry = CATALOG_BY_KEY[instance.entryKey];
  const guaranteeClass = entry?.guaranteeClass ?? 'fa_gate';
  // The fixture set has no forward-auth or IdP-client model, so the sign-in shape follows the
  // guarantee class exactly as the API computes it for a fully provisioned instance.
  const ssoState = guaranteeClass === 'fa_gate' ? 'sign_in_required' : 'sso';
  return {
    instanceId: instance.id,
    entryKey: instance.entryKey,
    domain: instance.domain,
    product: instance.product,
    description: instance.description,
    slug: instance.slug,
    url: `https://${instance.domainRoute}/`,
    version: canonicalVersion(instance.currentVersion),
    // Same rule as the API: the pin is announced only when it is strictly newer than what runs, so
    // `v16.53.0` and `16.53.0` never produce an "available" badge against each other.
    availableVersion: updateAvailable(instance.currentVersion, instance.availableVersion)
      ? canonicalVersion(instance.availableVersion)
      : null,
    plainStatus: status,
    guaranteeClass,
    ssoState,
    // The fixtures model a fully provisioned instance, which is what the API reports for one whose
    // last end-to-end check passed: the evidence is present and recent.
    ssoHealth: {
      checked: ssoState === 'sso',
      ok: ssoState === 'sso',
      checkedAt: ssoState === 'sso' ? instance.observedAt : null,
      detail: ssoState === 'sso' ? 'stages 1–2 passed (fixture)' : '',
      reason: ssoState === 'sso' ? ('ok' as const) : ('never_checked' as const),
    },
    authLabel: authLabelFor(guaranteeClass, ssoState),
    productRole: PRODUCT_ROLE[role],
    launchable: can(role, 'portal.launch') && instance.state !== 'stopped',
    degradedReason: portalReason(status),
    maintenanceTitle: instance.maintenance?.title ?? null,
    lastVerifiedAt: instance.observedAt,
    badge: BADGE[role],
  };
}

export function isEntitled(role: PlatformRole, instanceId: string): boolean {
  return ENTITLED[role].includes(instanceId);
}

export function launcherFor(
  role: PlatformRole,
  instances: Instance[],
  statuses: Record<string, InstanceStatus> = {},
): LauncherResponse {
  const entitled = new Set(ENTITLED[role]);
  const tiles = instances
    .filter((instance) => entitled.has(instance.id))
    .map((instance) => tileFor(role, instance, statusFor(instance, statuses)));
  return {
    environment: ENVIRONMENT_NAME,
    generatedAt: at(-1),
    tiles,
    counts: {
      total: tiles.length,
      available: tiles.filter((tile) => tile.plainStatus === 'available').length,
      degraded: tiles.filter((tile) => tile.plainStatus === 'degraded').length,
      unavailable: tiles.filter((tile) => tile.plainStatus === 'unavailable').length,
      maintenance: tiles.filter((tile) => tile.plainStatus === 'maintenance').length,
    },
  };
}

export const LAUNCHER_BY_ROLE: Record<PlatformRole, LauncherResponse> = Object.fromEntries(
  (Object.keys(ENTITLED) as PlatformRole[]).map((role) => [
    role,
    launcherFor(role, INSTANCES, INSTANCE_STATUSES),
  ]),
) as Record<PlatformRole, LauncherResponse>;

const GROUP_FOR: Record<PlatformRole, string> = {
  R1: '/platform-admins',
  R2: '/platform-auditors',
  R3: '/domain/revenue-owners',
  R4: '/products/helpdesk-admins',
  R5: '/all-staff',
  R6: '/external-clients (invite)',
};

export function entitlementsFor(role: PlatformRole, instances: Instance[]): EntitlementResponse {
  const entitled = new Set(ENTITLED[role]);
  const entitlements: Entitlement[] = instances
    .filter((instance) => entitled.has(instance.id))
    .map((instance) => {
      const entry = CATALOG_BY_KEY[instance.entryKey];
      const guaranteeClass = entry?.guaranteeClass ?? 'fa_gate';
      const gate = guaranteeClass === 'fa_gate';
      return {
        instanceId: instance.id,
        entryKey: instance.entryKey,
        domain: instance.domain,
        product: instance.product,
        slug: instance.slug,
        productRole: PRODUCT_ROLE[role],
        source: 'group' as const,
        groupPath: GROUP_FOR[role],
        syncState: gate
          ? ('unsupported' as const)
          : instance.id === 'inst-collab'
            ? ('pending' as const)
            : ('applied' as const),
        syncedAt: SYNCED_AT,
        launchable: can(role, 'portal.launch') && instance.state !== 'stopped',
        authLabel: authLabelFor(guaranteeClass, gate ? 'sign_in_required' : 'sso'),
      };
    });

  return {
    subject: {
      id: IDENTITIES[role].id,
      name: IDENTITIES[role].displayName,
      email: IDENTITIES[role].email,
    },
    generatedAt: at(-1),
    entitlements,
    summary: {
      total: entitlements.length,
      domains: new Set(entitlements.map((item) => item.domain)).size,
      pending: entitlements.filter((item) => item.syncState === 'pending').length,
      signInRequired: entitlements.filter((item) => item.authLabel === guaranteeShort('fa_gate'))
        .length,
    },
  };
}

export const ENTITLEMENTS_BY_ROLE: Record<PlatformRole, EntitlementResponse> = Object.fromEntries(
  (Object.keys(ENTITLED) as PlatformRole[]).map((role) => [role, entitlementsFor(role, INSTANCES)]),
) as Record<PlatformRole, EntitlementResponse>;

export const STATUS_BANNERS: StatusBanner[] = [
  {
    id: 'banner-1',
    severity: 'warning',
    title: 'People Operations is degraded',
    message:
      'Leave requests and the employee directory may be slow while the team completes an upgrade rollback. Payroll is unaffected.',
    active: true,
    updatedAt: at(-40),
    windowId: null,
  },
  {
    id: 'banner-2',
    severity: 'info',
    title: 'Planned maintenance: Nextcloud Hub',
    message:
      'Files and Talk will be briefly unavailable on 24 October between 20:00 and 22:00 Europe/Berlin.',
    active: false,
    updatedAt: at(-300),
    windowId: 'mw-442',
  },
];

export const LAUNCH_TARGETS: Record<string, LaunchTarget> = Object.fromEntries(
  INSTANCES.map((instance) => {
    const entry = CATALOG_BY_KEY[instance.entryKey];
    const gate = entry?.guaranteeClass === 'fa_gate';
    // Mirror the API: only `native` opens on its plain URL; the `fa_*` classes are gated at the
    // edge, so the portal has to redeem a launch ticket before the product will see a session.
    const forwarded = (entry?.guaranteeClass ?? 'fa_gate') !== 'native';
    return [
      instance.id,
      {
        instanceId: instance.id,
        url: `https://${instance.domainRoute}/`,
        authClass: entry?.guaranteeClass ?? 'fa_gate',
        ssoState: gate ? ('sign_in_required' as const) : ('sso' as const),
        note: gate
          ? `${GUARANTEE_CLASS_LABELS.fa_gate.label}. Your ${instance.product} credential is provisioned outside the platform and is not stored here.`
          : 'Opens in a new tab using your existing portal session. No second credential prompt.',
        opensInNewTab: true,
        bootstrapRequired: forwarded,
        // ADR-BE-22: only a gated route relays, and the fixture shows the healthy state — a
        // deployment whose first provisioning pass has already run.
        relayState: gate ? ('ready' as const) : ('unavailable' as const),
        ssoHealth: {
          checked: !gate,
          ok: !gate,
          checkedAt: gate ? null : instance.observedAt,
          detail: gate ? '' : 'stages 1–2 passed (fixture)',
          reason: gate ? ('never_checked' as const) : ('ok' as const),
        },
      },
    ];
  }),
);

export function logoutFor(role: PlatformRole, instances: Instance[]): LogoutResponse {
  const entitled = new Set(ENTITLED[role]);
  const residualSessions = instances
    .filter((instance) => entitled.has(instance.id))
    .flatMap((instance) => {
      const entry = CATALOG_BY_KEY[instance.entryKey];
      if (!entry || entry.integration.sloSupported) return [];
      return [
        {
          instanceId: instance.id,
          product: instance.product,
          maxRemainingMinutes: entry.integration.sessionMaxMinutes,
          singleLogout: false,
          // The estimate carries the date it was verified, so the screen can print "expected"
          // rather than a number that reads like a live session inventory.
          verifiedAt: instance.observedAt,
        },
      ];
    })
    .slice(0, 4);

  return {
    signedOutAt: at(0),
    residualSessions,
    statement:
      residualSessions.length === 0
        ? 'You are signed out everywhere. No product sessions remain.'
        : 'You are signed out of the platform. The products below do not support single logout; their sessions end at the stated maximum.',
  };
}

export const LOGOUT_BY_ROLE: Record<PlatformRole, LogoutResponse> = Object.fromEntries(
  (Object.keys(ENTITLED) as PlatformRole[]).map((role) => [role, logoutFor(role, INSTANCES)]),
) as Record<PlatformRole, LogoutResponse>;
