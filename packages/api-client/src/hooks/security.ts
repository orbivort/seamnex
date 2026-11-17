import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageScanReportSchema, TrustedRegistryStateSchema } from '@seamnex/domain';
import type { TrustedRegistryUpdate } from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

/**
 * NFR-4.16 — the allow-list the platform's pull and build paths enforce.
 *
 * Read by the security posture screen and written by an R1 through the audited revision route. The
 * mutation returns the new state, so the dialog closes on the platform's answer (the version and
 * content hash) rather than on an optimistic guess that the revision was accepted.
 */
export function useTrustedRegistries(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.trustedRegistries,
    queryFn: ({ signal }) =>
      request('/security/trusted-registries', { schema: TrustedRegistryStateSchema, signal }),
    enabled: options.enabled ?? true,
  });
}

export function useUpdateTrustedRegistries() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: TrustedRegistryUpdate) =>
      request('/security/trusted-registries', {
        schema: TrustedRegistryStateSchema,
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.trustedRegistries });
      // The change is audited, so the trail on screen is now behind the platform.
      void client.invalidateQueries({ queryKey: queryKeys.audit });
      // A namespace removed here can make a live product's image untrusted; the catalogue and
      // posture screens are the two places that say so.
      void client.invalidateQueries({ queryKey: queryKeys.catalog });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
    },
  });
}

/**
 * NFR-4.6 / S-10 — the retained findings for one digest.
 *
 * Only fetched when the operator opens the report: the instance tab already carries the verdict and
 * the severity counts from `GET /instances/:id/images`, and a screen that fetched every finding for
 * every image would move a few thousand rows to render four numbers.
 */
export function useImageScanReport(instanceId: string, digest: string | null) {
  return useQuery({
    queryKey: queryKeys.imageScan(instanceId, digest ?? ''),
    queryFn: ({ signal }) =>
      request(`/instances/${instanceId}/image-scan?digest=${encodeURIComponent(digest ?? '')}`, {
        schema: ImageScanReportSchema,
        signal,
      }),
    enabled: digest !== null && digest.length > 0,
  });
}
