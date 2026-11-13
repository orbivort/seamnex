import { useMutation, useQueryClient } from '@tanstack/react-query';
import { JobAcceptedSchema } from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

/**
 * The recovery writes are job hand-offs (202 `{ jobId }`), not completed work: the backend
 * captures, verifies and restores on the job queue. The hooks therefore invalidate the read
 * surfaces and let the caller follow the job (`useJob`, `useJobStream`) instead of pretending a
 * backup set already exists.
 */

export function useCreateBackup(instanceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request(`/instances/${instanceId}/backups`, { schema: JobAcceptedSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.instanceBackups(instanceId) });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useVerifyBackup(instanceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) =>
      request(`/backups/${backupId}/verify`, { schema: JobAcceptedSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.instanceBackups(instanceId) });
      void client.invalidateQueries({ queryKey: queryKeys.instance(instanceId) });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useRestoreBackup(instanceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) =>
      request(`/backups/${backupId}/restore`, { schema: JobAcceptedSchema, method: 'POST' }),
    onSuccess: () => {
      // A restore rewrites the instance's data, its backup posture and the audit chain. The
      // instance reads are refreshed again by the job screen once the job reaches a terminal state.
      void client.invalidateQueries({ queryKey: queryKeys.instance(instanceId) });
      void client.invalidateQueries({ queryKey: queryKeys.instanceBackups(instanceId) });
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
      void client.invalidateQueries({ queryKey: queryKeys.recovery });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}
