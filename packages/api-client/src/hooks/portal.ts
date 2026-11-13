import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  AccessRequestSchema,
  EntitlementResponseSchema,
  LauncherResponseSchema,
  LauncherTileSchema,
  LaunchEventSchema,
  LaunchTargetSchema,
  LaunchTicketSchema,
  MeSchema,
  RequestableProductSchema,
  StatusBannerSchema,
} from '@seamnex/domain';
import { endSession } from '../auth';
import { request } from '../http';
import { queryKeys } from '../query-keys';
import { clearAssertedRole } from '../session-role';

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => request('/me', { schema: MeSchema, signal }),
    // The session's MFA state and expiry are shown in the chrome; a tab that has been idle for
    // an hour must not keep claiming the session it had when it was last focused.
    refetchOnWindowFocus: true,
  });
}

export function useEntitlements(enabled = true) {
  return useQuery({
    queryKey: queryKeys.entitlements,
    queryFn: ({ signal }) =>
      request('/me/entitlements', { schema: EntitlementResponseSchema, signal }),
    enabled,
  });
}

export function useLauncher() {
  return useQuery({
    queryKey: queryKeys.launcher,
    queryFn: ({ signal }) => request('/me/launcher', { schema: LauncherResponseSchema, signal }),
  });
}

export function useStatusBanner() {
  return useQuery({
    queryKey: queryKeys.statusBanner,
    queryFn: ({ signal }) =>
      request('/portal/status-banner', { schema: StatusBannerSchema.nullable(), signal }),
  });
}

export function useLaunchTarget(instanceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.launchTarget(instanceId),
    queryFn: ({ signal }) =>
      request(`/portal/launch-targets/${instanceId}`, { schema: LaunchTargetSchema, signal }),
    enabled: enabled && instanceId.length > 0,
  });
}

/**
 * Mints the one-time ticket for a forward-auth product. The URL it returns plants the platform
 * session on the product's own host, which a cross-origin redirect cannot do.
 */
export function useLaunchTicket() {
  return useMutation({
    mutationFn: (instanceId: string) =>
      request(`/portal/launch-tickets/${instanceId}`, {
        method: 'POST',
        schema: LaunchTicketSchema,
      }),
  });
}

/**
 * Records that a person opened a product.
 *
 * Fire-and-forget by design: the tab opens on the click, and a launch must not be blocked because
 * the audit row could not be written. The row is what an operator has when a user reports "the
 * product asked me to sign in and then showed an error" — the sign-in itself happens outside the
 * platform, so the launch is the last link the platform can account for.
 */
export function useRecordLaunch() {
  return useMutation({
    mutationFn: (instanceId: string) =>
      request(`/portal/launch-events/${instanceId}`, { method: 'POST', schema: LaunchEventSchema }),
  });
}

/** A deep link resolves one entitled tile; anything else is a 403, not an empty page. */
export function useProductTile(slug: string) {
  return useQuery({
    queryKey: [...queryKeys.launcher, 'product', slug] as const,
    queryFn: ({ signal }) =>
      request(`/portal/products/${slug}`, { schema: LauncherTileSchema, signal }),
    enabled: slug.length > 0,
  });
}

/** FR-3.13: products the caller may request, with any request already open. */
export function useRequestableProducts(enabled = true) {
  return useQuery({
    queryKey: queryKeys.requestable,
    queryFn: ({ signal }) =>
      request('/portal/requestable', { schema: z.array(RequestableProductSchema), signal }),
    enabled,
  });
}

/** FR-3.13 / FR-4.3: the request is routed to the owning administrator and audited. */
export function useRequestAccess() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { entryKey: string; justification: string }) =>
      request('/admin/access-requests', { schema: AccessRequestSchema, method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.requestable });
      void client.invalidateQueries({ queryKey: queryKeys.accessRequests });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => endSession(),
    onSuccess: () => {
      // Nothing from the terminated session may survive in the cache or in the tab (FR-3.8).
      client.clear();
      clearAssertedRole();
    },
  });
}
