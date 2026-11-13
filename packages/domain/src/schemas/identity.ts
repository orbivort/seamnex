import { z } from 'zod';
import { PLATFORM_ROLES } from '../enums';
import { IdSchema, TimestampSchema } from './common';

export const IdpUserSchema = z.object({
  id: IdSchema,
  username: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().min(3),
  initials: z.string().min(1).max(4),
  enabled: z.boolean(),
  groups: z.array(z.string()),
  roles: z.array(z.object({ role: z.enum(PLATFORM_ROLES), scopeLabel: z.string() })),
  entitlementCount: z.number().int().nonnegative(),
  lastLoginAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  mfaEnrolled: z.boolean(),
  jobTitle: z.string().min(1),
});

export const GroupMappingSchema = z.object({
  role: z.enum(PLATFORM_ROLES),
  scopeType: z.enum(['platform', 'domain', 'instance']),
  scopeId: z.string().nullable(),
  scopeLabel: z.string().min(1),
  propagateToProduct: z.boolean(),
});

export const IdpGroupSchema = z.object({
  id: IdSchema,
  path: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  memberCount: z.number().int().nonnegative(),
  mapping: GroupMappingSchema.nullable(),
  updatedAt: TimestampSchema,
});

export const SyncRunSchema = z.object({
  id: IdSchema,
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  users: z.number().int().nonnegative(),
  groups: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  p95LatencyMs: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  state: z.enum(['succeeded', 'partial', 'failed']),
});

export const AlertChannelSchema = z.object({
  id: IdSchema,
  type: z.enum(['email', 'webhook']),
  target: z.string().min(1),
  enabled: z.boolean(),
  severities: z.array(z.enum(['info', 'warning', 'critical'])),
  lastDeliveryAt: TimestampSchema.nullable(),
});

/** CL-06: "add a channel" had no test action; a saved channel that cannot deliver is a silent gap. */
export const AlertTestResultSchema = z.object({
  channelId: IdSchema,
  ok: z.boolean(),
  detail: z.string().min(1),
  deliveredAt: TimestampSchema,
});

/** Read model behind `/admin/users/:id/entitlements` (FR-4.4 evidence before disable). */
export const UserEntitlementsSchema = z.object({
  userId: IdSchema,
  entitlements: z.array(
    z.object({
      instanceId: IdSchema,
      product: z.string().min(1),
      entryKey: z.string().min(1),
      productRole: z.string().min(1),
      syncState: z.string().min(1),
    }),
  ),
});

/** Offboarding outcome (AC-12): sessions terminated, entitlements revoked, audit written. */
export const DisableUserResponseSchema = z.object({
  userId: IdSchema,
  disabledAt: TimestampSchema,
  sessionsTerminated: z.number().int().nonnegative(),
  entitlements: z.array(
    z.object({ instanceId: IdSchema, product: z.string().min(1), syncState: z.string().min(1) }),
  ),
  propagationNote: z.string().min(1),
});

export const PlatformSettingsSchema = z.object({
  breakGlassMaxMinutes: z.number().int().min(5).max(240),
  restoreConcurrency: z.number().int().min(4).max(12),
  oversubscriptionFactor: z.number().min(1).max(2),
  sessionIdleMinutes: z.number().int().positive(),
  sessionAbsoluteHours: z.number().int().positive(),
  metadataReviewDays: z.number().int().positive(),
  auditRetentionDays: z.number().int().positive(),
  updatedAt: TimestampSchema,
  updatedBy: z.string().min(1),
});

export type IdpUser = z.infer<typeof IdpUserSchema>;
export type IdpGroup = z.infer<typeof IdpGroupSchema>;
export type GroupMapping = z.infer<typeof GroupMappingSchema>;
export type SyncRun = z.infer<typeof SyncRunSchema>;
export type AlertChannel = z.infer<typeof AlertChannelSchema>;
export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;
