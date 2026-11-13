import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  CatalogEntrySchema,
  CatalogReloadResultSchema,
  EnvImportResultSchema,
  EnvPlanSchema,
  EnvProfileSchema,
  EnvSchemaVarSchema,
  JobAcceptedSchema,
  ScaffoldConfirmationSchema,
  ScaffoldDraftSchema,
  type CredentialGranularity,
} from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

const CatalogListSchema = z.array(CatalogEntrySchema);
const EnvSchemaListSchema = z.array(EnvSchemaVarSchema);
const EnvProfileListSchema = z.array(EnvProfileSchema);

export type CatalogFilters = {
  q?: string;
  cluster?: string;
  packaging?: string;
};

export function useCatalog(filters: CatalogFilters = {}) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.cluster) params.set('cluster', filters.cluster);
  if (filters.packaging) params.set('packaging', filters.packaging);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';

  return useQuery({
    queryKey: [...queryKeys.catalog, filters] as const,
    queryFn: ({ signal }) => request(`/catalog${suffix}`, { schema: CatalogListSchema, signal }),
    // Search and packaging filters each produce a new key; the previous page stays on screen
    // while the next one loads instead of collapsing to a skeleton per keystroke.
    placeholderData: keepPreviousData,
  });
}

/** Resolved environment preview: default → profile → instance → secret, ceilings enforced. */
export function useEnvPlan(
  key: string,
  profileKey: string,
  overrides: Record<string, string>,
  enabled = true,
) {
  const params = new URLSearchParams({ profile: profileKey });
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== '') params.set(`env.${name}`, value);
  }
  return useQuery({
    queryKey: queryKeys.envPlan(key, profileKey, overrides),
    queryFn: ({ signal }) =>
      request(`/catalog/${key}/env-plan?${params.toString()}`, { schema: EnvPlanSchema, signal }),
    enabled: enabled && key.length > 0,
  });
}

export function useCatalogEntry(key: string) {
  return useQuery({
    queryKey: queryKeys.catalogEntry(key),
    queryFn: ({ signal }) => request(`/catalog/${key}`, { schema: CatalogEntrySchema, signal }),
    enabled: key.length > 0,
  });
}

export function useEnvSchema(key: string) {
  return useQuery({
    queryKey: queryKeys.envSchema(key),
    queryFn: ({ signal }) =>
      request(`/catalog/${key}/env-schema`, { schema: EnvSchemaListSchema, signal }),
    enabled: key.length > 0,
  });
}

export function useEnvProfiles() {
  return useQuery({
    queryKey: queryKeys.envProfiles,
    queryFn: ({ signal }) => request('/env-profiles', { schema: EnvProfileListSchema, signal }),
  });
}

export function useScaffoldDraft(key: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.scaffold(key),
    queryFn: ({ signal }) =>
      request(`/catalog/${key}/scaffold`, { schema: ScaffoldDraftSchema, signal }),
    enabled: enabled && key.length > 0,
    retry: false,
  });
}

export function useVerifyIntegrationMetadata(key: string) {
  const client = useQueryClient();
  return useMutation({
    // FR-2.14: the granularity is an enum, not free text — the request schema rejects anything else
    // with a 422 rather than persisting a value the catalog cannot project.
    mutationFn: (body: {
      credentialGranularity?: CredentialGranularity;
      sessionMaxMinutes?: number;
    }) =>
      request(`/catalog/${key}/integration-metadata`, {
        schema: CatalogEntrySchema,
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.catalogEntry(key) });
      void client.invalidateQueries({ queryKey: queryKeys.catalog });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
      void client.invalidateQueries({ queryKey: queryKeys.registry });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/** FR-1.18 / DD-07: re-read the declarative source and report the reconciliation delta. */
export function useReloadCatalog() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request('/catalog/reload', { schema: CatalogReloadResultSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.catalog });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
      void client.invalidateQueries({ queryKey: queryKeys.registry });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/** FR-1.30: map a pasted `.env` or Compose environment into the declared schema. */
export function useEnvImport(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { source: 'dotenv' | 'compose'; content: string }) =>
      request(`/catalog/${key}/env-import`, {
        schema: EnvImportResultSchema,
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/**
 * CL-18: warm the image cache before a deployment window. NFR-2.4 measures apply, not download,
 * so the pull is a job an operator can start early rather than part of the deploy.
 */
export function usePrefetchEntry(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request(`/catalog/${key}/prefetch`, { schema: JobAcceptedSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

/**
 * FR-1.22: a generated draft stays a draft until the operator confirms it. Without this
 * mutation the scaffold tab was review-only and the requirement could not be demonstrated.
 */
export function useConfirmScaffold(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) =>
      request(`/catalog/${key}/scaffold/${draftId}/confirm`, {
        schema: ScaffoldConfirmationSchema,
        method: 'POST',
      }),
    onSuccess: (confirmed) => {
      // The confirmed draft carries the approver, so write it straight into the cache:
      // refetching would return the pre-confirmation fixture.
      client.setQueryData(queryKeys.scaffold(key), confirmed);
      void client.invalidateQueries({ queryKey: queryKeys.catalogEntry(key) });
      void client.invalidateQueries({ queryKey: queryKeys.catalog });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}
