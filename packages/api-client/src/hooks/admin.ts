import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { AlertChannel } from '@seamnex/domain';
import {
  AccessRequestSchema,
  AlertChannelSchema,
  AlertTestResultSchema,
  DisableUserResponseSchema,
  DsarRequestSchema,
  IdpGroupSchema,
  IdpUserSchema,
  MaintenanceWindowSchema,
  PlatformSettingsSchema,
  PolicyExceptionSchema,
  SyncRunSchema,
  UserEntitlementsSchema,
} from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

const UserListSchema = z.array(IdpUserSchema);
const GroupListSchema = z.array(IdpGroupSchema);
const SyncRunListSchema = z.array(SyncRunSchema);
const AccessRequestListSchema = z.array(AccessRequestSchema);

export function useUsers(q = '') {
  const suffix = q ? `?q=${encodeURIComponent(q)}` : '';
  return useQuery({
    queryKey: [...queryKeys.users, q] as const,
    queryFn: ({ signal }) => request(`/admin/users${suffix}`, { schema: UserListSchema, signal }),
    // The directory is searched per keystroke; keeping the previous page avoids a full unmount.
    placeholderData: keepPreviousData,
  });
}

export function useUser(id: string) {
  return useQuery({
    queryKey: queryKeys.user(id),
    queryFn: ({ signal }) => request(`/admin/users/${id}`, { schema: IdpUserSchema, signal }),
    enabled: id.length > 0,
  });
}

export function useUserEntitlements(id: string) {
  return useQuery({
    queryKey: queryKeys.userEntitlements(id),
    queryFn: ({ signal }) =>
      request(`/admin/users/${id}/entitlements`, { schema: UserEntitlementsSchema, signal }),
    enabled: id.length > 0,
  });
}

export function useDisableUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request(`/admin/users/${id}/disable`, { schema: DisableUserResponseSchema, method: 'POST' }),
    onSuccess: (_result, id) => {
      void client.invalidateQueries({ queryKey: queryKeys.users });
      void client.invalidateQueries({ queryKey: queryKeys.user(id) });
      void client.invalidateQueries({ queryKey: queryKeys.userEntitlements(id) });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useGroups() {
  return useQuery({
    queryKey: queryKeys.groups,
    queryFn: ({ signal }) => request('/admin/groups', { schema: GroupListSchema, signal }),
  });
}

export function useUpdateGroupMapping() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      body: { role: string; scopeType: string; scopeLabel: string; propagate: boolean };
    }) =>
      request(`/admin/groups/${input.id}/mapping`, {
        schema: IdpGroupSchema,
        method: 'PUT',
        body: input.body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.groups });
      // A mapping change moves roles, so directory projections and entitlements move too.
      void client.invalidateQueries({ queryKey: queryKeys.users });
      void client.invalidateQueries({ queryKey: queryKeys.entitlements });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useSyncRuns() {
  return useQuery({
    queryKey: queryKeys.identitySync,
    queryFn: ({ signal }) => request('/admin/identity-sync', { schema: SyncRunListSchema, signal }),
  });
}

export function useRunSync() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request('/admin/identity-sync/run', { schema: SyncRunSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.identitySync });
      // One cycle rewrites the directory projection and every derived entitlement.
      void client.invalidateQueries({ queryKey: queryKeys.users });
      void client.invalidateQueries({ queryKey: queryKeys.groups });
      void client.invalidateQueries({ queryKey: queryKeys.entitlements });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
    /*
     * A refused cycle is still a recorded run — the worker writes `sync_run` before it reads the
     * directory and closes it as `failed` when the read throws. Without this the evidence list kept
     * the previous run on screen and the failure existed only in the error panel, so the operator
     * could not see what the platform recorded.
     */
    onError: () => {
      void client.invalidateQueries({ queryKey: queryKeys.identitySync });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => request('/admin/settings', { schema: PlatformSettingsSchema, signal }),
  });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, number>) =>
      request('/admin/settings', { schema: PlatformSettingsSchema, method: 'PUT', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

export function useAlertChannels() {
  return useQuery({
    queryKey: queryKeys.alertChannels,
    queryFn: ({ signal }) =>
      request('/admin/settings/alerts', { schema: z.array(AlertChannelSchema), signal }),
  });
}

export function useUpdateAlertChannels() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AlertChannel[]) =>
      request('/admin/settings/alerts', {
        schema: z.array(AlertChannelSchema),
        method: 'PUT',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.alertChannels });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useAccessRequests() {
  return useQuery({
    queryKey: queryKeys.accessRequests,
    queryFn: ({ signal }) =>
      request('/admin/access-requests', { schema: AccessRequestListSchema, signal }),
  });
}

/** NFR-4.15: a policy exception is decided by a second party, never the requester. */
export function useDecidePolicyException() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject' }) =>
      request(`/admin/policy-exceptions/${input.id}/${input.decision}`, {
        schema: PolicyExceptionSchema,
        method: 'POST',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.policyExceptions });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
      void client.invalidateQueries({ queryKey: queryKeys.instances });
    },
  });
}

export function useDecideAccessRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject' }) =>
      request(`/admin/access-requests/${input.id}/${input.decision}`, {
        schema: AccessRequestSchema,
        method: 'POST',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.accessRequests });
      void client.invalidateQueries({ queryKey: queryKeys.users });
      void client.invalidateQueries({ queryKey: queryKeys.entitlements });
      void client.invalidateQueries({ queryKey: queryKeys.groups });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/**
 * `enabled` lets a screen skip a read it knows will be refused. The list is gated on
 * `settings.view`, which the domain owner (R3) does not hold: without the flag the shared page
 * rendered a 403 problem panel with a Retry button, where the honest answer is a permission note.
 *
 * `refetchIntervalMs` exists for the same reason it does on the elevation register: a window's
 * state is decided by the clock, so a scheduled window has to turn active — and an active one has
 * to end — without a reload. The server computes that state; the screen must not invent its own.
 */
export function useMaintenanceWindows(
  options: { enabled?: boolean; refetchIntervalMs?: number } = {},
) {
  return useQuery({
    queryKey: queryKeys.maintenance,
    queryFn: ({ signal }) =>
      request('/admin/maintenance-windows', { schema: z.array(MaintenanceWindowSchema), signal }),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchIntervalMs ?? false,
  });
}

/** CL-06: prove a channel can deliver before relying on it during an incident. */
export function useTestAlertChannel() {
  return useMutation({
    mutationFn: (id: string) =>
      request(`/admin/settings/alerts/${id}/test`, {
        schema: AlertTestResultSchema,
        method: 'POST',
      }),
  });
}

/** CL-05: a maintenance window suppresses alerts, so scheduling it is a governance write. */
export function useCreateMaintenanceWindow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      scope: string;
      instanceId?: string | null;
      startsAt: string;
      endsAt: string;
    }) =>
      request('/admin/maintenance-windows', {
        schema: MaintenanceWindowSchema,
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.maintenance });
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function usePatchMaintenanceWindow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; startsAt?: string; endsAt?: string }) =>
      request(`/admin/maintenance-windows/${input.id}`, {
        schema: MaintenanceWindowSchema,
        method: 'PATCH',
        body: { startsAt: input.startsAt, endsAt: input.endsAt },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.maintenance });
      // A window is part of an instance's state: moving it changes the maintenance badge too.
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/** Cancelling is a 204: suppression stops as soon as the row is cancelled. */
export function useCancelMaintenanceWindow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request<void>(`/admin/maintenance-windows/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.maintenance });
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function usePolicyExceptions(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.policyExceptions,
    queryFn: ({ signal }) =>
      request('/admin/policy-exceptions', { schema: z.array(PolicyExceptionSchema), signal }),
    enabled: options.enabled ?? true,
  });
}

export function useDsarRequests() {
  return useQuery({
    queryKey: queryKeys.dsar,
    queryFn: ({ signal }) => request('/admin/dsar', { schema: z.array(DsarRequestSchema), signal }),
  });
}
