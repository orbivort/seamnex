import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  AdminCredentialSchema,
  BackupPostureSchema,
  BackupSchema,
  ContainerLogListSchema,
  ContainerStatusSchema,
  DeployPreviewSchema,
  DriftRecordSchema,
  EnvUpdateResponseSchema,
  EnvValueSchema,
  ImageSchema,
  InstanceDetailSchema,
  RelayProvisionReportSchema,
  InstanceListSchema,
  InstancePlanSchema,
  InstanceStatusSchema,
  JobAcceptedSchema,
} from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

const ContainerListSchema = z.array(ContainerStatusSchema);
const EnvListSchema = z.array(EnvValueSchema);
const DriftListSchema = z.array(DriftRecordSchema);
const BackupListSchema = z.array(BackupSchema);

export type InstanceFilters = { state?: string; entryKey?: string; q?: string };

export function useInstances(filters: InstanceFilters = {}, options: { enabled?: boolean } = {}) {
  const params = new URLSearchParams();
  if (filters.state) params.set('state', filters.state);
  if (filters.entryKey) params.set('entryKey', filters.entryKey);
  if (filters.q) params.set('q', filters.q);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';

  return useQuery({
    queryKey: [...queryKeys.instances, filters] as const,
    queryFn: ({ signal }) => request(`/instances${suffix}`, { schema: InstanceListSchema, signal }),
    // A screen that only needs the list inside a dialog it may not open should not read it: the
    // platform-wide list is `instance.view_logs` resolved per instance, which a domain owner's
    // scoped grant does not cover, so an unconditional read is a 403 in the console's own log.
    enabled: options.enabled ?? true,
    // A filter change is a new key. Without this the table unmounts on every keystroke, losing
    // its scroll position and the row the operator was reading.
    placeholderData: keepPreviousData,
    // Readiness is what an operator comes back to the tab for; a 15 s-old fleet view is not it.
    refetchOnWindowFocus: true,
  });
}

export function useInstance(id: string) {
  return useQuery({
    queryKey: queryKeys.instance(id),
    queryFn: ({ signal }) => request(`/instances/${id}`, { schema: InstanceDetailSchema, signal }),
    enabled: id.length > 0,
  });
}

export function useInstanceStatus(id: string) {
  return useQuery({
    queryKey: queryKeys.instanceStatus(id),
    queryFn: ({ signal }) =>
      request(`/instances/${id}/status`, { schema: InstanceStatusSchema, signal }),
    enabled: id.length > 0,
    // The derived state shown next to the lifecycle buttons must not survive a tab switch.
    refetchOnWindowFocus: true,
  });
}

export function useRefreshInstanceStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request(`/instances/${id}/status?refresh=true`, { schema: InstanceStatusSchema }),
    onSuccess: (status) => {
      void client.invalidateQueries({ queryKey: queryKeys.instanceStatus(status.instanceId) });
      void client.invalidateQueries({ queryKey: queryKeys.instance(status.instanceId) });
      void client.invalidateQueries({ queryKey: queryKeys.containers(status.instanceId) });
    },
  });
}

export function useContainers(id: string) {
  return useQuery({
    queryKey: queryKeys.containers(id),
    queryFn: ({ signal }) =>
      request(`/instances/${id}/containers`, { schema: ContainerListSchema, signal }),
    enabled: id.length > 0,
  });
}

export function useInstanceEnv(id: string) {
  return useQuery({
    queryKey: queryKeys.instanceEnv(id),
    queryFn: ({ signal }) => request(`/instances/${id}/env`, { schema: EnvListSchema, signal }),
    enabled: id.length > 0,
  });
}

export function useDrift(id: string) {
  return useQuery({
    queryKey: queryKeys.drift(id),
    queryFn: ({ signal }) => request(`/instances/${id}/drift`, { schema: DriftListSchema, signal }),
    enabled: id.length > 0,
  });
}

export function useInstanceBackups(id: string) {
  return useQuery({
    queryKey: queryKeys.instanceBackups(id),
    queryFn: ({ signal }) =>
      request(`/instances/${id}/backups`, { schema: BackupListSchema, signal }),
    enabled: id.length > 0,
  });
}

export function useInstancePlan(id: string, action: string | null) {
  return useQuery({
    queryKey: [...queryKeys.instance(id), 'plan', action] as const,
    queryFn: ({ signal }) =>
      request(`/instances/${id}/plan?action=${action ?? 'upgrade'}`, {
        schema: InstancePlanSchema,
        signal,
      }),
    enabled: id.length > 0 && action !== null,
  });
}

export function useContainerLogs(instanceId: string, containerId: string | null) {
  return useQuery({
    queryKey: [...queryKeys.containers(instanceId), containerId] as const,
    queryFn: ({ signal }) =>
      request(`/instances/${instanceId}/containers/${containerId ?? ''}/logs`, {
        schema: ContainerLogListSchema,
        signal,
      }),
    enabled: instanceId.length > 0 && containerId !== null,
  });
}

export function useImages(id: string) {
  return useQuery({
    queryKey: queryKeys.images(id),
    queryFn: ({ signal }) =>
      request(`/instances/${id}/images`, { schema: z.array(ImageSchema), signal }),
    enabled: id.length > 0,
  });
}

export type DeployInput = {
  entryKey: string;
  slug: string;
  profile?: string;
  resources?: { cpu: number; memoryMb: number; diskMb: number };
  envOverrides?: Record<string, string>;
};

export function useDeploy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: DeployInput) =>
      request('/instances', { schema: JobAcceptedSchema, method: 'POST', body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      // A new deployment moves the admission ledger and the registry inventory.
      void client.invalidateQueries({ queryKey: queryKeys.capacity });
      void client.invalidateQueries({ queryKey: queryKeys.registry });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/**
 * CL-09: the wizard asks the API for the admission verdict instead of computing it. The response
 * is also what the deploy request will be judged by, so the two cannot disagree.
 *
 * This is a *read*, keyed on the values it answers about. Modelled as a mutation it had no cache,
 * no deduplication and no cancellation: two edits in flight could resolve out of order, and a
 * slow answer for a discarded slug could overwrite the current one. As a query the key does that
 * work — a superseded request is aborted, and an answer for a different input can never be served
 * as the current verdict.
 */
export function useDeployPreview(input: DeployInput, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deployPreview(
      input.entryKey,
      input.slug,
      input.profile ?? '',
      input.resources,
    ),
    queryFn: ({ signal }) =>
      request('/instances/preview', {
        schema: DeployPreviewSchema,
        method: 'POST',
        body: input,
        signal,
      }),
    // A preview that has not answered yet is "pending", not "failed", so the screen must be able
    // to tell the two apart: no placeholder data, and the verdict is never served from cache.
    enabled: enabled && input.entryKey.length > 0 && input.slug.length >= 2,
    staleTime: 0,
  });
}

export function useLifecycleAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      action: string;
      dataRetention?: 'keep' | 'export' | 'delete';
    }) =>
      request(`/instances/${input.id}/${input.action}`, {
        schema: JobAcceptedSchema,
        method: 'POST',
        ...(input.dataRetention ? { body: { dataRetention: input.dataRetention } } : {}),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.capacity });
      void client.invalidateQueries({ queryKey: queryKeys.registry });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useUpdateEnvironment(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, string>) =>
      request(`/instances/${id}/env`, {
        schema: EnvUpdateResponseSchema,
        method: 'PUT',
        body: { values },
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: queryKeys.instanceEnv(id) });
      void client.invalidateQueries({ queryKey: queryKeys.instance(id) });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
      // A value that requires a recreate restarts the containers and can move the readiness
      // state, so the container list and derived status are stale by definition.
      if (result.requiresRecreate) {
        void client.invalidateQueries({ queryKey: queryKeys.containers(id) });
        void client.invalidateQueries({ queryKey: queryKeys.instanceStatus(id) });
        void client.invalidateQueries({ queryKey: queryKeys.drift(id) });
      }
    },
  });
}

/**
 * ADR-BE-22: the product administrator token the sign-in relay provisions accounts with.
 *
 * Metadata only. `enabled` exists because the read is `instance.env`; a role without it must not
 * fire the query just because the instance screen mounted.
 */
export function useAdminCredential(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.adminCredential(id),
    queryFn: ({ signal }) =>
      request(`/instances/${id}/admin-credential`, { schema: AdminCredentialSchema, signal }),
    enabled: id.length > 0 && (options.enabled ?? true),
  });
}

/**
 * Stores or replaces the token. The response is metadata, so the caller never has the value back:
 * an operator who lost it must mint a new one in the product.
 */
export function useSetAdminCredential(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      request(`/instances/${id}/admin-credential`, {
        schema: AdminCredentialSchema,
        method: 'PUT',
        body: { token },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.adminCredential(id) });
      // The write is audited (`instance.admin_credential.updated`) and the sweep it unblocks
      // appends its own rows, so an open audit view is stale by definition.
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/**
 * ADR-BE-22: run the relay's provisioning pass now.
 *
 * The deployment event and the sweep provision on their own; this is the operator's "do it now",
 * which is what restarting the scheduler used to be. The answer is counts, so a role without the
 * capability sees a 403 rather than a screen that quietly did nothing.
 */
export function useProvisionRelayAccounts(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request(`/instances/${id}/relay/provision`, {
        schema: RelayProvisionReportSchema,
        method: 'POST',
      }),
    onSuccess: () => {
      // The pass appends `relay.account.*` rows, so an open audit view is stale by definition.
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/** FR-1.12: scheduled backups are configurable per instance. */
export function useUpdateBackupSchedule(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { schedule: string; timezone: string; enabled: boolean }) =>
      request(`/instances/${id}/backup-schedule`, {
        schema: BackupPostureSchema,
        method: 'PUT',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.instance(id) });
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}
