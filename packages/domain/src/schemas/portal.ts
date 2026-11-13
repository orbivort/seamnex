import { z } from 'zod';
import {
  GUARANTEE_CLASSES,
  PLAIN_STATUSES,
  PLATFORM_ROLES,
  SEVERITIES,
  SSO_STATES,
} from '../enums';
import { EntryKeySchema, IdSchema, NamedRefSchema, SlugSchema, TimestampSchema } from './common';

export const RoleGrantSchema = z.object({
  role: z.enum(PLATFORM_ROLES),
  scopeType: z.enum(['platform', 'domain', 'instance']),
  scopeId: z.string().nullable(),
  scopeLabel: z.string().min(1),
  source: z.string().min(1),
  expiresAt: TimestampSchema.nullable(),
});

export const MeSchema = z.object({
  id: IdSchema,
  username: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().min(3),
  initials: z.string().min(1).max(4),
  primaryRole: z.enum(PLATFORM_ROLES),
  roles: z.array(RoleGrantSchema),
  mfaSatisfied: z.boolean(),
  mfaMethod: z.string().min(1),
  sessionExpiresAt: TimestampSchema,
  identitySyncedAt: TimestampSchema,
  groups: z.array(z.string()),
});

/**
 * What the platform has actually proven about a product's sign-in path, and when.
 *
 * The label used to be derived from the existence of an identity client, which is a registration
 * and not a login: EspoCRM answered `token request error` for two days while the tile said "Native
 * SSO". A card may only claim single sign-on while `ok` is true and `checkedAt` is inside the
 * freshness window; everything else is reported as unverified, with the reason attached so the
 * launch dialog can say what is wrong instead of opening a product that cannot sign anyone in.
 */
export const SsoHealthSchema = z.object({
  /** False when no end-to-end check has ever run for this instance. */
  checked: z.boolean(),
  ok: z.boolean(),
  checkedAt: TimestampSchema.nullable(),
  /** One sentence from the check itself; empty when nothing has run. */
  detail: z.string(),
  /**
   * Why the state is what it is, decided where the freshness window is known. A screen cannot
   * explain "unverified" from a timestamp alone: "it passed two days ago" and "it failed an hour
   * ago" are the same boolean and need different sentences.
   */
  reason: z.enum(['ok', 'failed', 'stale', 'never_checked']).default('never_checked'),
});

export type SsoHealth = z.infer<typeof SsoHealthSchema>;

/** The answer for a tile served before any check has run, and for an API that does not send one. */
const NEVER_CHECKED: SsoHealth = {
  checked: false,
  ok: false,
  checkedAt: null,
  detail: '',
  reason: 'never_checked',
};

export const LauncherTileSchema = z.object({
  instanceId: IdSchema,
  entryKey: EntryKeySchema,
  domain: z.string().min(1),
  product: z.string().min(1),
  description: z.string().min(1),
  slug: SlugSchema,
  url: z.string().min(1),
  /**
   * The version this deployment actually runs, and the version the catalog has pinned as current.
   * Both are nullable because a stopped instance keeps no service rows and an entry with no
   * `upstream.currentVersion` cannot be described. `null` means "not known", never "up to date".
   * Optional on input so a tile served by an API older than this field still parses.
   */
  version: z.string().min(1).nullable().default(null),
  /**
   * The catalog's version, and only when it is *strictly newer* than `version` (see
   * `updateAvailable`): a differing prefix, build metadata, a pre-release of the running release or
   * an older pin all mean `null`. The badge claims "an update is available", so "different" is not
   * the same answer as "newer".
   */
  availableVersion: z.string().min(1).nullable().default(null),
  plainStatus: z.enum(PLAIN_STATUSES),
  guaranteeClass: z.enum(GUARANTEE_CLASSES),
  /** `null` when the API cannot prove either way; the label then follows the guarantee class. */
  ssoState: z.enum(SSO_STATES).nullable().default(null),
  /** Evidence behind `ssoState`. Absent on a tile served by an API older than this field. */
  ssoHealth: SsoHealthSchema.default(NEVER_CHECKED),
  authLabel: z.string().min(1),
  productRole: z.string().min(1),
  launchable: z.boolean(),
  degradedReason: z.string().nullable(),
  maintenanceTitle: z.string().nullable(),
  lastVerifiedAt: TimestampSchema,
  badge: z.string().nullable(),
});

export const LauncherResponseSchema = z.object({
  environment: z.string().min(1),
  generatedAt: TimestampSchema,
  tiles: z.array(LauncherTileSchema),
  counts: z.object({
    total: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    maintenance: z.number().int().nonnegative(),
  }),
});

export const EntitlementSchema = z.object({
  instanceId: IdSchema,
  entryKey: EntryKeySchema,
  domain: z.string().min(1),
  product: z.string().min(1),
  slug: SlugSchema,
  productRole: z.string().min(1),
  source: z.enum(['group', 'direct']),
  groupPath: z.string().min(1),
  syncState: z.enum(['applied', 'pending', 'edge_only', 'unsupported']),
  syncedAt: TimestampSchema,
  launchable: z.boolean(),
  authLabel: z.string().min(1),
});

export const EntitlementResponseSchema = z.object({
  subject: NamedRefSchema,
  generatedAt: TimestampSchema,
  entitlements: z.array(EntitlementSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    domains: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    signInRequired: z.number().int().nonnegative(),
  }),
});

export const StatusBannerSchema = z.object({
  id: IdSchema,
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  message: z.string().min(1),
  active: z.boolean(),
  updatedAt: TimestampSchema,
  windowId: IdSchema.nullable(),
});

export const LaunchTargetSchema = z.object({
  instanceId: IdSchema,
  url: z.string().min(1),
  authClass: z.enum(GUARANTEE_CLASSES),
  ssoState: z.enum(SSO_STATES),
  note: z.string().min(1),
  opensInNewTab: z.boolean(),
  /**
   * True when the route sits behind the edge's forward-auth, which reads the platform session from
   * a cookie on the product's own host. The browser cannot carry that cookie across hostnames
   * (`*.localhost` in development, any per-product domain in production), so the portal has to
   * redeem a one-time launch ticket to plant it. `false` means the plain URL is enough.
   */
  bootstrapRequired: z.boolean().default(false),
  /** Evidence behind `ssoState`, so the dialog can warn before it opens a broken sign-in. */
  ssoHealth: SsoHealthSchema.default(NEVER_CHECKED),
  /**
   * ADR-BE-22 — whether the relay has a product account to sign this person in as.
   *
   * `preparing` is the state the portal could not express before, and its absence is what made a
   * fresh install read as "auto sign-in is broken": the platform was about to relay, the mapping was
   * still being created, and every surface said the same thing it says for a product whose
   * credential is deliberately outside the platform. A default of `unavailable` keeps the field
   * additive for a client that predates it, and says nothing it cannot back up.
   */
  relayState: z.enum(['ready', 'preparing', 'unavailable']).default('unavailable'),
});

/**
 * The record that a person opened a product.
 *
 * The portal's only observable moment is the click: after the tab opens, the sign-in happens
 * between the browser, the identity provider and the product, and none of them tells the platform
 * whether it worked. Without this row the audit trail answered "when was this launched, and by
 * whom" with silence, and an operator investigating a failed login had only the product's own log.
 */
export const LaunchEventSchema = z.object({
  instanceId: IdSchema,
  recordedAt: TimestampSchema,
  /** The sign-in shape in force at the moment of the launch — what the user was promised. */
  ssoState: z.enum(SSO_STATES),
});

export type LaunchEvent = z.infer<typeof LaunchEventSchema>;

/**
 * A one-time launch ticket: the URL the portal opens so the edge can plant the session cookie on
 * the product's host, and when the ticket stops being accepted.
 */
export const LaunchTicketSchema = z.object({
  url: z.string().min(1),
  expiresAt: TimestampSchema,
});

export const ResidualSessionSchema = z.object({
  instanceId: IdSchema,
  product: z.string().min(1),
  /**
   * Design §11.2 / NB-4: derived from verified `integration_metadata` only. `null` means the
   * value was never verified, and the screen must say "not verified" rather than invent a time.
   */
  maxRemainingMinutes: z.number().int().nonnegative().nullable(),
  singleLogout: z.boolean(),
  /**
   * When the integration metadata behind the number was verified, and by whom it was not. The screen
   * prints this next to the estimate, because "up to 8 h remaining" over a product whose sign-in
   * cannot complete was a statement about a session that does not exist.
   */
  verifiedAt: TimestampSchema.nullable().default(null),
});

export const LogoutResponseSchema = z.object({
  signedOutAt: TimestampSchema,
  residualSessions: z.array(ResidualSessionSchema),
  statement: z.string().min(1),
});

/**
 * FR-3.13: a product the caller does not hold yet, offered for an access request.
 * Only products the caller could legitimately reach are listed; unentitled products
 * stay absent from the launcher (FR-3.5), which is why this is a separate surface.
 */
export const RequestableProductSchema = z.object({
  entryKey: EntryKeySchema,
  domain: z.string().min(1),
  product: z.string().min(1),
  description: z.string().min(1),
  guaranteeClass: z.enum(GUARANTEE_CLASSES),
  productRole: z.string().min(1),
  owner: z.string().min(1),
  requested: z.boolean(),
  requestedAt: TimestampSchema.nullable(),
});

export const AccessRequestCreateSchema = z.object({
  entryKey: EntryKeySchema,
  justification: z.string().min(10),
});

export type Me = z.infer<typeof MeSchema>;
export type RequestableProduct = z.infer<typeof RequestableProductSchema>;
export type RoleGrant = z.infer<typeof RoleGrantSchema>;
export type LauncherTile = z.infer<typeof LauncherTileSchema>;
export type LauncherResponse = z.infer<typeof LauncherResponseSchema>;
export type Entitlement = z.infer<typeof EntitlementSchema>;
export type EntitlementResponse = z.infer<typeof EntitlementResponseSchema>;
export type StatusBanner = z.infer<typeof StatusBannerSchema>;
export type LaunchTarget = z.infer<typeof LaunchTargetSchema>;
export type LaunchTicket = z.infer<typeof LaunchTicketSchema>;
export type ResidualSession = z.infer<typeof ResidualSessionSchema>;
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;
