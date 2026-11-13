import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import {
  AuditExportSchema,
  AuditPageSchema,
  AuditProofSchema,
  AuditRangeVerificationSchema,
  BreakGlassRevealSchema,
  BreakGlassSessionSchema,
  CapacitySnapshotSchema,
  ForecastPointSchema,
  LicenseGateSchema,
  LicenseRecordSchema,
  OperationsResponseSchema,
  PatchRecordSchema,
  PostureSummarySchema,
  RegistryEntrySchema,
} from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

const BreakGlassListSchema = z.array(BreakGlassSessionSchema);

const AUDIT_PAGE_SIZE = 25;

export type AuditFilters = { action?: string; actor?: string; outcome?: string; target?: string };

function auditQueryString(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.action) params.set('action', filters.action);
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.target) params.set('target', filters.target);
  return params;
}

/** Cursor-paged audit trail. The chain is append-only, so paging must never be re-ordered. */
export function useAuditPages(filters: AuditFilters = {}) {
  const params = auditQueryString(filters);
  params.set('limit', String(AUDIT_PAGE_SIZE));

  return useInfiniteQuery({
    queryKey: [...queryKeys.audit, 'pages', filters] as const,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams(params);
      if (pageParam !== null) query.set('cursor', pageParam);
      return request(`/audit-events?${query.toString()}`, { schema: AuditPageSchema, signal });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // Filtering by actor is typed; the previous page stays readable while the next one loads.
    placeholderData: keepPreviousData,
  });
}

export function useAuditProof(seq: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.auditProof(seq),
    queryFn: ({ signal }) =>
      request(`/audit-events/${seq}/proof`, { schema: AuditProofSchema, signal }),
    enabled: enabled && seq > 0,
  });
}

export function useExportAudit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      request('/audit-events/export', { schema: AuditExportSchema, method: 'POST', body }),
    onSuccess: () => {
      // The export itself appends an audit record, so the chain on screen is now stale.
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useLicenses() {
  return useQuery({
    queryKey: queryKeys.licenses,
    queryFn: ({ signal }) => request('/licenses', { schema: z.array(LicenseRecordSchema), signal }),
  });
}

export function useSetHostedService(instanceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      request(`/licenses/${instanceId}/hosted-service`, {
        schema: LicenseGateSchema,
        method: 'PUT',
        body: { enabled },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.licenses });
      void client.invalidateQueries({ queryKey: queryKeys.instances });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function usePatchRegister() {
  return useQuery({
    queryKey: queryKeys.patches,
    queryFn: ({ signal }) =>
      request('/patch-register', { schema: z.array(PatchRecordSchema), signal }),
  });
}

export function usePosture() {
  return useQuery({
    queryKey: queryKeys.posture,
    queryFn: ({ signal }) => request('/posture', { schema: PostureSummarySchema, signal }),
  });
}

/**
 * The elevation register.
 *
 * `enabled` lets a screen that already knows the actor holds no break-glass capability skip the
 * request instead of rendering a 403 as an error. `refetchIntervalMs` exists because a time box is
 * the point of the feature: without polling, a grant that runs out keeps rendering as live until
 * someone reloads the page.
 */
export function useBreakGlassSessions(
  options: { enabled?: boolean; refetchIntervalMs?: number } = {},
) {
  return useQuery({
    queryKey: queryKeys.breakGlass,
    queryFn: ({ signal }) =>
      request('/break-glass-sessions', { schema: BreakGlassListSchema, signal }),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchIntervalMs ?? false,
  });
}

export function useCreateBreakGlass() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      instanceId: string;
      accessMode: 'read_only' | 'read_write';
      justification: string;
    }) =>
      request('/break-glass-sessions', { schema: BreakGlassSessionSchema, method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.breakGlass });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useBreakGlassAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'approve' | 'reject' | 'revoke' }) =>
      request(`/break-glass-sessions/${input.id}/${input.action}`, {
        schema: BreakGlassSessionSchema,
        method: 'POST',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.breakGlass });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useCapacity(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.capacity,
    queryFn: ({ signal }) => request('/capacity', { schema: CapacitySnapshotSchema, signal }),
    // A screen that only needs the ledger on its resources step should not read it on the first
    // one: the snapshot moves, and an early read would be stale by the time it is used.
    enabled: options.enabled ?? true,
  });
}

export function useCapacityForecast() {
  return useQuery({
    queryKey: [...queryKeys.capacity, 'forecast'] as const,
    queryFn: ({ signal }) =>
      request('/capacity/forecast', { schema: z.array(ForecastPointSchema), signal }),
  });
}

export function useRegistry() {
  return useQuery({
    queryKey: queryKeys.registry,
    queryFn: ({ signal }) =>
      request('/registry/instances', { schema: z.array(RegistryEntrySchema), signal }),
  });
}

export function useStaleRegistry() {
  return useQuery({
    queryKey: queryKeys.registryStale,
    queryFn: ({ signal }) =>
      request('/registry/stale', { schema: z.array(RegistryEntrySchema), signal }),
  });
}

/**
 * CL-07: the canvas needs the operations a target exposes. Server-side because a browser that
 * filters a stale list is exactly how an author ends up typing a URL (FR-5.2).
 */
export function useRegistryOperations(target: string) {
  return useQuery({
    queryKey: [...queryKeys.registry, 'operations', target] as const,
    queryFn: ({ signal }) =>
      request(`/registry/operations?target=${encodeURIComponent(target)}`, {
        schema: OperationsResponseSchema,
        signal,
      }),
    enabled: target.length > 0,
  });
}

/** CL-11: prove a range of the chain, not only the newest row. */
export function useVerifyAuditRange() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { fromSeq: number; toSeq: number }) =>
      request('/audit-events/verify', {
        schema: AuditRangeVerificationSchema,
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/**
 * CL-12: the elevation credential is revealed once, for seconds. The mutation is deliberately not
 * cached anywhere: a value that stays in a query cache is a value that leaks from a shared screen.
 */
export function useRevealBreakGlass() {
  return useMutation({
    mutationFn: (id: string) =>
      request(`/break-glass-sessions/${id}/reveal`, {
        schema: BreakGlassRevealSchema,
        method: 'POST',
      }),
  });
}
