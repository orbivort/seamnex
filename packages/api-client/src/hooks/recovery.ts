import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  JobAcceptedSchema,
  PlatformRestoreStatusSchema,
  RecoveryOverviewSchema,
  RestoreDrillSchema,
} from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

/**
 * M16 — platform recovery.
 *
 * Backups and restores are asynchronous: the write answers `202 { jobId }` and the timeline is read
 * back from `/platform/restore-status` (CL-20) rather than from the whole overview. A drill is
 * synchronous: it returns its evidence row.
 */

export function useRecovery() {
  return useQuery({
    queryKey: queryKeys.recovery,
    queryFn: ({ signal }) => request('/recovery', { schema: RecoveryOverviewSchema, signal }),
    /**
     * The register follows a restore while one is running, and stops when it terminates. This
     * used to be a `setInterval` in the screen that called `refetch` every 30 s — the same policy
     * expressed twice, in two places, only one of which knew when to stop.
     */
    refetchInterval: (query) => (query.state.data?.runs[0]?.state === 'running' ? 10_000 : false),
  });
}

/**
 * The light polling surface the restore gate needs. Polling only runs while a restore is in
 * flight, so an idle console does not request the overview or the gate at all.
 */
export function useRestoreStatus(options: { enabled?: boolean; pollMs?: number } = {}) {
  const { enabled = true, pollMs = 2_000 } = options;
  return useQuery({
    queryKey: queryKeys.restoreStatus,
    queryFn: ({ signal }) =>
      request('/platform/restore-status', { schema: PlatformRestoreStatusSchema, signal }),
    enabled,
    refetchInterval: enabled ? pollMs : false,
    // The answer is a moment-in-time gate state; a cached copy would misreport an open gate.
    staleTime: 0,
    gcTime: 0,
  });
}

export function useCreatePlatformBackup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request('/recovery/backups', { schema: JobAcceptedSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.recovery });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useStartPlatformRestore() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { backupId: string; justification: string }) =>
      request('/recovery/restores', { schema: JobAcceptedSchema, method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.recovery });
      void client.invalidateQueries({ queryKey: queryKeys.restoreStatus });
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useScheduleDrill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { instanceId: string }) =>
      request('/restore-drills', { schema: RestoreDrillSchema, method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.recovery });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}
